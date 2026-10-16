import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { compile, providePrisma } from '../testing/fixtures.js';
import { AuditService } from './audit.service.js';

describe('AuditService', () => {
  it('chains the next entry onto the previous hash', async () => {
    const prisma = {
      auditEntry: {
        findFirst: vi.fn().mockResolvedValue({
          sequence: 1n,
          entryHash: 'abc',
        }),
        create: vi.fn().mockImplementation(async ({ data }) => data),
      },
    };
    const service = await compile(AuditService, [providePrisma(prisma)]);

    const entry = await service.append({
      action: 'estimate.created',
      actorLabel: 'Ada',
      subjectType: 'estimate',
      subjectId: 'est-1',
      detail: { reference: 'EST-1' },
    });

    expect(entry.sequence).toBe(2n);
    expect(entry.previousHash).toBe('abc');
    expect(entry.entryHash).toHaveLength(64);
  });

  it('returns one page of the trail and the full count', async () => {
    const prisma = {
      auditEntry: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(45),
      },
    };
    const service = await compile(AuditService, [providePrisma(prisma)]);

    const page = await service.list({ take: 20, skip: 20, action: 'export' });

    expect(prisma.auditEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 20,
        skip: 20,
        where: { action: { contains: 'export', mode: 'insensitive' } },
        orderBy: { sequence: 'asc' },
      }),
    );
    expect(prisma.auditEntry.count).toHaveBeenCalled();
    expect(page.total).toBe(45);
    expect(page.take).toBe(20);
    expect(page.skip).toBe(20);
  });

  it('reports a broken chain', async () => {
    const occurredAt = new Date('2026-10-01T00:00:00.000Z');
    const prisma = {
      auditEntry: {
        findMany: vi.fn().mockResolvedValue([
          {
            sequence: 1n,
            previousHash: 'not-genesis',
            entryHash: 'dead',
            occurredAt,
            action: 'x',
            actorType: 'user',
            actorId: null,
            actorLabel: 'Ada',
            subjectType: 'estimate',
            subjectId: null,
            correlationId: null,
            detail: {},
          },
        ]),
        findUnique: vi.fn(),
      },
    };
    const service = await compile(AuditService, [providePrisma(prisma)]);
    const result = await service.verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('previous_hash_mismatch');
    void createHash;
  });
});
