import { Injectable } from '@nestjs/common';
import {
  EstimateStatus,
  InvoiceStatus,
  PurchaseOrderStatus,
} from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

type WorkItem = {
  kind: string;
  recordId: string;
  reference: string;
  title: string;
  subtitle: string;
  waitingSince: Date;
};

@Injectable()
export class WorkService {
  constructor(private readonly prisma: PrismaService) {}

  private waitingHours(since: Date) {
    return Math.max(
      0,
      Math.floor((Date.now() - since.getTime()) / (1000 * 60 * 60)),
    );
  }

  private async pendingInvoices(limit: number): Promise<WorkItem[]> {
    const rows = await this.prisma.invoice.findMany({
      where: {
        archivedAt: null,
        status: {
          in: [
            InvoiceStatus.DRAFT,
            InvoiceStatus.PENDING_SIGN_OFF,
            InvoiceStatus.PENDING_APPROVAL,
          ],
        },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      include: { vendor: true },
    });
    return rows.map((row) => ({
      kind: 'invoice',
      recordId: row.id,
      reference: row.reference,
      title: row.invoiceNumber ?? row.reference,
      subtitle: row.vendor?.name ?? row.description,
      waitingSince: row.updatedAt,
    }));
  }

  private async pendingEstimates(limit: number): Promise<WorkItem[]> {
    const rows = await this.prisma.estimate.findMany({
      where: {
        archivedAt: null,
        status: {
          in: [EstimateStatus.DRAFT, EstimateStatus.PENDING_APPROVAL],
        },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      include: { vendor: true },
    });
    return rows.map((row) => ({
      kind: 'estimate',
      recordId: row.id,
      reference: row.reference,
      title: row.estimateNumber ?? row.reference,
      subtitle: row.vendor?.name ?? row.description,
      waitingSince: row.updatedAt,
    }));
  }

  private async pendingPurchaseOrders(limit: number): Promise<WorkItem[]> {
    const rows = await this.prisma.purchaseOrder.findMany({
      where: {
        archivedAt: null,
        status: {
          in: [
            PurchaseOrderStatus.DRAFT,
            PurchaseOrderStatus.PENDING_APPROVAL,
          ],
        },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({
      kind: 'purchase_order',
      recordId: row.id,
      reference: row.number,
      title: row.number,
      subtitle: row.description,
      waitingSince: row.updatedAt,
    }));
  }

  async queue(limit = 25) {
    const perKind = Math.ceil(limit / 3);
    const [invoices, estimates, orders] = await Promise.all([
      this.pendingInvoices(perKind),
      this.pendingEstimates(perKind),
      this.pendingPurchaseOrders(perKind),
    ]);

    const items = [...invoices, ...estimates, ...orders]
      .sort((a, b) => a.waitingSince.getTime() - b.waitingSince.getTime())
      .slice(0, limit)
      .map((item) => ({
        ...item,
        waitingHours: this.waitingHours(item.waitingSince),
      }));

    const countsByKind = items.reduce<Record<string, number>>((acc, item) => {
      acc[item.kind] = (acc[item.kind] ?? 0) + 1;
      return acc;
    }, {});

    return { items, total: items.length, countsByKind };
  }

  async badges() {
    const [
      invoiceCount,
      estimateCount,
      poCount,
      intakeCount,
      vendorReviewCount,
    ] = await Promise.all([
      this.prisma.invoice.count({
        where: {
          archivedAt: null,
          status: {
            in: [
              InvoiceStatus.DRAFT,
              InvoiceStatus.PENDING_SIGN_OFF,
              InvoiceStatus.PENDING_APPROVAL,
            ],
          },
        },
      }),
      this.prisma.estimate.count({
        where: {
          archivedAt: null,
          status: {
            in: [EstimateStatus.DRAFT, EstimateStatus.PENDING_APPROVAL],
          },
        },
      }),
      this.prisma.purchaseOrder.count({
        where: {
          archivedAt: null,
          status: {
            in: [
              PurchaseOrderStatus.DRAFT,
              PurchaseOrderStatus.PENDING_APPROVAL,
            ],
          },
        },
      }),
      this.prisma.inboundMessage.count({ where: { status: 'ready' } }),
      this.prisma.vendorCheckIn.count({
        where: { reviewedAt: null, answeredAt: { not: null } },
      }),
    ]);

    const myWork = invoiceCount + estimateCount + poCount;

    return {
      myWork,
      awaitingMyApproval: estimateCount + poCount + invoiceCount,
      documentsNeedingReview: 0,
      intakeUnprocessed: intakeCount,
      vendorNeedingReview: vendorReviewCount,
      operationalAlerts: 0,
    };
  }

  async dashboard(topN = 10) {
    const queue = await this.queue(topN);
    return { items: queue.items.slice(0, topN) };
  }
}
