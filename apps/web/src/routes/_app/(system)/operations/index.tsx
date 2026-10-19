import { createFileRoute } from '@tanstack/react-router';

import { SystemHealthPage } from '@/features/operations/system-health-page';

export const Route = createFileRoute('/_app/(system)/operations/')({
  component: SystemHealthPage,
});
