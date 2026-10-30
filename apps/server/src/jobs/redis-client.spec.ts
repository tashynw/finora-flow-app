import { afterEach, describe, expect, it } from 'vitest';
import { isLocalRedisHost, localRedisConnection } from './redis-client.js';

describe('local Redis helpers', () => {
  const previous = {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD,
    mode: process.env.REDIS_MODE,
  };

  afterEach(() => {
    process.env.REDIS_HOST = previous.host;
    process.env.REDIS_PORT = previous.port;
    process.env.REDIS_PASSWORD = previous.password;
    process.env.REDIS_MODE = previous.mode;
  });

  it('treats loopback hosts and REDIS_MODE=local as local', () => {
    expect(isLocalRedisHost('127.0.0.1')).toBe(true);
    expect(isLocalRedisHost('localhost')).toBe(true);
    expect(isLocalRedisHost('::1')).toBe(true);
    expect(isLocalRedisHost('finora-flow-dev.cache.amazonaws.com')).toBe(false);

    delete process.env.REDIS_HOST;
    process.env.REDIS_MODE = 'local';
    expect(isLocalRedisHost('')).toBe(true);
  });

  it('builds a plain BullMQ connection for local Redis', () => {
    process.env.REDIS_HOST = '127.0.0.1';
    process.env.REDIS_PORT = '6380';
    process.env.REDIS_PASSWORD = 'secret';

    expect(localRedisConnection()).toEqual({
      host: '127.0.0.1',
      port: 6380,
      password: 'secret',
      maxRetriesPerRequest: null,
    });
  });
});
