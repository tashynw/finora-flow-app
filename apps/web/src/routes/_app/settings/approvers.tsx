import { createFileRoute } from '@tanstack/react-router';

import { AssignmentsPage } from '@/features/administration/assignments-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/settings/approvers')({
  component: guard('admin:approval_matrix', AssignmentsPage),
});
