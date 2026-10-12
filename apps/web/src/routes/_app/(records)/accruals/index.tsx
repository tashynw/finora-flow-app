import { createFileRoute } from '@tanstack/react-router';

import { AccrualRegisterPage } from '@/features/accruals/accrual-register-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(records)/accruals/')({
  component: guard('accrual:view', AccrualRegisterPage),
});
