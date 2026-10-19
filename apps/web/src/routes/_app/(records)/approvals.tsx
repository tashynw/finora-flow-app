import { createFileRoute } from '@tanstack/react-router';

import { ApprovalQueuePage } from '@/features/approvals/approval-queue-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(records)/approvals')({
  component: guard('approval:view', ApprovalQueuePage),
});
