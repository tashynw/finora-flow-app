import { createFileRoute } from '@tanstack/react-router';

import { WorkQueuePage } from '@/features/work/work-queue-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(overview)/work')({
  component: guard('report:view', WorkQueuePage),
});
