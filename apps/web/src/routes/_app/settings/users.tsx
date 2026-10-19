import { createFileRoute } from '@tanstack/react-router';

import { UsersPage } from '@/features/administration/users-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/settings/users')({
  component: guard('admin:users', UsersPage),
});
