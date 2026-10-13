import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { AuditService } from '../common/audit.service.js';
import { notFound } from '../common/errors.js';
import { serialize } from '../common/serialize.js';

type StoredEntry = {
  sequence: bigint;
  previousHash: string;
  entryHash: string;
  occurredAt: Date;
  action: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string;
  subjectType: string;
  subjectId: string | null;
  correlationId: string | null;
  detail: unknown;
};

function toAuditOut(row: StoredEntry) {
  return {
    sequence: Number(row.sequence),
    entry_hash: row.entryHash,
    previous_hash: row.previousHash,
    occurred_at: row.occurredAt.toISOString(),
    action: row.action,
    actor_type: row.actorType,
    actor_label: row.actorLabel,
    actor_id: row.actorId,
    subject_type: row.subjectType,
    subject_id: row.subjectId,
    correlation_id: row.correlationId,
    detail: row.detail ?? {},
  };
}

@Controller('audit')
@UseGuards(AuthGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('entries')
  async listEntries(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('action') action?: string,
    @Query('subjectType') subjectType?: string,
    @Query('subject_type') subjectTypeSnake?: string,
  ) {
    const result = await this.audit.list({
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      action,
      subjectType: subjectType ?? subjectTypeSnake,
    });
    return serialize({
      ...result,
      items: result.items.map((row) => toAuditOut(row)),
    });
  }

  @Get('entries/:sequence')
  async getEntry(@Param('sequence') sequence: string) {
    const row = await this.audit.getBySequence(BigInt(sequence));
    if (!row) {
      throw notFound('Audit entry', sequence);
    }
    return serialize(toAuditOut(row));
  }

  @Post('verify')
  async verify(
    @Body()
    body: {
      startSequence?: number | string;
      start_sequence?: number | string;
      limit?: number;
    },
  ) {
    const rawStart = body.startSequence ?? body.start_sequence;
    const start = rawStart != null ? BigInt(rawStart) : 1n;
    const limit = body.limit ?? 500;
    const result = await this.audit.verify(start, limit);
    return serialize({
      ok: result.ok,
      checked_count: result.checkedCount,
      first_bad_sequence:
        'firstBadSequence' in result && result.firstBadSequence != null
          ? Number(result.firstBadSequence)
          : null,
      message: result.message,
      reason: 'reason' in result ? result.reason : null,
    });
  }
}
