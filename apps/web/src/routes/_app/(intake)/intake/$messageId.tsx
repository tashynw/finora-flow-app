import { createFileRoute } from '@tanstack/react-router';

import { MessageDetailPage } from '@/features/intake/message-detail-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(intake)/intake/$messageId')({
  component: guard('intake:view', MessageDetailPage),
});
