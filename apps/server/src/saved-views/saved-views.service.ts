import { Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { notFound } from '../common/errors.js';
import type { Prisma } from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

const KEY = 'saved_views';

type SavedView = {
  id: string;
  userId: string;
  scope: string;
  name: string;
  definition: Record<string, unknown>;
  is_default: boolean;
};

function toOut(row: SavedView) {
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    definition: row.definition,
    is_default: row.is_default,
  };
}

@Injectable()
export class SavedViewsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(session: UserSession, scope: string) {
    const rows = await this.read();
    return rows
      .filter((row) => row.userId === session.user.id && row.scope === scope)
      .map(toOut);
  }

  async create(
    session: UserSession,
    body: {
      scope: string;
      name: string;
      definition: Record<string, unknown>;
      is_default?: boolean;
    },
  ) {
    const rows = await this.read();
    const next: SavedView = {
      id: crypto.randomUUID(),
      userId: session.user.id,
      scope: body.scope,
      name: body.name.trim(),
      definition: body.definition ?? {},
      is_default: body.is_default === true,
    };
    const stored = next.is_default
      ? rows.map((row) =>
          row.userId === session.user.id && row.scope === body.scope
            ? { ...row, is_default: false }
            : row,
        )
      : rows;
    await this.write([...stored, next]);
    return toOut(next);
  }

  async remove(session: UserSession, id: string) {
    const rows = await this.read();
    const existing = rows.find((row) => row.id === id && row.userId === session.user.id);
    if (!existing) throw notFound('Saved view', id);
    await this.write(rows.filter((row) => row.id !== id));
  }

  private async read(): Promise<SavedView[]> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: KEY } });
    return Array.isArray(row?.value) ? (row.value as SavedView[]) : [];
  }

  private async write(rows: SavedView[]) {
    await this.prisma.systemSetting.upsert({
      where: { key: KEY },
      create: {
        key: KEY,
        value: rows as unknown as Prisma.InputJsonValue,
        description: 'Named work-queue filters',
      },
      update: { value: rows as unknown as Prisma.InputJsonValue },
    });
  }
}
