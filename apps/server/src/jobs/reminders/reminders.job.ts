import { Injectable, Logger } from '@nestjs/common';
import { isEqual } from 'date-fns';
import type { ApprovalLevel } from '../../generated/prisma/index.js';
import { ApprovalsEngineService } from '../../approvals/approvals-engine.service.js';
import { LEVEL_LABELS } from '../../approvals/approval-levels.js';
import { RECORD_TYPE_META, type WorkflowRecordType } from '../../approvals/record-types.js';
import { AuditService } from '../../common/audit.service.js';
import { parseRoleField, type FinoraRoleId } from '../../common/roles.js';
import { sendEmail } from '../../mail/email.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  addCalendarDays,
  decideStaffReminder,
  decideVendorFollowUp,
  firstStaffDue,
  VENDOR_INTERVAL_DAYS,
  type ReminderDecision,
} from './reminder-clock.js';

const MOVED_ON = 'The record has moved on.';
const EXHAUSTED = 'This has been chased the maximum number of times.';
const LADDER: ApprovalLevel[] = ['UNIT_HEAD', 'MANAGER', 'HOD', 'COO'];

type Schedule = {
  id: string;
  recordId: string;
  sentCount: number;
  nextDueAt: Date | null;
  stoppedAt: Date | null;
  stoppedReason: string | null;
};

@Injectable()
export class RemindersJob {
  private readonly logger = new Logger(RemindersJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsEngineService,
  ) {}

  async remindUnreviewed() {
    const now = new Date();
    const estimates = await this.prisma.estimate.findMany({
      where: {
        status: 'DRAFT',
        archivedAt: null,
        documentId: { not: null },
        document: { documentProcessed: true },
      },
      select: { id: true, reference: true, createdAt: true },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    const invoices = await this.prisma.invoice.findMany({
      where: {
        status: 'DRAFT',
        archivedAt: null,
        documentId: { not: null },
        document: { documentProcessed: true },
      },
      select: { id: true, reference: true, createdAt: true },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    const waiting = [
      ...estimates.map((row) => ({
        id: row.id,
        recordType: 'estimate',
        reference: row.reference,
        since: row.createdAt,
        path: `/estimates/${row.id}`,
        label: 'Estimate',
      })),
      ...invoices.map((row) => ({
        id: row.id,
        recordType: 'invoice',
        reference: row.reference,
        since: row.createdAt,
        path: `/invoices/${row.id}`,
        label: 'Invoice',
      })),
    ];
    const staff = await this.staff(['finance', 'payment_coordinator', 'operations']);
    return this.sweep({
      purpose: 'unreviewed',
      now,
      waiting: waiting.map((row) => ({
        recordType: row.recordType,
        recordId: row.id,
        since: row.since,
        firstDueAt: firstStaffDue(row.since),
      })),
      mode: 'staff',
      send: async (schedule, decision) => {
        const row = waiting.find((item) => item.id === schedule.recordId);
        if (!row || staff.length === 0) return false;
        return this.deliver(
          staff,
          `Please review ${row.label.toLowerCase()} ${row.reference}`,
          `Hi,\n\n${row.label} ${row.reference} arrived from the mailbox and is still a draft.\n\nOpen it: ${this.link(row.path)}\n\nFinora Flow`,
          schedule,
          decision,
        );
      },
    });
  }

  async remindSignOff() {
    const now = new Date();
    const invoices = await this.prisma.invoice.findMany({
      where: { status: 'PENDING_SIGN_OFF', archivedAt: null, requesterId: { not: null } },
      select: {
        id: true,
        reference: true,
        updatedAt: true,
        departmentId: true,
        requester: { select: { id: true, name: true, email: true, departmentId: true } },
      },
      take: 50,
    });
    return this.sweep({
      purpose: 'sign_off',
      now,
      waiting: invoices.map((row) => ({
        recordType: 'invoice',
        recordId: row.id,
        since: row.updatedAt,
        firstDueAt: firstStaffDue(row.updatedAt),
        recipientId: row.requester?.id ?? null,
      })),
      mode: 'staff',
      send: async (schedule, decision) => {
        const row = invoices.find((item) => item.id === schedule.recordId);
        const requester = row?.requester;
        if (!row || !requester?.email) return false;
        const cc = await this.escalationCopies(
          decision.escalationLevel,
          requester.departmentId ?? row.departmentId,
          requester.id,
        );
        return this.deliver(
          [{ email: requester.email, name: requester.name }, ...cc],
          `Sign-off still needed: invoice ${row.reference}`,
          `Hi ${requester.name},\n\nInvoice ${row.reference} is still waiting for you to confirm you received it.\n\nOpen it: ${this.link(`/invoices/${row.id}`)}\n\nFinora Flow`,
          schedule,
          decision,
        );
      },
    });
  }

  async remindApprovals() {
    const now = new Date();
    const open = await this.prisma.approvalRequest.findMany({
      where: { status: 'OPEN', steps: { some: { status: 'READY' } } },
      include: { steps: true },
      take: 50,
      orderBy: { openedAt: 'asc' },
    });
    return this.sweep({
      purpose: 'approval',
      now,
      waiting: open.map((row) => ({
        recordType: 'approval_request',
        recordId: row.id,
        since: row.openedAt,
        firstDueAt: firstStaffDue(row.openedAt),
        recipientId: row.requesterId,
      })),
      mode: 'staff',
      send: async (schedule) => {
        const row = open.find((item) => item.id === schedule.recordId);
        if (!row) return false;
        const people = await this.approvals.listReadyApprovers({
          requesterId: row.requesterId,
          departmentId: row.departmentId,
          steps: row.steps,
        });
        if (people.length === 0) return false;
        const described = await this.describe(row.recordType, row.recordId);
        const amount = `${row.currency} ${(Number(row.amountMinorUnits) / 100).toFixed(2)}`;
        let sent = false;
        for (const person of people) {
          const ok = await this.trySend({
            to: person.email,
            subject: `Approval still waiting: ${described.label} ${described.reference}`,
            text: `Hi ${person.name},\n\n${described.label} ${described.reference} is still waiting for your approval as ${LEVEL_LABELS[person.level]}.\n\nAmount: ${amount}\n\nOpen it: ${this.link(described.path)}\n\nFinora Flow`,
          });
          sent = sent || ok;
        }
        if (sent) {
          await this.audit.append({
            action: 'reminder_sent',
            actorType: 'service',
            actorLabel: 'reminder job',
            subjectType: 'approval_request',
            subjectId: row.id,
            detail: { purpose: 'approval', reference: described.reference },
          });
        }
        return sent;
      },
    });
  }

  async remindPaymentPackages() {
    const now = new Date();
    const invoices = await this.prisma.invoice.findMany({
      where: { status: 'APPROVED', archivedAt: null, paymentPackageLine: null },
      select: { id: true, reference: true, updatedAt: true, currency: true, totalMinorUnits: true },
      take: 50,
    });
    const staff = await this.staff(['finance', 'payment_coordinator']);
    return this.sweep({
      purpose: 'payment_package',
      now,
      waiting: invoices.map((row) => ({
        recordType: 'invoice',
        recordId: row.id,
        since: row.updatedAt,
        firstDueAt: firstStaffDue(row.updatedAt),
      })),
      mode: 'staff',
      send: async (schedule, decision) => {
        const row = invoices.find((item) => item.id === schedule.recordId);
        if (!row || staff.length === 0) return false;
        const amount =
          row.totalMinorUnits != null && row.currency
            ? `${row.currency} ${(Number(row.totalMinorUnits) / 100).toFixed(2)}`
            : 'an amount that has not been entered';
        return this.deliver(
          staff,
          `Payment package needed: invoice ${row.reference}`,
          `Hi,\n\nInvoice ${row.reference} is approved and is not on a payment package yet.\n\nAmount: ${amount}\n\nOpen it: ${this.link(`/invoices/${row.id}`)}\n\nFinora Flow`,
          schedule,
          decision,
        );
      },
    });
  }

  async remindVendorCheckIns() {
    const now = new Date();
    const checkIns = await this.prisma.vendorCheckIn.findMany({
      where: {
        sentAt: { not: null },
        answeredAt: null,
        reviewedAt: null,
        vendor: { email: { not: null } },
      },
      include: {
        vendor: { select: { name: true, email: true } },
        package: { select: { reference: true, id: true } },
      },
      take: 50,
    });
    return this.sweep({
      purpose: 'payment_check_in',
      now,
      waiting: checkIns.flatMap((row) => {
        if (!row.sentAt) return [];
        return [
          {
            recordType: 'vendor_check_in',
            recordId: row.id,
            since: row.sentAt,
            firstDueAt: addCalendarDays(row.sentAt, VENDOR_INTERVAL_DAYS),
          },
        ];
      }),
      mode: 'vendor',
      send: async (schedule) => {
        const row = checkIns.find((item) => item.id === schedule.recordId);
        const email = row?.vendor?.email?.trim();
        if (!row || !email) return false;
        const lines = await this.prisma.paymentPackageLine.findMany({
          where: { packageId: row.packageId, vendorId: row.vendorId },
          select: { invoiceNumber: true, invoiceReference: true, currency: true, amountMinorUnits: true },
        });
        const listed = lines
          .map((line) => {
            const number = line.invoiceNumber ?? line.invoiceReference;
            return `- ${number}: ${line.currency} ${(Number(line.amountMinorUnits) / 100).toFixed(2)}`;
          })
          .join('\n');
        const name = row.vendor?.name ?? 'there';
        const ok = await this.trySend({
          to: email,
          subject: `Did this payment reach you? ${row.package.reference} [${row.correlationTag}]`,
          text: `Hi ${name},\n\nWe have not heard whether this payment reached you.\n\n${listed || '- (no invoices listed)'}\n\nOpen this link and tell us: ${this.link(`/payment-check-in/${row.correlationTag}`)}\n\nFinora Flow`,
        });
        if (ok) {
          await this.audit.append({
            action: 'vendor_confirmation_requested',
            actorType: 'service',
            actorLabel: 'reminder job',
            subjectType: 'vendor_check_in',
            subjectId: row.id,
            detail: { reference: row.reference, followUp: schedule.sentCount + 1 },
          });
        }
        return ok;
      },
    });
  }

  private async sweep(input: {
    purpose: string;
    now: Date;
    waiting: Array<{
      recordType: string;
      recordId: string;
      since: Date;
      firstDueAt: Date;
      recipientId?: string | null;
    }>;
    mode: 'staff' | 'vendor';
    send: (schedule: Schedule, decision: ReminderDecision) => Promise<boolean>;
  }) {
    const waitingIds = new Set(input.waiting.map((row) => row.recordId));
    for (const row of input.waiting) {
      await this.ensure(row, input.purpose);
    }

    const due = await this.prisma.reminderSchedule.findMany({
      where: {
        purpose: input.purpose,
        stoppedAt: null,
        nextDueAt: { lte: input.now },
      },
      take: 50,
      orderBy: { nextDueAt: 'asc' },
    });

    let sent = 0;
    let stopped = 0;
    for (const schedule of due) {
      const decision =
        input.mode === 'vendor'
          ? decideVendorFollowUp({
              now: input.now,
              dueAt: schedule.nextDueAt,
              sent: schedule.sentCount,
              stillWaiting: waitingIds.has(schedule.recordId),
            })
          : decideStaffReminder({
              now: input.now,
              dueAt: schedule.nextDueAt,
              sent: schedule.sentCount,
              stillWaiting: waitingIds.has(schedule.recordId),
            });

      if (!waitingIds.has(schedule.recordId) || decision.suppression === 'maximum_reached') {
        await this.stop(
          schedule.id,
          decision.suppression === 'maximum_reached' ? EXHAUSTED : MOVED_ON,
        );
        stopped += 1;
        continue;
      }
      if (!decision.send) {
        if (
          decision.nextDueAt &&
          (!schedule.nextDueAt || !isEqual(schedule.nextDueAt, decision.nextDueAt))
        ) {
          await this.prisma.reminderSchedule.update({
            where: { id: schedule.id },
            data: { nextDueAt: decision.nextDueAt },
          });
        }
        continue;
      }

      const delivered = await input.send(schedule, decision);
      if (!delivered) continue;
      await this.prisma.reminderSchedule.update({
        where: { id: schedule.id },
        data: {
          sentCount: { increment: 1 },
          lastSentAt: input.now,
          nextDueAt: decision.nextDueAt,
          escalationLevel: decision.escalationLevel,
          stoppedAt: decision.nextDueAt ? null : input.now,
          stoppedReason: decision.nextDueAt ? null : EXHAUSTED,
        },
      });
      sent += 1;
    }
    return { considered: due.length, sent, stopped };
  }

  private async ensure(
    row: {
      recordType: string;
      recordId: string;
      since: Date;
      firstDueAt: Date;
      recipientId?: string | null;
    },
    purpose: string,
  ) {
    const existing = await this.prisma.reminderSchedule.findUnique({
      where: {
        recordType_recordId_purpose: {
          recordType: row.recordType,
          recordId: row.recordId,
          purpose,
        },
      },
    });
    if (!existing) {
      await this.prisma.reminderSchedule.create({
        data: {
          recordType: row.recordType,
          recordId: row.recordId,
          purpose,
          recipientId: row.recipientId ?? null,
          startedAt: row.since,
          nextDueAt: row.firstDueAt,
        },
      });
      return;
    }
    if (existing.stoppedAt && existing.stoppedReason === MOVED_ON) {
      await this.prisma.reminderSchedule.update({
        where: { id: existing.id },
        data: {
          stoppedAt: null,
          stoppedReason: null,
          sentCount: 0,
          escalationLevel: 0,
          lastSentAt: null,
          startedAt: new Date(),
          nextDueAt: row.firstDueAt,
          recipientId: row.recipientId ?? existing.recipientId,
        },
      });
    }
  }

  private async stop(id: string, reason: string) {
    await this.prisma.reminderSchedule.update({
      where: { id },
      data: { stoppedAt: new Date(), stoppedReason: reason, nextDueAt: null },
    });
  }

  private async deliver(
    people: Array<{ email: string; name: string }>,
    subject: string,
    text: string,
    schedule: Schedule,
    _decision: ReminderDecision,
  ) {
    let sent = false;
    const seen = new Set<string>();
    for (const person of people) {
      if (!person.email || seen.has(person.email)) continue;
      seen.add(person.email);
      sent = (await this.trySend({ to: person.email, subject, text })) || sent;
    }
    if (sent) {
      await this.audit.append({
        action: 'reminder_sent',
        actorType: 'service',
        actorLabel: 'reminder job',
        subjectType: 'reminder_schedule',
        subjectId: schedule.id,
        detail: { subject },
      });
    }
    return sent;
  }

  private async trySend(message: { to: string; subject: string; text: string }) {
    try {
      await sendEmail(message);
      return true;
    } catch (error) {
      this.logger.error(
        `Reminder email to ${message.to} failed`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }

  private async staff(roles: FinoraRoleId[]) {
    const users = await this.prisma.user.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true, email: true, role: true },
    });
    const matched = users.filter((user) => {
      const have = parseRoleField(user.role);
      return roles.some((role) => have.includes(role));
    });
    const chosen = matched.length
      ? matched
      : users.filter((user) => parseRoleField(user.role).includes('administrator'));
    return chosen
      .filter((user) => user.email)
      .map((user) => ({ email: user.email, name: user.name }));
  }

  private async escalationCopies(
    level: number,
    departmentId: string | null,
    requesterId: string,
  ) {
    const levels = LADDER.slice(0, level);
    if (levels.length === 0) return [];
    const assigned = await this.prisma.user.findMany({
      where: {
        archivedAt: null,
        id: { not: requesterId },
        approvalAssignments: {
          some: {
            level: { in: levels },
            isActive: true,
            OR: [{ departmentId: null }, ...(departmentId ? [{ departmentId }] : [])],
          },
        },
      },
      select: { email: true, name: true },
    });
    return assigned.filter((user) => user.email);
  }

  private async describe(recordType: string, recordId: string) {
    const workflow = workflowType(recordType);
    const meta = workflow ? RECORD_TYPE_META[workflow] : null;
    if (workflow === 'estimate') {
      const row = await this.prisma.estimate.findUnique({
        where: { id: recordId },
        select: { reference: true },
      });
      return {
        label: meta?.label ?? 'Estimate',
        reference: row?.reference ?? recordId,
        path: `/estimates/${recordId}`,
      };
    }
    if (workflow === 'purchase_order') {
      const row = await this.prisma.purchaseOrder.findUnique({
        where: { id: recordId },
        select: { number: true },
      });
      return {
        label: meta?.label ?? 'Purchase order',
        reference: row?.number ?? recordId,
        path: `/purchase-orders/${recordId}`,
      };
    }
    const row = await this.prisma.invoice.findUnique({
      where: { id: recordId },
      select: { reference: true },
    });
    return {
      label: meta?.label ?? 'Invoice',
      reference: row?.reference ?? recordId,
      path: `/invoices/${recordId}`,
    };
  }

  private link(path: string) {
    const base = (process.env.WEB_APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');
    return `${base}${path}`;
  }
}

function workflowType(recordType: string): WorkflowRecordType | null {
  if (recordType === 'ESTIMATE' || recordType === 'estimate') return 'estimate';
  if (recordType === 'PURCHASE_ORDER' || recordType === 'purchase_order') return 'purchase_order';
  if (recordType === 'INVOICE' || recordType === 'invoice') return 'invoice';
  return null;
}
