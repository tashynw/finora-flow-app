import { Injectable } from '@nestjs/common';
import { InvoiceStatus } from '../generated/prisma/index.js';
import { serialize } from '../common/serialize.js';
import { PrismaService } from '../prisma/prisma.service.js';

const AWAITING = new Set<string>([
  InvoiceStatus.PENDING_SIGN_OFF,
  InvoiceStatus.PENDING_APPROVAL,
]);
const PAYABLE = new Set<string>([
  InvoiceStatus.APPROVED,
  InvoiceStatus.READY_FOR_SUBMISSION,
  InvoiceStatus.SUBMITTED,
  InvoiceStatus.OUTSTANDING,
  InvoiceStatus.ACCRUAL_NEEDED,
]);
const APPROVED = new Set<string>([
  ...PAYABLE,
  InvoiceStatus.PAID,
]);

type Money = { minor_units: number; currency: string; formatted: string };

function money(minor: number, currency: string): Money {
  const formatted = new Intl.NumberFormat('en-JM', {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
  }).format(minor / 100);
  return { minor_units: minor, currency, formatted };
}

function monthKey(value: Date) {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthWindow(months: number) {
  const now = new Date();
  const window: { key: string; label: string }[] = [];
  for (let index = months - 1; index >= 0; index -= 1) {
    const point = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1));
    window.push({
      key: monthKey(point),
      label: point.toLocaleString('en-US', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }),
    });
  }
  return window;
}

@Injectable()
export class OverviewService {
  constructor(private readonly prisma: PrismaService) {}

  async metrics(months = 6) {
    const span = Math.max(1, Math.min(months, 24));
    const window = monthWindow(span);
    const now = new Date();
    const thisStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lastStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const nextStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const [invoices, estimates, orders, packages, accruals, cards, routes] =
      await Promise.all([
        this.prisma.invoice.findMany({
          where: { archivedAt: null },
          include: { vendor: { select: { name: true } } },
        }),
        this.prisma.estimate.findMany({
          where: { archivedAt: null },
          include: { vendor: { select: { name: true } } },
        }),
        this.prisma.purchaseOrder.findMany({
          where: { archivedAt: null },
          include: { vendor: { select: { name: true } } },
        }),
        this.prisma.paymentPackage.count({
          where: { submittedAt: null, cancelledAt: null },
        }),
        this.prisma.accrualPeriod.count({ where: { lockedAt: null } }),
        this.prisma.creditCardPeriod.count({ where: { closedAt: null } }),
        this.prisma.approvalRequest.findMany({
          where: { status: { in: ['APPROVED', 'REJECTED'] } },
          select: { status: true, openedAt: true, closedAt: true },
        }),
      ]);

    const currencyCounts = new Map<string, number>();
    for (const invoice of invoices) {
      if (!invoice.currency) continue;
      currencyCounts.set(invoice.currency, (currencyCounts.get(invoice.currency) ?? 0) + 1);
    }
    const primary =
      [...currencyCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ??
      'JMD';

    const minor = (value: bigint | null) => (value == null ? 0 : Number(value));
    const when = (invoice: (typeof invoices)[number]) =>
      invoice.decidedAt ?? invoice.invoiceDate ?? invoice.createdAt;

    const flow = (states: Set<string>, start: Date, end: Date) =>
      invoices.reduce((total, invoice) => {
        if (!states.has(invoice.status) || invoice.currency !== primary) return total;
        const at = when(invoice);
        if (at < start || at >= end) return total;
        return total + minor(invoice.totalMinorUnits);
      }, 0);

    const series = (states: Set<string>) => {
      const totals = new Map<string, number>();
      for (const invoice of invoices) {
        if (!states.has(invoice.status) || invoice.currency !== primary) continue;
        const key = monthKey(when(invoice));
        totals.set(key, (totals.get(key) ?? 0) + minor(invoice.totalMinorUnits));
      }
      return window.map((point) => totals.get(point.key) ?? 0);
    };

    const paidTotal = invoices.reduce(
      (total, invoice) =>
        invoice.status === InvoiceStatus.PAID && invoice.currency === primary
          ? total + minor(invoice.totalMinorUnits)
          : total,
      0,
    );
    const approvedTotal = invoices.reduce(
      (total, invoice) =>
        APPROVED.has(invoice.status) && invoice.currency === primary
          ? total + minor(invoice.totalMinorUnits)
          : total,
      0,
    );
    const paidNow = flow(new Set([InvoiceStatus.PAID]), thisStart, nextStart);
    const paidBefore = flow(new Set([InvoiceStatus.PAID]), lastStart, thisStart);
    const approvedNow = flow(APPROVED, thisStart, nextStart);
    const approvedBefore = flow(APPROVED, lastStart, thisStart);
    const delta = (current: number, previous: number) =>
      previous <= 0 ? null : Math.round(((current - previous) / previous) * 1000) / 10;

    const awaitingInvoices = invoices.filter((invoice) => AWAITING.has(invoice.status));
    const awaitingEstimates = estimates.filter((estimate) =>
      AWAITING.has(estimate.status) || estimate.status === 'PENDING_APPROVAL',
    );
    const openItems = awaitingInvoices.length + awaitingEstimates.length;

    const stateCount = (statuses: string[]) =>
      invoices.filter((invoice) => statuses.includes(invoice.status)).length;

    const vendorTotals = new Map<string, number>();
    for (const invoice of invoices) {
      if (!APPROVED.has(invoice.status) || invoice.currency !== primary) continue;
      const name = invoice.vendor?.name || 'Unnamed vendor';
      vendorTotals.set(name, (vendorTotals.get(name) ?? 0) + minor(invoice.totalMinorUnits));
    }
    const ranked = [...vendorTotals.entries()]
      .filter(([, amount]) => amount > 0)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5);
    const topAmount = ranked[0]?.[1] ?? 0;

    const activity = [
      ...invoices.map((invoice) => ({
        kind: 'invoice',
        kind_label: 'Invoice',
        reference: invoice.reference,
        title: invoice.vendor?.name || invoice.description || 'Invoice',
        state_label: invoice.status.toLowerCase().replaceAll('_', ' '),
        tone: invoice.status === InvoiceStatus.EXCEPTION ? 'danger' : 'neutral',
        when: invoice.updatedAt.toISOString(),
        amount_formatted:
          invoice.totalMinorUnits != null && invoice.currency
            ? money(minor(invoice.totalMinorUnits), invoice.currency).formatted
            : null,
      })),
      ...estimates.map((estimate) => ({
        kind: 'estimate',
        kind_label: 'Estimate',
        reference: estimate.reference,
        title: estimate.vendor?.name || estimate.description || 'Estimate',
        state_label: estimate.status.toLowerCase().replaceAll('_', ' '),
        tone: 'neutral',
        when: estimate.updatedAt.toISOString(),
        amount_formatted:
          estimate.totalMinorUnits != null && estimate.currency
            ? money(minor(estimate.totalMinorUnits), estimate.currency).formatted
            : null,
      })),
    ]
      .sort((left, right) => right.when.localeCompare(left.when))
      .slice(0, 6);

    const decided = routes.filter((route) => route.closedAt);
    const approvedRoutes = decided.filter((route) => route.status === 'APPROVED');
    const hours = decided.map(
      (route) => (route.closedAt!.getTime() - route.openedAt.getTime()) / 3_600_000,
    );

    const spendByMonth = new Map<string, { invoices: number; purchase_orders: number }>();
    for (const invoice of invoices) {
      if (invoice.currency !== primary || !APPROVED.has(invoice.status)) continue;
      const key = monthKey(when(invoice));
      const bucket = spendByMonth.get(key) ?? { invoices: 0, purchase_orders: 0 };
      bucket.invoices += minor(invoice.totalMinorUnits);
      spendByMonth.set(key, bucket);
    }
    for (const order of orders) {
      if (order.currency !== primary || order.status !== 'APPROVED') continue;
      const key = monthKey(order.createdAt);
      const bucket = spendByMonth.get(key) ?? { invoices: 0, purchase_orders: 0 };
      bucket.purchase_orders += minor(order.totalMinorUnits);
      spendByMonth.set(key, bucket);
    }

    return serialize({
      generated_at: now.toISOString(),
      primary_currency: primary,
      kpis: [
        {
          key: 'awaiting_decision',
          label: 'Awaiting a decision',
          value: openItems,
          hint: 'Estimates and invoices in sign-off or approval.',
          tone: 'primary',
          money: null,
        },
        {
          key: 'payable',
          label: 'Outstanding to pay',
          value: invoices.filter((invoice) => PAYABLE.has(invoice.status)).length,
          hint: 'Approved through to outstanding, not yet paid.',
          tone: 'warning',
          money: money(
            invoices.reduce(
              (total, invoice) =>
                PAYABLE.has(invoice.status) && invoice.currency === primary
                  ? total + minor(invoice.totalMinorUnits)
                  : total,
              0,
            ),
            primary,
          ),
        },
        {
          key: 'settled',
          label: 'Settled',
          value: invoices.filter((invoice) => invoice.status === InvoiceStatus.PAID).length,
          hint: 'Invoices marked paid.',
          tone: 'success',
          money: money(paidTotal, primary),
        },
        {
          key: 'open_commitments',
          label: 'Open PO commitments',
          value: orders.filter((order) => order.status === 'APPROVED' && !order.closedAt).length,
          hint: 'Approved purchase orders still taking invoices.',
          tone: 'neutral',
          money: money(
            orders.reduce(
              (total, order) =>
                order.status === 'APPROVED' && !order.closedAt && order.currency === primary
                  ? total + minor(order.totalMinorUnits)
                  : total,
              0,
            ),
            primary,
          ),
        },
        {
          key: 'open_packages',
          label: 'Open payment packages',
          value: packages,
          hint: 'Assembled, not yet submitted to the bank.',
          tone: 'neutral',
          money: null,
        },
        {
          key: 'open_periods',
          label: 'Open periods',
          value: accruals + cards,
          hint: 'Accrual and credit-card periods still open.',
          tone: 'neutral',
          money: null,
        },
      ],
      spend_cards: [
        {
          key: 'total_spend',
          label: 'Total spend',
          hint: 'Invoices marked paid, all time.',
          tone: 'primary',
          money: money(paidTotal, primary),
          count: null,
          delta_pct: delta(paidNow, paidBefore),
          month_money: money(paidNow, primary),
          previous_money: money(paidBefore, primary),
          series: series(new Set([InvoiceStatus.PAID])),
        },
        {
          key: 'approved_amount',
          label: 'Approved amount',
          hint: 'Every invoice past the approval gate.',
          tone: 'info',
          money: money(approvedTotal, primary),
          count: null,
          delta_pct: delta(approvedNow, approvedBefore),
          month_money: money(approvedNow, primary),
          previous_money: money(approvedBefore, primary),
          series: series(APPROVED),
        },
        {
          key: 'pending_approvals',
          label: 'Pending approvals',
          hint: 'Estimates and invoices awaiting a decision.',
          tone: 'warning',
          money: money(0, primary),
          count: null,
          delta_pct: null,
          month_money: null,
          previous_money: null,
          series: [],
        },
        {
          key: 'open_items',
          label: 'Open items',
          hint: 'Records sitting in sign-off or approval.',
          tone: 'neutral',
          money: null,
          count: openItems,
          delta_pct: null,
          month_money: null,
          previous_money: null,
          series: [],
        },
      ],
      top_vendors: ranked.map(([name, amount]) => ({
        name,
        money: money(amount, primary),
        share: topAmount ? Math.round((amount / topAmount) * 10000) / 10000 : 0,
      })),
      recent_activity: activity,
      approval_performance: {
        decided: decided.length,
        avg_hours: hours.length
          ? Math.round((hours.reduce((sum, value) => sum + value, 0) / hours.length) * 10) / 10
          : null,
        approval_rate: decided.length
          ? Math.round((approvedRoutes.length / decided.length) * 10000) / 10000
          : null,
      },
      invoice_states: [
        { label: 'Draft', count: stateCount([InvoiceStatus.DRAFT]), tone: 'neutral' },
        {
          label: 'In approval',
          count: stateCount([
            InvoiceStatus.PENDING_SIGN_OFF,
            InvoiceStatus.PENDING_APPROVAL,
          ]),
          tone: 'primary',
        },
        {
          label: 'In flight',
          count: stateCount([
            InvoiceStatus.APPROVED,
            InvoiceStatus.READY_FOR_SUBMISSION,
            InvoiceStatus.SUBMITTED,
          ]),
          tone: 'info',
        },
        {
          label: 'Outstanding',
          count: stateCount([InvoiceStatus.OUTSTANDING, InvoiceStatus.ACCRUAL_NEEDED]),
          tone: 'warning',
        },
        { label: 'Paid', count: stateCount([InvoiceStatus.PAID]), tone: 'success' },
        { label: 'Exception', count: stateCount([InvoiceStatus.EXCEPTION]), tone: 'danger' },
      ],
      aging: [
        { label: 'Overdue', count: 0, tone: 'danger' },
        { label: 'Due within 7 days', count: 0, tone: 'warning' },
        { label: 'Due later', count: 0, tone: 'info' },
        { label: 'No due date', count: 0, tone: 'neutral' },
      ],
      monthly_activity: window.map((point) => ({
        label: point.label,
        invoices: invoices.filter((invoice) => monthKey(invoice.createdAt) === point.key).length,
        estimates: estimates.filter((estimate) => monthKey(estimate.createdAt) === point.key)
          .length,
      })),
      monthly_spend: window.map((point) => ({
        label: point.label,
        invoices: spendByMonth.get(point.key)?.invoices ?? 0,
        purchase_orders: spendByMonth.get(point.key)?.purchase_orders ?? 0,
        credit_cards: 0,
        accruals: 0,
      })),
    });
  }
}
