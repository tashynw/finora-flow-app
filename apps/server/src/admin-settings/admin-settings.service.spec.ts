import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
  session,
} from '../testing/fixtures.js';
import { AdminSettingsService } from './admin-settings.service.js';

describe('AdminSettingsService', () => {
  const prisma = { systemSetting: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() } };

  beforeEach(() => vi.clearAllMocks());

  it('stores the AI kill switch as a system setting', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue(null);
    prisma.systemSetting.create.mockResolvedValue({ id: 'set-1' });

    const service = await compile(AdminSettingsService, [
      providePrisma(prisma),
      provideAudit(auditMock()),
    ]);
    const result = await service.setAiKillSwitch(
      { engaged: true, reason: 'Model outage' },
      session,
    );

    expect(prisma.systemSetting.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          value: { engaged: true },
        }),
      }),
    );
    expect(result.engaged).toBe(true);
    expect(result.kill_switch_effective).toBe(true);
  });
});
