import { createFileRoute } from '@tanstack/react-router';

import { PaymentPackageRegisterPage } from '@/features/payments/payment-package-register-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(records)/payments/')({
  component: guard('payment:view', PaymentPackageRegisterPage),
});
