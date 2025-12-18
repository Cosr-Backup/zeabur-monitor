/**
 * 数据库存储模块
 * 支持 PostgreSQL 持久化存储（可选）
 * 当配置 DATABASE_URL 时启用，否则回退到文件存储
 */

const fs = require('fs');
const path = require('path');

// 数据库连接池
let pool = null;
let isDbEnabled = false;

// 文件存储路径
const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const PASSWORD_FILE = path.join(__dirname, 'password.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const WEBHOOKS_FILE = path.join(DATA_DIR, 'webhooks.json');
const USAGE_HISTORY_FILE = path.join(DATA_DIR, 'usage-history.json');

// 确保数据目录存在
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * 初始化数据库连接
 */
async function initDatabase() {
  ensureDataDir();
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.log('📁 存储模式: 文件存储');
    return false;
  }

  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
    });

    // 获取 schema 配置，默认为 public
    const schema = process.env.DATABASE_SCHEMA || 'public';

    // 使用单个客户端连接来初始化，确保 search_path 设置生效
    const client = await pool.connect();
    try {
      // 创建 schema（如果不存在）
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);

      // 设置 search_path
      await client.query(`SET search_path TO ${schema}`);
      await client.query('SELECT 1');

      // 创建表（在同一个连接上）
      await createTablesWithClient(client);

      console.log(`✅ 数据库表已就绪 (schema: ${schema})`);
    } finally {
      client.release();
    }

    // 为连接池设置默认 search_path
    pool.on('connect', (client) => {
      client.query(`SET search_path TO ${schema}`);
    });

    isDbEnabled = true;
    console.log('🐘 存储模式: PostgreSQL');
    return true;
  } catch (error) {
    console.error('❌ PostgreSQL 连接失败:', error.message);
    console.log('📁 回退到文件存储模式');
    pool = null;
    return false;
  }
}

/**
 * 创建数据库表（使用指定的客户端连接）
 */
async function createTablesWithClient(client) {
  // 用户表
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 账号表
  await client.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      token TEXT,
      encrypted_token JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 配置表（存储系统配置）
  await client.query(`
    CREATE TABLE IF NOT EXISTS config (
      key VARCHAR(255) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Webhook 表
  await client.query(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id VARCHAR(32) PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(100),
      url TEXT NOT NULL,
      secret VARCHAR(256),
      events JSONB,
      enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 用量历史表
  await client.query(`
    CREATE TABLE IF NOT EXISTS usage_history (
      id SERIAL PRIMARY KEY,
      account_name VARCHAR(255) NOT NULL,
      usage_amount DECIMAL(10, 4) NOT NULL,
      recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 创建索引
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_usage_history_account
    ON usage_history(account_name, recorded_at)
  `);
}

/**
 * 检查是否启用数据库
 */
function isDatabaseEnabled() {
  return isDbEnabled && pool !== null;
}

// ==================== 账号管理 ====================

/**
 * 读取账号列表
 */
async function loadAccounts(encryptionEnabled, decryptFn, secret, userId = null) {
  if (isDatabaseEnabled()) {
    try {
      let query = 'SELECT name, token, encrypted_token FROM accounts';
      const params = [];
      if (userId) {
        query += ' WHERE user_id = $1';
        params.push(userId);
      }
      query += ' ORDER BY id';

      const result = await pool.query(query, params);

      return result.rows.map(row => {
        if (encryptionEnabled && row.encrypted_token) {
          try {
            const token = decryptFn(row.encrypted_token, secret);
            return { name: row.name, token };
          } catch (e) {
            console.error(`❌ 解密账号 [${row.name}] 失败:`, e.message);
            return { name: row.name, token: row.token };
          }
        }
        return { name: row.name, token: row.token };
      });
    } catch (error) {
      console.error('❌ 从数据库读取账号失败:', error.message);
      return [];
    }
  }

  // 文件存储
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const data = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
      const accounts = JSON.parse(data);

      if (encryptionEnabled) {
        return accounts.map(account => {
          if (account.encryptedToken) {
            try {
              const token = decryptFn(account.encryptedToken, secret);
              return { ...account, token, encryptedToken: undefined };
            } catch (e) {
              console.error(`❌ 解密账号 [${account.name}] 失败:`, e.message);
              return account;
            }
          }
          return account;
        });
      }

      return accounts;
    }
  } catch (e) {
    console.error('❌ 读取账号文件失败:', e.message);
  }
  return [];
}

/**
 * 保存账号列表
 */
async function saveAccounts(accounts, encryptionEnabled, encryptFn, secret, userId = null) {
  if (isDatabaseEnabled()) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 清空现有账号
      if (userId) {
        await client.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
      } else {
        await client.query('DELETE FROM accounts WHERE user_id IS NULL');
      }

      // 插入新账号
      for (const account of accounts) {
        if (encryptionEnabled && account.token) {
          try {
            const encryptedToken = encryptFn(account.token, secret);
            await client.query(
              'INSERT INTO accounts (user_id, name, encrypted_token) VALUES ($1, $2, $3)',
              [userId, account.name, encryptedToken]
            );
          } catch (e) {
            console.error(`❌ 加密账号 [${account.name}] 失败:`, e.message);
            await client.query(
              'INSERT INTO accounts (user_id, name, token) VALUES ($1, $2, $3)',
              [userId, account.name, account.token]
            );
          }
        } else {
          await client.query(
            'INSERT INTO accounts (user_id, name, token) VALUES ($1, $2, $3)',
            [userId, account.name, account.token]
          );
        }
      }

      await client.query('COMMIT');
      if (encryptionEnabled) {
        console.log('🔐 账号 Token 已加密存储到数据库');
      }
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ 保存账号到数据库失败:', error.message);
      return false;
    } finally {
      client.release();
    }
  }

  // 文件存储
  try {
    let accountsToSave = accounts;

    if (encryptionEnabled) {
      accountsToSave = accounts.map(account => {
        if (account.token) {
          try {
            const encryptedToken = encryptFn(account.token, secret);
            const { token, ...rest } = account;
            return { ...rest, encryptedToken };
          } catch (e) {
            console.error(`❌ 加密账号 [${account.name}] 失败:`, e.message);
            return account;
          }
        }
        return account;
      });
      console.log('🔐 账号 Token 已加密存储');
    }

    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accountsToSave, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('❌ 保存账号文件失败:', e.message);
    return false;
  }
}

// ==================== 密码管理 ====================

/**
 * 读取管理员密码
 */
async function loadPassword() {
  if (isDatabaseEnabled()) {
    try {
      const result = await pool.query(
        "SELECT value FROM config WHERE key = 'admin_password'"
      );
      return result.rows[0]?.value || null;
    } catch (error) {
      console.error('❌ 从数据库读取密码失败:', error.message);
      return null;
    }
  }

  // 文件存储
  try {
    if (fs.existsSync(PASSWORD_FILE)) {
      const data = fs.readFileSync(PASSWORD_FILE, 'utf8');
      return JSON.parse(data).password;
    }
  } catch (e) {
    console.error('❌ 读取密码文件失败:', e.message);
  }
  return null;
}

/**
 * 保存管理员密码
 */
async function savePassword(password) {
  if (isDatabaseEnabled()) {
    try {
      await pool.query(`
        INSERT INTO config (key, value, updated_at)
        VALUES ('admin_password', $1, CURRENT_TIMESTAMP)
        ON CONFLICT (key)
        DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP
      `, [password]);
      return true;
    } catch (error) {
      console.error('❌ 保存密码到数据库失败:', error.message);
      return false;
    }
  }

  // 文件存储
  try {
    fs.writeFileSync(PASSWORD_FILE, JSON.stringify({ password }, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('❌ 保存密码文件失败:', e.message);
    return false;
  }
}

// ==================== 用户管理（多用户支持） ====================

/**
 * 创建用户
 */
async function createUser(username, passwordHash, role = 'user') {
  if (isDatabaseEnabled()) {
    try {
      const result = await pool.query(
        'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
        [username, passwordHash, role]
      );
      return result.rows[0].id;
    } catch (error) {
      if (error.code === '23505') { // 唯一约束冲突
        throw new Error('用户名已存在');
      }
      throw error;
    }
  }

  // 文件存储
  ensureDataDir();
  const users = loadUsersFromFile();
  if (users.find(u => u.username === username)) {
    throw new Error('用户名已存在');
  }
  const id = users.length + 1;
  users.push({ id, username, passwordHash, role, createdAt: Date.now() });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  return id;
}

/**
 * 获取用户
 */
async function getUser(username) {
  if (isDatabaseEnabled()) {
    const result = await pool.query(
      'SELECT id, username, password_hash, role FROM users WHERE username = $1',
      [username]
    );
    if (result.rows[0]) {
      return {
        id: result.rows[0].id,
        username: result.rows[0].username,
        passwordHash: result.rows[0].password_hash,
        role: result.rows[0].role
      };
    }
    return null;
  }

  // 文件存储
  const users = loadUsersFromFile();
  return users.find(u => u.username === username) || null;
}

/**
 * 获取用户列表
 */
async function getUsers() {
  if (isDatabaseEnabled()) {
    const result = await pool.query(
      'SELECT id, username, role, created_at FROM users ORDER BY id'
    );
    return result.rows.map(row => ({
      id: row.id,
      username: row.username,
      role: row.role,
      createdAt: row.created_at
    }));
  }

  // 文件存储
  const users = loadUsersFromFile();
  return users.map(({ passwordHash, ...rest }) => rest);
}

/**
 * 删除用户
 */
async function deleteUser(userId) {
  if (isDatabaseEnabled()) {
    const result = await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    return result.rowCount > 0;
  }

  // 文件存储
  const users = loadUsersFromFile();
  const index = users.findIndex(u => u.id === userId);
  if (index !== -1) {
    users.splice(index, 1);
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    return true;
  }
  return false;
}

function loadUsersFromFile() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('❌ 读取用户文件失败:', e.message);
  }
  return [];
}

// ==================== Webhook 管理 ====================

/**
 * 获取 Webhooks
 */
async function getWebhooks(userId = null) {
  if (isDatabaseEnabled()) {
    let query = 'SELECT * FROM webhooks';
    const params = [];
    if (userId) {
      query += ' WHERE user_id = $1';
      params.push(userId);
    }
    const result = await pool.query(query, params);
    return result.rows;
  }

  // 文件存储
  try {
    if (fs.existsSync(WEBHOOKS_FILE)) {
      return JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('❌ 读取 Webhook 文件失败:', e.message);
  }
  return [];
}

/**
 * 保存 Webhook
 */
async function saveWebhook(webhook) {
  if (isDatabaseEnabled()) {
    await pool.query(`
      INSERT INTO webhooks (id, user_id, name, url, secret, events, enabled)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        name = $3, url = $4, secret = $5, events = $6, enabled = $7
    `, [webhook.id, webhook.userId, webhook.name, webhook.url, webhook.secret, JSON.stringify(webhook.events), webhook.enabled !== false]);
    return true;
  }

  // 文件存储
  ensureDataDir();
  const webhooks = await getWebhooks();
  const index = webhooks.findIndex(w => w.id === webhook.id);
  if (index !== -1) {
    webhooks[index] = webhook;
  } else {
    webhooks.push(webhook);
  }
  fs.writeFileSync(WEBHOOKS_FILE, JSON.stringify(webhooks, null, 2), 'utf8');
  return true;
}

/**
 * 删除 Webhook
 */
async function deleteWebhook(webhookId) {
  if (isDatabaseEnabled()) {
    const result = await pool.query('DELETE FROM webhooks WHERE id = $1', [webhookId]);
    return result.rowCount > 0;
  }

  // 文件存储
  const webhooks = await getWebhooks();
  const index = webhooks.findIndex(w => w.id === webhookId);
  if (index !== -1) {
    webhooks.splice(index, 1);
    fs.writeFileSync(WEBHOOKS_FILE, JSON.stringify(webhooks, null, 2), 'utf8');
    return true;
  }
  return false;
}

// ==================== 用量历史（数据可视化） ====================

/**
 * 记录用量
 */
async function recordUsage(accountName, usageAmount) {
  if (isDatabaseEnabled()) {
    await pool.query(
      'INSERT INTO usage_history (account_name, usage_amount) VALUES ($1, $2)',
      [accountName, usageAmount]
    );
    return true;
  }

  // 文件存储
  ensureDataDir();
  const history = loadUsageHistoryFromFile();
  history.push({
    accountName,
    usageAmount,
    recordedAt: new Date().toISOString()
  });

  // 只保留最近 30 天的数据
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const filtered = history.filter(h => new Date(h.recordedAt).getTime() > thirtyDaysAgo);

  fs.writeFileSync(USAGE_HISTORY_FILE, JSON.stringify(filtered, null, 2), 'utf8');
  return true;
}

/**
 * 获取用量历史
 */
async function getUsageHistory(accountName = null, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  if (isDatabaseEnabled()) {
    let query = 'SELECT account_name, usage_amount, recorded_at FROM usage_history WHERE recorded_at > $1';
    const params = [since];
    if (accountName) {
      query += ' AND account_name = $2';
      params.push(accountName);
    }
    query += ' ORDER BY recorded_at';

    const result = await pool.query(query, params);
    return result.rows.map(row => ({
      accountName: row.account_name,
      usageAmount: parseFloat(row.usage_amount),
      recordedAt: row.recorded_at
    }));
  }

  // 文件存储
  const history = loadUsageHistoryFromFile();
  return history
    .filter(h => {
      const recordTime = new Date(h.recordedAt).getTime();
      const matchAccount = !accountName || h.accountName === accountName;
      return recordTime > since.getTime() && matchAccount;
    })
    .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
}

function loadUsageHistoryFromFile() {
  try {
    if (fs.existsSync(USAGE_HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(USAGE_HISTORY_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('❌ 读取用量历史文件失败:', e.message);
  }
  return [];
}

// ==================== 数据库连接管理 ====================

/**
 * 关闭数据库连接
 */
async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
    isDbEnabled = false;
  }
}

module.exports = {
  initDatabase,
  isDatabaseEnabled,
  // 账号
  loadAccounts,
  saveAccounts,
  // 密码
  loadPassword,
  savePassword,
  // 用户
  createUser,
  getUser,
  getUsers,
  deleteUser,
  // Webhook
  getWebhooks,
  saveWebhook,
  deleteWebhook,
  // 用量历史
  recordUsage,
  getUsageHistory,
  // 连接
  closeDatabase
};
