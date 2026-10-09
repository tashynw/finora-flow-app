import { describe, expect, it, vi } from 'vitest';
import { compile, providePrisma } from '../testing/fixtures.js';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  it('is live without touching the database', async () => {
    const service = await compile(HealthService, [
      providePrisma({ $queryRaw: vi.fn() }),
    ]);
    expect(service.liveness()).toEqual({ status: 'ok', version: '0.0.1' });
  });

  it('is not ready when postgres is down', async () => {
    const service = await compile(HealthService, [
      providePrisma({ $queryRaw: vi.fn().mockRejectedValue(new Error('down')) }),
    ]);
    const result = await service.readiness();
    expect(result.ready).toBe(false);
    expect(result.dependencies[0]).toMatchObject({
      name: 'postgresql',
      state: 'down',
    });
  });
});
