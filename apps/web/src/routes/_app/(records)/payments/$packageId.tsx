import { createFileRoute } from '@tanstack/react-router';

import { PaymentPackageDetailPage } from '@/features/payments/payment-package-detail-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(records)/payments/$packageId')({
  component: guard('payment:view', PaymentPackageDetailPage),
});
