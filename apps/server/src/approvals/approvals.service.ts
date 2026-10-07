import { Injectable } from '@nestjs/common';
import type { User } from '../generated/prisma/index.js';
import { serialize } from '../common/serialize.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LEVEL_LABELS, approvalLevelToApi } from './approval-levels.js';
import { withReadyStates } from './approval-domain.js';
import { ApprovalsEngineService } from './approvals-engine.service.js';
import { RECORD_TYPE_META, type WorkflowRecordType } from './record-types.js';

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: ApprovalsEngineService,
  ) {}

  async queue(user: User, recordType?: WorkflowRecordType) {
    const candidates = await this.engine.awaitingForUser(user, recordType);
    const mine = await this.engine.filterAwaitingMine(user, candidates);

    const recordIds = new Map<WorkflowRecordType, Set<string>>();
    for (const { request } of mine) {
      const rt = request.recordType as WorkflowRecordType;
      const set = recordIds.get(rt) ?? new Set();
      set.add(request.recordId);
      recordIds.set(rt, set);
    }

    const summaries = await this.loadRecordSummaries(recordIds);

    const items = mine.map(({ request, step }) => {
      const rt = request.recordType as WorkflowRecordType;
      const meta = RECORD_TYPE_META[rt];
      const record = summaries.get(`${rt}:${request.recordId}`);
      const ready = withReadyStates(
        this.engine.progressFromRequest(request),
      ).filter((s) => s.status === 'READY');
      const myLevels = ready
        .filter((s) => s.level === step.level)
        .map((s) => LEVEL_LABELS[s.level]);

      const openedAt = request.openedAt;
      const waitingHours = Math.floor(
        (Date.now() - openedAt.getTime()) / (1000 * 60 * 60),
      );

      return {
        request_id: request.id,
        record_type: rt,
        record_type_label: meta.label,
        record_id: request.recordId,
        record_path: `${meta.pathPrefix}/${request.recordId}`,
        reference: record?.reference ?? request.recordId,
        vendor_name: record?.vendorName ?? '',
        description: record?.description ?? '',
        amount_minor_units: Number(request.amountMinorUnits),
        currency: request.currency,
        amount_formatted: record?.amountFormatted ?? null,
        department: request.department?.name ?? null,
        requester_label: request.requester?.name ?? null,
        my_levels: myLevels,
        awaiting_labels: ready.map((s) => LEVEL_LABELS[s.level]),
        opened_at: openedAt.toISOString(),
        waiting_hours: waitingHours,
        attempt: request.attempt,
      };
    });

    const countsByType: Record<string, number> = {};
    for (const item of items) {
      countsByType[item.record_type] =
        (countsByType[item.record_type] ?? 0) + 1;
    }

    return serialize({
      items,
      total: items.length,
      counts_by_type: countsByType,
    });
  }

  private async loadRecordSummaries(
    byType: Map<WorkflowRecordType, Set<string>>,
  ) {
    const out = new Map<
      string,
      {
        reference: string;
        vendorName: string;
        description: string;
        amountFormatted: string | null;
      }
    >();

    const estimates = byType.get('estimate');
    if (estimates?.size) {
      const rows = await this.prisma.estimate.findMany({
        where: { id: { in: [...estimates] } },
        include: { vendor: true },
      });
      for (const row of rows) {
        out.set(`estimate:${row.id}`, {
          reference: row.reference,
          vendorName: row.vendor?.name ?? '',
          description: row.description,
          amountFormatted: formatMoney(row.totalMinorUnits, row.currency),
        });
      }
    }

    const orders = byType.get('purchase_order');
    if (orders?.size) {
      const rows = await this.prisma.purchaseOrder.findMany({
        where: { id: { in: [...orders] } },
        include: { vendor: true },
      });
      for (const row of rows) {
        out.set(`purchase_order:${row.id}`, {
          reference: row.number,
          vendorName: row.vendor?.name ?? '',
          description: row.description,
          amountFormatted: formatMoney(row.totalMinorUnits, row.currency),
        });
      }
    }

    const invoices = byType.get('invoice');
    if (invoices?.size) {
      const rows = await this.prisma.invoice.findMany({
        where: { id: { in: [...invoices] } },
        include: { vendor: true },
      });
      for (const row of rows) {
        out.set(`invoice:${row.id}`, {
          reference: row.reference,
          vendorName: row.vendor?.name ?? '',
          description: row.description,
          amountFormatted: formatMoney(row.totalMinorUnits, row.currency),
        });
      }
    }

    return out;
  }
}

function formatMoney(
  minor: bigint | null | undefined,
  currency: string | null | undefined,
) {
  if (minor == null || !currency) return null;
  const major = Number(minor) / 100;
  return `${currency} ${major.toFixed(2)}`;
}

export function mapStepsForApi(
  request: {
    id: string;
    status: string;
    attempt: number;
    currentStepOrder: number | null;
    steps: Array<{
      stepOrder: number;
      level: string;
      status: string;
      decidedAt: Date | null;
      decidedByLabel: string | null;
      comment: string | null;
    }>;
  },
  userId: string,
  requesterId: string,
  mayDecideChecker: (level: string) => boolean,
) {
  const progress = withReadyStates(
    request.steps.map((s) => ({
      stepOrder: s.stepOrder,
      level: s.level as never,
      status: s.status as never,
    })),
  );

  return {
    id: request.id,
    status: request.status.toLowerCase(),
    attempt: request.attempt,
    current_step_order: request.currentStepOrder,
    steps: progress.map((s) => {
      const row = request.steps.find(
        (r) => r.stepOrder === s.stepOrder && r.level === s.level,
      )!;
      return {
        step_order: s.stepOrder,
        level: approvalLevelToApi(s.level),
        status: s.status.toLowerCase(),
        decided_at: row.decidedAt?.toISOString() ?? null,
        decided_by_label: row.decidedByLabel,
        comment: row.comment,
        is_mine_to_decide:
          s.status === 'READY' &&
          requesterId !== userId &&
          mayDecideChecker(s.level),
      };
    }),
  };
}
