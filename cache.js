/**
 * 缓存模块
 * 支持 Redis 和内存缓存，自动回退
 */

const { getRedisClient, isRedisAvailable } = require('./redis-client');

// 内存缓存（备用）
const memoryCache = new Map();

// 默认配置
const DEFAULT_TTL = 60; // 60秒
const CACHE_PREFIX = 'cache:';

// 缓存键前缀定义
const CACHE_KEYS = {
  ACCOUNT_INFO: 'account:',
  PROJECT_LIST: 'projects:',
  USER_BALANCE: 'balance:',
  API_RESPONSE: 'api:'
};

/**
 * 生成缓存键
 * @param {string} namespace - 命名空间
 * @param {string} key - 键名
 * @returns {string}
 */
function buildKey(namespace, key) {
  return CACHE_PREFIX + namespace + key;
}

/**
 * 设置缓存
 * @param {string} key - 缓存键
 * @param {any} value - 缓存值（会自动 JSON 序列化）
 * @param {number} ttl - 过期时间（秒），默认 60 秒
 * @returns {Promise<boolean>}
 */
async function set(key, value, ttl = DEFAULT_TTL) {
  const fullKey = CACHE_PREFIX + key;
  const serialized = JSON.stringify(value);

  const client = getRedisClient();
  if (isRedisAvailable() && client) {
    try {
      await client.setex(fullKey, ttl, serialized);
      return true;
    } catch (err) {
      console.error('❌ Redis 缓存写入失败:', err.message);
      // 回退到内存缓存
    }
  }

  // 内存缓存
  memoryCache.set(fullKey, {
    value: serialized,
    expiresAt: Date.now() + ttl * 1000
  });
  return true;
}

/**
 * 获取缓存
 * @param {string} key - 缓存键
 * @returns {Promise<any|null>}
 */
async function get(key) {
  const fullKey = CACHE_PREFIX + key;

  const client = getRedisClient();
  if (isRedisAvailable() && client) {
    try {
      const data = await client.get(fullKey);
      if (data) {
        return JSON.parse(data);
      }
      return null;
    } catch (err) {
      console.error('❌ Redis 缓存读取失败:', err.message);
      // 回退到内存缓存
    }
  }

  // 内存缓存
  const cached = memoryCache.get(fullKey);
  if (!cached) return null;

  if (Date.now() > cached.expiresAt) {
    memoryCache.delete(fullKey);
    return null;
  }

  return JSON.parse(cached.value);
}

/**
 * 删除缓存
 * @param {string} key - 缓存键
 * @returns {Promise<boolean>}
 */
async function del(key) {
  const fullKey = CACHE_PREFIX + key;

  const client = getRedisClient();
  if (isRedisAvailable() && client) {
    try {
      await client.del(fullKey);
    } catch (err) {
      console.error('❌ Redis 缓存删除失败:', err.message);
    }
  }

  memoryCache.delete(fullKey);
  return true;
}

/**
 * 批量删除匹配的缓存
 * @param {string} pattern - 键模式（支持 * 通配符）
 * @returns {Promise<number>} 删除的键数量
 */
async function delByPattern(pattern) {
  const fullPattern = CACHE_PREFIX + pattern;
  let count = 0;

  const client = getRedisClient();
  if (isRedisAvailable() && client) {
    try {
      const keys = await client.keys(fullPattern);
      if (keys.length > 0) {
        count = await client.del(...keys);
      }
    } catch (err) {
      console.error('❌ Redis 批量删除失败:', err.message);
    }
  }

  // 内存缓存
  const regex = new RegExp('^' + fullPattern.replace(/\*/g, '.*') + '$');
  for (const key of memoryCache.keys()) {
    if (regex.test(key)) {
      memoryCache.delete(key);
      count++;
    }
  }

  return count;
}

/**
 * 检查缓存是否存在
 * @param {string} key - 缓存键
 * @returns {Promise<boolean>}
 */
async function exists(key) {
  const fullKey = CACHE_PREFIX + key;

  const client = getRedisClient();
  if (isRedisAvailable() && client) {
    try {
      return (await client.exists(fullKey)) === 1;
    } catch (err) {
      console.error('❌ Redis exists 检查失败:', err.message);
    }
  }

  const cached = memoryCache.get(fullKey);
  if (!cached) return false;
  if (Date.now() > cached.expiresAt) {
    memoryCache.delete(fullKey);
    return false;
  }
  return true;
}

/**
 * 获取或设置缓存（缓存穿透保护）
 * @param {string} key - 缓存键
 * @param {Function} fetchFn - 数据获取函数
 * @param {number} ttl - 过期时间（秒）
 * @returns {Promise<any>}
 */
async function getOrSet(key, fetchFn, ttl = DEFAULT_TTL) {
  // 先尝试获取缓存
  const cached = await get(key);
  if (cached !== null) {
    return cached;
  }

  // 缓存不存在，调用获取函数
  const data = await fetchFn();

  // 存储缓存（即使是 null 也缓存，防止缓存穿透）
  if (data !== undefined) {
    await set(key, data, ttl);
  }

  return data;
}

/**
 * 缓存装饰器 - 用于 API 响应缓存
 * @param {string} keyPrefix - 键前缀
 * @param {number} ttl - 过期时间（秒）
 * @returns {Function}
 */
function cacheMiddleware(keyPrefix, ttl = DEFAULT_TTL) {
  return async (req, res, next) => {
    // 只缓存 GET 请求
    if (req.method !== 'GET') {
      return next();
    }

    const cacheKey = keyPrefix + req.originalUrl;

    try {
      const cached = await get(cacheKey);
      if (cached) {
        res.set('X-Cache', 'HIT');
        return res.json(cached);
      }
    } catch (err) {
      // 缓存读取失败，继续请求
    }

    // 包装 res.json 以捕获响应
    const originalJson = res.json.bind(res);
    res.json = async (data) => {
      res.set('X-Cache', 'MISS');
      try {
        await set(cacheKey, data, ttl);
      } catch (err) {
        // 缓存写入失败，不影响响应
      }
      return originalJson(data);
    };

    next();
  };
}

/**
 * 清理过期的内存缓存
 */
function cleanExpiredMemoryCache() {
  const now = Date.now();
  for (const [key, cached] of memoryCache.entries()) {
    if (now > cached.expiresAt) {
      memoryCache.delete(key);
    }
  }
}

/**
 * 获取缓存统计信息
 * @returns {Promise<object>}
 */
async function getStats() {
  const stats = {
    backend: isRedisAvailable() ? 'redis' : 'memory',
    memorySize: memoryCache.size
  };

  const client = getRedisClient();
  if (isRedisAvailable() && client) {
    try {
      const keys = await client.keys(CACHE_PREFIX + '*');
      stats.redisKeys = keys.length;
    } catch (err) {
      stats.redisKeys = 0;
    }
  }

  return stats;
}

/**
 * 清空所有缓存
 * @returns {Promise<void>}
 */
async function flush() {
  const client = getRedisClient();
  if (isRedisAvailable() && client) {
    try {
      const keys = await client.keys(CACHE_PREFIX + '*');
      if (keys.length > 0) {
        await client.del(...keys);
      }
    } catch (err) {
      console.error('❌ Redis 缓存清空失败:', err.message);
    }
  }

  memoryCache.clear();
}

// 每 5 分钟清理过期的内存缓存
setInterval(cleanExpiredMemoryCache, 5 * 60 * 1000);

module.exports = {
  set,
  get,
  del,
  delByPattern,
  exists,
  getOrSet,
  cacheMiddleware,
  getStats,
  flush,
  CACHE_KEYS,
  DEFAULT_TTL
};
