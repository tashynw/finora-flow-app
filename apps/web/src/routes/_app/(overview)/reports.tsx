import { createFileRoute } from '@tanstack/react-router';

import { ReportsPage } from '@/features/reports/reports-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(overview)/reports')({
  component: guard('report:view', ReportsPage),
});
