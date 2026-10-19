import { createFileRoute } from '@tanstack/react-router';

import { IntakeOperationsPage } from '@/features/intake/intake-operations-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(system)/operations/intake')({
  component: guard('operations:view', IntakeOperationsPage),
});
