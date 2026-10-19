import { createFileRoute } from '@tanstack/react-router';

import { PurchaseOrderRegisterPage } from '@/features/purchase-orders/purchase-order-register-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(records)/purchase-orders/')({
  component: guard('purchase_order:view', PurchaseOrderRegisterPage),
});
