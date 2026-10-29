import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compile, providePrisma } from '../testing/fixtures.js';
import { HealthService } from './health.service.js';

const modelsList = vi.hoisted(() => vi.fn());
const verifyOutboundMail = vi.hoisted(() => vi.fn());
const outboundMailConfigured = vi.hoisted(() => vi.fn());

vi.mock('../ai/moonshot.client.js', () => ({
  configuredExtractionModel: () => 'kimi-k2.6',
  moonshotClient: () => ({
    models: { list: modelsList },
  }),
}));

vi.mock('../mail/email.js', () => ({
  outboundMailConfigured,
  verifyOutboundMail,
}));

describe('HealthService', () => {
  const prisma = {
    $queryRaw: vi.fn(),
    systemSetting: { findUnique: vi.fn() },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOONSHOT_API_KEY = 'test-key';
    process.env.AI_ENABLED = 'true';
    delete process.env.AI_KILL_SWITCH;
    delete process.env.AI_KILL_SWITCH_ENGAGED;
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    prisma.systemSetting.findUnique.mockResolvedValue(null);
    modelsList.mockResolvedValue({ data: [{ id: 'kimi-k2.6' }] });
    outboundMailConfigured.mockReturnValue(true);
    verifyOutboundMail.mockResolvedValue(undefined);
  });

  async function service() {
    return compile(HealthService, [providePrisma(prisma)]);
  }

  it('is live without touching the database', async () => {
    expect((await service()).liveness()).toEqual({
      status: 'ok',
      version: '0.0.1',
    });
  });

  it('is not ready when postgres is down', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('down'));

    const result = await (await service()).readiness();

    expect(result.ready).toBe(false);
    expect(result.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'postgresql', state: 'down' }),
      ]),
    );
  });

  it('stays ready when AI or SMTP are down', async () => {
    modelsList.mockRejectedValue(new Error('Moonshot unreachable'));
    verifyOutboundMail.mockRejectedValue(new Error('SMTP auth failed'));

    const result = await (await service()).readiness();

    expect(result.ready).toBe(true);
    expect(result.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'postgresql', state: 'up' }),
        expect.objectContaining({ name: 'ai_gateway', state: 'down' }),
        expect.objectContaining({ name: 'smtp', state: 'down' }),
      ]),
    );
  });

  it('reports AI as not configured when the kill switch is engaged', async () => {
    process.env.AI_KILL_SWITCH = 'true';

    const result = await (await service()).readiness();

    expect(result.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'ai_gateway',
          state: 'not_configured',
        }),
      ]),
    );
    expect(modelsList).not.toHaveBeenCalled();
  });

  it('probes Moonshot with models.list when AI is enabled', async () => {
    const result = await (await service()).readiness();

    expect(modelsList).toHaveBeenCalled();
    expect(result.environment).toBeTruthy();
    expect(result.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ai_gateway', state: 'up' }),
        expect.objectContaining({ name: 'smtp', state: 'up' }),
      ]),
    );
  });


  it('marks AI degraded when the configured model is missing from the list', async () => {
    modelsList.mockResolvedValue({ data: [{ id: 'other-model' }] });

    const result = await (await service()).readiness();

    expect(result.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'ai_gateway',
          state: 'degraded',
        }),
      ]),
    );
  });
});
