import { createFileRoute } from '@tanstack/react-router';

import { AccrualPeriodPage } from '@/features/accruals/accrual-period-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(records)/accruals/$periodId')({
  component: guard('accrual:view', AccrualPeriodPage),
});
