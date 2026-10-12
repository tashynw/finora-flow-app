import { createFileRoute } from '@tanstack/react-router';

import { PurchaseOrderDetailPage } from '@/features/purchase-orders/purchase-order-detail-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(records)/purchase-orders/$orderId')({
  component: guard('purchase_order:view', PurchaseOrderDetailPage),
});
