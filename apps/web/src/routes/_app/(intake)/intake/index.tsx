import { createFileRoute } from '@tanstack/react-router';

import { IntakeQueuePage } from '@/features/intake/intake-queue-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(intake)/intake/')({
  component: guard('intake:view', IntakeQueuePage),
});
