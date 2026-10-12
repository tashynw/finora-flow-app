import { createFileRoute } from '@tanstack/react-router';

import { MatrixPage } from '@/features/administration/matrix-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/settings/approval-matrix')({
  component: guard('admin:approval_matrix', MatrixPage),
});
