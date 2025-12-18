require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');
const { encryptData, decryptData } = require('./crypto-utils');
const { hashPassword, verifyPassword, isHashed } = require('./password-utils');
const { initSessionStore, createSession, validateSession, destroySession, isRedisSessionEnabled } = require('./session-store');
const { apiLimiter, loginLimiter, passwordSetLimiter, validatePassword, validateAccounts, validateIndex, validateRename, validateServiceAction, validateLogsQuery, validateWebhook } = require('./middleware');
const { setWebhookConfigs, sendWebhook, testWebhook, EVENTS } = require('./notifications');
const db = require('./db');
const cache = require('./cache');
const { getRedisInfo, closeRedisClient } = require('./redis-client');

const app = express();
const PORT = process.env.PORT || 3000;

// 加密密钥
const ACCOUNTS_SECRET = process.env.ACCOUNTS_SECRET;
const ENCRYPTION_ENABLED = ACCOUNTS_SECRET && ACCOUNTS_SECRET.length === 64;

// 额度预警阈值
const QUOTA_WARNING_THRESHOLD = parseFloat(process.env.QUOTA_WARNING_THRESHOLD) || 1.0;

app.use(cors());
app.use(express.json());
app.use(apiLimiter); // 全局限流

// ==================== 辅助函数 ====================

async function loadServerAccounts() {
  return await db.loadAccounts(ENCRYPTION_ENABLED, decryptData, ACCOUNTS_SECRET);
}

async function saveServerAccounts(accounts) {
  return await db.saveAccounts(accounts, ENCRYPTION_ENABLED, encryptData, ACCOUNTS_SECRET);
}

async function loadAdminPassword() {
  return await db.loadPassword();
}

async function saveAdminPassword(password) {
  const hashed = await hashPassword(password);
  return await db.savePassword(hashed);
}

function getEnvAccounts() {
  const accountsEnv = process.env.ACCOUNTS;
  if (!accountsEnv) return [];
  try {
    return accountsEnv.split(',').map(item => {
      const [name, token] = item.split(':');
      return { name: name.trim(), token: token.trim() };
    }).filter(acc => acc.name && acc.token);
  } catch (e) {
    console.error('❌ 解析环境变量 ACCOUNTS 失败:', e.message);
    return [];
  }
}

// ==================== 认证中间件 ====================

async function requireAuth(req, res, next) {
  const password = req.headers['x-admin-password'];
  const sessionToken = req.headers['x-session-token'];
  const savedPassword = await loadAdminPassword();

  if (!savedPassword) {
    return next();
  }

  // 验证 Session
  if (sessionToken) {
    const session = await validateSession(sessionToken);
    if (session) {
      req.session = session;
      return next();
    }
  }

  // 验证密码
  if (password) {
    const isValid = await verifyPassword(password, savedPassword);
    if (isValid) {
      return next();
    }
  }

  res.status(401).json({ error: '密码错误或Session无效' });
}

// ==================== 静态文件 ====================

app.use(express.static('public'));

// ==================== Zeabur API ====================

async function queryZeabur(token, query) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ query });
    const options = {
      hostname: 'api.zeabur.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(data);
    req.end();
  });
}

async function fetchAccountData(token) {
  const userQuery = `query { me { _id username email credit } }`;
  const projectsQuery = `query {
    projects {
      edges {
        node {
          _id name
          region { name }
          environments { _id }
          services {
            _id name status template
            resourceLimit { cpu memory }
            domains { domain isGenerated }
          }
        }
      }
    }
  }`;
  const aihubQuery = `query GetAIHubTenant { aihubTenant { balance keys { keyID alias cost } } }`;

  const [userData, projectsData, aihubData] = await Promise.all([
    queryZeabur(token, userQuery),
    queryZeabur(token, projectsQuery),
    queryZeabur(token, aihubQuery).catch(() => ({ data: { aihubTenant: null } }))
  ]);

  return {
    user: userData.data?.me || {},
    projects: (projectsData.data?.projects?.edges || []).map(edge => edge.node),
    aihub: aihubData.data?.aihubTenant || null
  };
}

async function fetchUsageData(token, userID, projects = []) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const fromDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const toDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

  const usageQuery = {
    operationName: 'GetHeaderMonthlyUsage',
    variables: { from: fromDate, to: toDate, groupByEntity: 'PROJECT', groupByTime: 'DAY', groupByType: 'ALL', userID },
    query: `query GetHeaderMonthlyUsage($from: String!, $to: String!, $groupByEntity: GroupByEntity, $groupByTime: GroupByTime, $groupByType: GroupByType, $userID: ObjectID!) {
      usages(from: $from, to: $to, groupByEntity: $groupByEntity, groupByTime: $groupByTime, groupByType: $groupByType, userID: $userID) {
        categories data { id name groupByEntity usageOfEntity __typename } __typename
      }
    }`
  };

  return new Promise((resolve, reject) => {
    const data = JSON.stringify(usageQuery);
    const options = {
      hostname: 'api.zeabur.com', path: '/graphql', method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          const usages = result.data?.usages?.data || [];
          const projectCosts = {};
          let totalUsage = 0;

          usages.forEach(project => {
            const projectTotal = project.usageOfEntity.reduce((a, b) => a + b, 0);
            const displayCost = projectTotal > 0 ? Math.ceil(projectTotal * 100) / 100 : 0;
            projectCosts[project.id] = displayCost;
            totalUsage += projectTotal;
          });

          resolve({
            projectCosts, totalUsage,
            freeQuotaRemaining: 5 - totalUsage,
            freeQuotaLimit: 5
          });
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(data);
    req.end();
  });
}

// ==================== 密码 API ====================

app.get('/api/check-encryption', (req, res) => {
  const crypto = require('crypto');
  res.json({
    isConfigured: ENCRYPTION_ENABLED,
    suggestedSecret: crypto.randomBytes(32).toString('hex')
  });
});

app.get('/api/check-password', async (req, res) => {
  const savedPassword = await loadAdminPassword();
  res.json({ hasPassword: !!savedPassword });
});

app.post('/api/set-password', passwordSetLimiter, validatePassword, async (req, res) => {
  const { password } = req.body;
  const savedPassword = await loadAdminPassword();

  if (savedPassword) {
    return res.status(400).json({ error: '密码已设置，无法重复设置' });
  }

  if (await saveAdminPassword(password)) {
    console.log('✅ 管理员密码已设置（已哈希）');
    res.json({ success: true });
  } else {
    res.status(500).json({ error: '保存密码失败' });
  }
});

app.post('/api/verify-password', loginLimiter, validatePassword, async (req, res) => {
  const { password } = req.body;
  const savedPassword = await loadAdminPassword();

  if (!savedPassword) {
    return res.status(400).json({ success: false, error: '请先设置密码' });
  }

  const isValid = await verifyPassword(password, savedPassword);
  if (isValid) {
    // 迁移旧密码到哈希格式
    if (!isHashed(savedPassword)) {
      await saveAdminPassword(password);
      console.log('🔐 密码已升级为哈希存储');
    }

    const sessionToken = await createSession();
    console.log(`✅ 用户登录成功`);
    res.json({ success: true, sessionToken });
  } else {
    const ip = req.ip || req.connection.remoteAddress;
    sendWebhook(EVENTS.LOGIN_FAILED, { ip }).catch(() => {});
    res.status(401).json({ success: false, error: '密码错误' });
  }
});

app.post('/api/logout', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (sessionToken) {
    await destroySession(sessionToken);
  }
  res.json({ success: true });
});

// ==================== 账号 API ====================

app.post('/api/temp-accounts', requireAuth, async (req, res) => {
  const { accounts } = req.body;
  if (!accounts || !Array.isArray(accounts)) {
    return res.status(400).json({ error: '无效的账号列表' });
  }

  const results = await Promise.all(accounts.map(async (account) => {
    try {
      const { user, projects, aihub } = await fetchAccountData(account.token);
      let usageData = { totalUsage: 0, freeQuotaRemaining: 5, freeQuotaLimit: 5 };

      if (user._id) {
        try {
          usageData = await fetchUsageData(account.token, user._id, projects);
          // 记录用量历史
          await db.recordUsage(account.name, usageData.totalUsage);
          // 额度预警
          if (usageData.freeQuotaRemaining < QUOTA_WARNING_THRESHOLD) {
            sendWebhook(EVENTS.QUOTA_WARNING, {
              accountName: account.name,
              remaining: usageData.freeQuotaRemaining,
              threshold: QUOTA_WARNING_THRESHOLD
            }).catch(() => {});
          }
        } catch (e) {
          console.log(`⚠️ [${account.name}] 获取用量失败:`, e.message);
        }
      }

      const creditInCents = Math.round(usageData.freeQuotaRemaining * 100);
      return {
        name: account.name, success: true,
        data: { ...user, credit: creditInCents, totalUsage: usageData.totalUsage, freeQuotaLimit: usageData.freeQuotaLimit },
        aihub
      };
    } catch (error) {
      return { name: account.name, success: false, error: error.message };
    }
  }));

  res.json(results);
});

app.post('/api/temp-projects', requireAuth, async (req, res) => {
  const { accounts } = req.body;
  if (!accounts || !Array.isArray(accounts)) {
    return res.status(400).json({ error: '无效的账号列表' });
  }

  const results = await Promise.all(accounts.map(async (account) => {
    try {
      const { user, projects } = await fetchAccountData(account.token);
      let projectCosts = {};

      if (user._id) {
        try {
          const usageData = await fetchUsageData(account.token, user._id, projects);
          projectCosts = usageData.projectCosts;
        } catch (e) {}
      }

      const projectsWithCost = projects.map(project => ({
        _id: project._id, name: project.name,
        region: project.region?.name || 'Unknown',
        environments: project.environments || [],
        services: project.services || [],
        cost: projectCosts[project._id] || 0,
        hasCostData: (projectCosts[project._id] || 0) > 0
      }));

      return { name: account.name, success: true, projects: projectsWithCost };
    } catch (error) {
      return { name: account.name, success: false, error: error.message };
    }
  }));

  res.json(results);
});

app.post('/api/validate-account', requireAuth, async (req, res) => {
  const { accountName, apiToken } = req.body;
  if (!accountName || !apiToken) {
    return res.status(400).json({ error: '账号名称和 API Token 不能为空' });
  }

  try {
    const { user } = await fetchAccountData(apiToken);
    if (user._id) {
      res.json({ success: true, message: '账号验证成功！', userData: user, accountName, apiToken });
    } else {
      res.status(400).json({ error: 'API Token 无效或没有权限' });
    }
  } catch (error) {
    res.status(400).json({ error: 'API Token 验证失败: ' + error.message });
  }
});

app.get('/api/server-accounts', requireAuth, async (req, res) => {
  const serverAccounts = await loadServerAccounts();
  const envAccounts = getEnvAccounts();
  const allAccounts = [...envAccounts, ...serverAccounts];
  res.json(allAccounts);
});

app.post('/api/server-accounts', requireAuth, validateAccounts, async (req, res) => {
  const { accounts } = req.body;
  if (await saveServerAccounts(accounts)) {
    sendWebhook(EVENTS.ACCOUNT_ADDED, { count: accounts.length }).catch(() => {});
    res.json({ success: true, message: '账号已保存到服务器' });
  } else {
    res.status(500).json({ error: '保存失败' });
  }
});

app.delete('/api/server-accounts/:index', requireAuth, validateIndex, async (req, res) => {
  const index = parseInt(req.params.index);
  const accounts = await loadServerAccounts();

  if (index >= 0 && index < accounts.length) {
    const removed = accounts.splice(index, 1);
    if (await saveServerAccounts(accounts)) {
      sendWebhook(EVENTS.ACCOUNT_REMOVED, { accountName: removed[0].name }).catch(() => {});
      res.json({ success: true, message: '账号已删除' });
    } else {
      res.status(500).json({ error: '删除失败' });
    }
  } else {
    res.status(404).json({ error: '账号不存在' });
  }
});

// ==================== 服务操作 API ====================

app.post('/api/service/pause', requireAuth, validateServiceAction, async (req, res) => {
  const { token, serviceId, environmentId } = req.body;
  try {
    const mutation = `mutation { suspendService(serviceID: "${serviceId}", environmentID: "${environmentId}") }`;
    const result = await queryZeabur(token, mutation);
    if (result.data?.suspendService) {
      res.json({ success: true, message: '服务已暂停' });
    } else {
      res.status(400).json({ error: '暂停失败', details: result });
    }
  } catch (error) {
    res.status(500).json({ error: '暂停服务失败: ' + error.message });
  }
});

app.post('/api/service/restart', requireAuth, validateServiceAction, async (req, res) => {
  const { token, serviceId, environmentId } = req.body;
  try {
    const mutation = `mutation { restartService(serviceID: "${serviceId}", environmentID: "${environmentId}") }`;
    const result = await queryZeabur(token, mutation);
    if (result.data?.restartService) {
      res.json({ success: true, message: '服务已重启' });
    } else {
      res.status(400).json({ error: '重启失败', details: result });
    }
  } catch (error) {
    res.status(500).json({ error: '重启服务失败: ' + error.message });
  }
});

app.post('/api/service/logs', requireAuth, validateLogsQuery, async (req, res) => {
  const { token, serviceId, environmentId, projectId, limit = 200 } = req.body;
  try {
    const query = `query {
      runtimeLogs(projectID: "${projectId}", serviceID: "${serviceId}", environmentID: "${environmentId}") {
        message timestamp
      }
    }`;
    const result = await queryZeabur(token, query);

    if (result.data?.runtimeLogs) {
      const sortedLogs = result.data.runtimeLogs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      const logs = sortedLogs.slice(-limit);
      res.json({ success: true, logs, count: logs.length, totalCount: result.data.runtimeLogs.length });
    } else {
      res.status(400).json({ error: '获取日志失败', details: result });
    }
  } catch (error) {
    res.status(500).json({ error: '获取日志失败: ' + error.message });
  }
});

app.post('/api/project/rename', requireAuth, validateRename, async (req, res) => {
  const { accountId, projectId, newName } = req.body;
  try {
    const serverAccounts = await loadServerAccounts();
    const account = serverAccounts.find(acc => (acc.id || acc.name) === accountId);
    if (!account || !account.token) {
      return res.status(404).json({ error: '未找到账号或token' });
    }

    const mutation = `mutation { renameProject(_id: "${projectId}", name: "${newName}") }`;
    const result = await queryZeabur(account.token, mutation);

    if (result.data?.renameProject) {
      res.json({ success: true, message: '项目已重命名' });
    } else {
      res.status(400).json({ error: '重命名失败', details: result });
    }
  } catch (error) {
    res.status(500).json({ error: '重命名项目失败: ' + error.message });
  }
});

// ==================== 数据可视化 API ====================

app.get('/api/usage-history', requireAuth, async (req, res) => {
  const { account, days = 30 } = req.query;
  try {
    const history = await db.getUsageHistory(account, parseInt(days));
    res.json({ success: true, data: history });
  } catch (error) {
    res.status(500).json({ error: '获取用量历史失败: ' + error.message });
  }
});

// ==================== Webhook API ====================

app.get('/api/webhooks', requireAuth, async (req, res) => {
  const webhooks = await db.getWebhooks();
  res.json(webhooks.map(w => ({ ...w, secret: w.secret ? '******' : null })));
});

app.post('/api/webhooks', requireAuth, validateWebhook, async (req, res) => {
  const { url, name, secret, events } = req.body;
  const crypto = require('crypto');
  const id = crypto.randomBytes(8).toString('hex');
  const webhook = { id, url, name, secret, events, enabled: true, createdAt: Date.now() };

  if (await db.saveWebhook(webhook)) {
    // 更新内存中的 webhook 配置
    const webhooks = await db.getWebhooks();
    setWebhookConfigs(webhooks);
    res.json({ success: true, id });
  } else {
    res.status(500).json({ error: '保存 Webhook 失败' });
  }
});

app.delete('/api/webhooks/:id', requireAuth, async (req, res) => {
  if (await db.deleteWebhook(req.params.id)) {
    const webhooks = await db.getWebhooks();
    setWebhookConfigs(webhooks);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Webhook 不存在' });
  }
});

app.post('/api/webhooks/test', requireAuth, async (req, res) => {
  const { url, secret } = req.body;
  const result = await testWebhook(url, secret);
  res.json(result);
});

// ==================== 多用户 API ====================

app.get('/api/users', requireAuth, async (req, res) => {
  const users = await db.getUsers();
  res.json(users);
});

app.post('/api/users', requireAuth, async (req, res) => {
  const { username, password, role = 'user' } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  try {
    const passwordHash = await hashPassword(password);
    const userId = await db.createUser(username, passwordHash, role);
    res.json({ success: true, userId });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/users/:id', requireAuth, async (req, res) => {
  const userId = parseInt(req.params.id);
  if (await db.deleteUser(userId)) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '用户不存在' });
  }
});

// ==================== 兼容旧版本 ====================

app.get('/api/accounts', async (req, res) => res.json([]));
app.get('/api/projects', async (req, res) => res.json([]));

// ==================== 版本信息 ====================

app.get('/api/version', (req, res) => {
  const packageJson = require('./package.json');
  res.json({ version: packageJson.version });
});

app.get('/api/latest-version', async (req, res) => {
  try {
    const options = {
      hostname: 'raw.githubusercontent.com',
      path: '/jiujiu532/zeabur-monitor/main/package.json',
      method: 'GET', timeout: 5000
    };

    const request = https.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => data += chunk);
      response.on('end', () => {
        try {
          res.json({ version: JSON.parse(data).version });
        } catch (e) {
          res.status(500).json({ error: '解析版本信息失败' });
        }
      });
    });

    request.on('error', (error) => res.status(500).json({ error: '获取最新版本失败: ' + error.message }));
    request.on('timeout', () => { request.destroy(); res.status(500).json({ error: '请求超时' }); });
    request.end();
  } catch (error) {
    res.status(500).json({ error: '获取最新版本失败: ' + error.message });
  }
});

// ==================== 系统状态 ====================

app.get('/api/status', requireAuth, async (req, res) => {
  const { getActiveSessionCount } = require('./session-store');
  const redisInfo = getRedisInfo();
  const cacheStats = await cache.getStats();

  res.json({
    database: db.isDatabaseEnabled() ? 'PostgreSQL' : 'File',
    session: isRedisSessionEnabled() ? 'Redis' : 'Memory',
    cache: {
      backend: cacheStats.backend,
      redisKeys: cacheStats.redisKeys || 0,
      memoryKeys: cacheStats.memorySize
    },
    redis: {
      enabled: redisInfo.enabled,
      tls: redisInfo.tls
    },
    encryption: ENCRYPTION_ENABLED,
    activeSessions: await getActiveSessionCount(),
    quotaWarningThreshold: QUOTA_WARNING_THRESHOLD
  });
});

// 缓存管理 API
app.delete('/api/cache', requireAuth, async (req, res) => {
  await cache.flush();
  res.json({ success: true, message: '缓存已清空' });
});

app.get('/api/cache/stats', requireAuth, async (req, res) => {
  const stats = await cache.getStats();
  res.json(stats);
});

// ==================== 启动服务器 ====================

async function startServer() {
  await db.initDatabase();
  await initSessionStore();

  // 加载 Webhook 配置
  const webhooks = await db.getWebhooks();
  setWebhookConfigs(webhooks);

  app.listen(PORT, '0.0.0.0', async () => {
    const redisInfo = getRedisInfo();
    console.log(`✨ Zeabur Monitor v2.0 运行在 http://0.0.0.0:${PORT}`);
    console.log(`📁 数据存储: ${db.isDatabaseEnabled() ? 'PostgreSQL' : '文件系统'}`);
    console.log(`📝 Session: ${isRedisSessionEnabled() ? 'Redis' : '内存'}`);
    if (redisInfo.enabled) {
      console.log(`🗄️ 缓存: Redis${redisInfo.tls ? ' (TLS)' : ''}`);
    } else {
      console.log(`🗄️ 缓存: 内存`);
    }
    console.log(`🔐 Token 加密: ${ENCRYPTION_ENABLED ? '已启用' : '未启用'}`);
    console.log(`🔔 Webhook: ${webhooks.length} 个配置`);

    const envAccounts = getEnvAccounts();
    const serverAccounts = await loadServerAccounts();
    const totalAccounts = envAccounts.length + serverAccounts.length;

    if (totalAccounts > 0) {
      console.log(`📋 已加载 ${totalAccounts} 个账号`);
    } else {
      console.log(`📊 准备就绪，等待添加账号...`);
    }
  });
}

startServer().catch(err => {
  console.error('❌ 启动失败:', err.message);
  process.exit(1);
});

module.exports = app; // 用于测试
