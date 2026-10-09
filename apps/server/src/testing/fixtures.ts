import { Test, type Provider } from '@nestjs/testing';
import { vi } from 'vitest';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { AuditService } from '../common/audit.service.js';
import { TransitionsService } from '../common/transitions.service.js';
import type { User } from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

type ModelMock = {
  findMany: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  findUniqueOrThrow: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  createMany: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  aggregate: ReturnType<typeof vi.fn>;
  groupBy: ReturnType<typeof vi.fn>;
};

export function modelMock(): ModelMock {
  return {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
  };
}

export function prismaMock(models: string[]) {
  const prisma: Record<string, ModelMock | ReturnType<typeof vi.fn>> = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  };
  for (const name of models) {
    prisma[name] = modelMock();
  }
  return prisma as Record<string, ModelMock> & {
    $queryRaw: ReturnType<typeof vi.fn>;
  };
}

export function auditMock() {
  return { append: vi.fn().mockResolvedValue({ id: 'audit-1' }) };
}

export function transitionsMock() {
  return {
    record: vi.fn().mockResolvedValue({ id: 'transition-1' }),
    assertTransition: vi.fn(),
  };
}

export const session: UserSession = {
  session: { id: 'sess-1', userId: 'user-1' },
  user: {
    id: 'user-1',
    name: 'Ada Lovelace',
    email: 'ada@finora.test',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
} as UserSession;

export const user = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@finora.test',
  departmentId: 'dept-1',
  role: 'administrator',
} as User;

export async function compile<T>(
  Service: new (...args: never[]) => T,
  extras: Provider[],
) {
  const moduleRef = await Test.createTestingModule({
    providers: [Service, ...extras],
  }).compile();
  return moduleRef.get(Service);
}

export function providePrisma(prisma: object): Provider {
  return { provide: PrismaService, useValue: prisma };
}

export function provideAudit(audit: object = auditMock()): Provider {
  return { provide: AuditService, useValue: audit };
}

export function provideTransitions(
  transitions: object = transitionsMock(),
): Provider {
  return { provide: TransitionsService, useValue: transitions };
}
