import type { ApprovalRecordType } from '../generated/prisma/index.js';

export const RECORD_TYPES = {
  estimate: 'estimate',
  purchaseOrder: 'purchase_order',
  invoice: 'invoice',
} as const;

export type WorkflowRecordType =
  (typeof RECORD_TYPES)[keyof typeof RECORD_TYPES];

export function toPrismaApprovalRecordType(
  recordType: WorkflowRecordType,
): ApprovalRecordType {
  switch (recordType) {
    case RECORD_TYPES.estimate:
      return 'ESTIMATE';
    case RECORD_TYPES.purchaseOrder:
      return 'PURCHASE_ORDER';
    case RECORD_TYPES.invoice:
      return 'INVOICE';
    default:
      throw new Error(`Unknown record type: ${recordType satisfies never}`);
  }
}

export const RECORD_TYPE_META: Record<
  WorkflowRecordType,
  { label: string; pathPrefix: string }
> = {
  estimate: { label: 'Estimate', pathPrefix: '/estimates' },
  purchase_order: { label: 'Purchase order', pathPrefix: '/purchase-orders' },
  invoice: { label: 'Invoice', pathPrefix: '/invoices' },
};
