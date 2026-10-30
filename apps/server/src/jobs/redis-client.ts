import { createRequire } from 'node:module';
import { createIORedisClient, RedisConnection } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';
import type { ErrorEmitter } from 'ioredis/built/connectors/AbstractConnector.js';
import {
  createIamAuthToken,
  type CacheTarget,
} from './elasticache-auth.js';

const require = createRequire(import.meta.url);
const standalone = require('ioredis/built/connectors/StandaloneConnector.js');
const StandaloneConnector = (standalone.default ??
  standalone) as new (options: unknown) => {
  connect(errorEmitter: ErrorEmitter): Promise<unknown>;
};

let cacheTarget: CacheTarget | undefined;
let iamFactoryInstalled = false;
const pendingConnectors: IamConnector[] = [];

class IamConnector extends StandaloneConnector {
  redis?: Redis;

  constructor(options: unknown) {
    super(options);
    pendingConnectors.push(this);
  }

  override async connect(errorEmitter: ErrorEmitter) {
    const redis = this.redis;
    if (!redis || !cacheTarget) {
      throw new Error('ElastiCache connection is not ready');
    }
    const token = await createIamAuthToken(cacheTarget);
    redis.options.password = token;
    if (redis.condition) {
      redis.condition.auth = [cacheTarget.username, token];
    }
    return super.connect(errorEmitter);
  }
}

function attach(redis: Redis) {
  const connector = pendingConnectors.pop();
  if (!connector) {
    throw new Error('ElastiCache connector was not created');
  }
  connector.redis = redis;
  redis.duplicate = (override?: Partial<RedisOptions>) => {
    const child = Redis.prototype.duplicate.call(redis, {
      ...override,
      lazyConnect: true,
      Connector: IamConnector as unknown as RedisOptions['Connector'],
    });
    attach(child);
    return child;
  };
}

/** Install the IAM connector only when talking to ElastiCache. */
export function useCacheTarget(target: CacheTarget) {
  cacheTarget = target;
  if (iamFactoryInstalled) return;
  iamFactoryInstalled = true;
  RedisConnection.clientFactory = (options) => {
    const redis = new Redis({
      ...options,
      lazyConnect: true,
      Connector: IamConnector as unknown as RedisOptions['Connector'],
    });
    attach(redis);
    return createIORedisClient(redis);
  };
}

export function isLocalRedisHost(host = process.env.REDIS_HOST ?? '') {
  if (process.env.REDIS_MODE?.trim().toLowerCase() === 'local') return true;
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1'
  );
}

export function localRedisConnection() {
  const password = process.env.REDIS_PASSWORD?.trim();
  return {
    host: process.env.REDIS_HOST?.trim() || '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    ...(password ? { password } : {}),
    maxRetriesPerRequest: null,
  };
}
