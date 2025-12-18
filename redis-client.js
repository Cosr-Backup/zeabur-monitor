/**
 * Redis 客户端模块
 * 统一管理 Redis 连接，支持 TLS 和连接池
 */

let redisClient = null;
let isRedisConnected = false;
let connectionPromise = null;

/**
 * 解析 Redis TLS 配置
 * @returns {object|false} TLS 配置对象或 false
 */
function parseTlsConfig() {
  const redisUrl = process.env.REDIS_URL || '';
  const redisTls = process.env.REDIS_TLS;

  // rediss:// 协议自动启用 TLS
  if (redisUrl.startsWith('rediss://')) {
    return { rejectUnauthorized: false };
  }

  // 环境变量显式配置
  if (redisTls === 'true' || redisTls === '1') {
    return { rejectUnauthorized: false };
  }

  // 支持自定义 CA 证书
  if (process.env.REDIS_TLS_CA) {
    const fs = require('fs');
    try {
      return {
        ca: fs.readFileSync(process.env.REDIS_TLS_CA),
        rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false'
      };
    } catch (err) {
      console.error('❌ 读取 Redis TLS CA 证书失败:', err.message);
      return { rejectUnauthorized: false };
    }
  }

  return false;
}

/**
 * 构建 Redis 连接选项
 * @returns {object} ioredis 连接选项
 */
function buildRedisOptions() {
  const options = {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 10) {
        console.error('❌ Redis 重连次数超限，停止重试');
        return null;
      }
      const delay = Math.min(times * 200, 5000);
      console.log(`🔄 Redis 重连中... (${times}/10)`);
      return delay;
    },
    reconnectOnError: (err) => {
      const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
      return targetErrors.some(e => err.message.includes(e));
    },
    enableReadyCheck: true,
    lazyConnect: false
  };

  // TLS 配置
  const tlsConfig = parseTlsConfig();
  if (tlsConfig) {
    options.tls = tlsConfig;
    console.log('🔒 Redis TLS 已启用');
  }

  // 连接超时
  if (process.env.REDIS_CONNECT_TIMEOUT) {
    options.connectTimeout = parseInt(process.env.REDIS_CONNECT_TIMEOUT, 10);
  }

  // 命令超时
  if (process.env.REDIS_COMMAND_TIMEOUT) {
    options.commandTimeout = parseInt(process.env.REDIS_COMMAND_TIMEOUT, 10);
  }

  return options;
}

/**
 * 初始化 Redis 连接
 * @returns {Promise<boolean>} 是否成功连接
 */
async function initRedisClient() {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    return false;
  }

  // 防止并发初始化
  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    try {
      const Redis = require('ioredis');
      const options = buildRedisOptions();

      // 处理 rediss:// URL（ioredis 需要特殊处理）
      let connectionUrl = redisUrl;
      if (redisUrl.startsWith('rediss://') && options.tls) {
        // 将 rediss:// 转换为 redis:// 并依赖 tls 选项
        connectionUrl = redisUrl.replace('rediss://', 'redis://');
      }

      redisClient = new Redis(connectionUrl, options);

      // 监听连接事件
      redisClient.on('connect', () => {
        console.log('🔴 Redis 连接建立');
      });

      redisClient.on('ready', () => {
        isRedisConnected = true;
        console.log('✅ Redis 就绪');
      });

      redisClient.on('error', (err) => {
        console.error('❌ Redis 错误:', err.message);
        isRedisConnected = false;
      });

      redisClient.on('close', () => {
        console.log('🔴 Redis 连接关闭');
        isRedisConnected = false;
      });

      redisClient.on('reconnecting', (delay) => {
        console.log(`🔄 Redis ${delay}ms 后重连`);
      });

      // 验证连接
      await redisClient.ping();
      isRedisConnected = true;
      return true;
    } catch (error) {
      console.error('❌ Redis 连接失败:', error.message);
      redisClient = null;
      isRedisConnected = false;
      return false;
    } finally {
      connectionPromise = null;
    }
  })();

  return connectionPromise;
}

/**
 * 获取 Redis 客户端实例
 * @returns {object|null} Redis 客户端或 null
 */
function getRedisClient() {
  return redisClient;
}

/**
 * 检查 Redis 是否可用
 * @returns {boolean}
 */
function isRedisAvailable() {
  return isRedisConnected && redisClient !== null;
}

/**
 * 健康检查
 * @returns {Promise<boolean>}
 */
async function healthCheck() {
  if (!redisClient) return false;
  try {
    const result = await redisClient.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}

/**
 * 关闭 Redis 连接
 */
async function closeRedisClient() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    isRedisConnected = false;
    console.log('🔴 Redis 连接已关闭');
  }
}

/**
 * 获取 Redis 连接信息（用于状态展示）
 * @returns {object}
 */
function getRedisInfo() {
  const redisUrl = process.env.REDIS_URL || '';
  const tlsEnabled = redisUrl.startsWith('rediss://') ||
                     process.env.REDIS_TLS === 'true' ||
                     process.env.REDIS_TLS === '1';

  return {
    enabled: isRedisConnected,
    tls: tlsEnabled,
    connected: isRedisConnected
  };
}

module.exports = {
  initRedisClient,
  getRedisClient,
  isRedisAvailable,
  healthCheck,
  closeRedisClient,
  getRedisInfo
};
