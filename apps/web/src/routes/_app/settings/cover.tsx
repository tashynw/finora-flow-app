import { createFileRoute } from '@tanstack/react-router';

import { DelegationPage } from '@/features/administration/delegation-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/settings/cover')({
  component: guard(['approval:delegate', 'admin:approval_matrix'], DelegationPage),
});
