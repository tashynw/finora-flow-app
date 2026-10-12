import { createFileRoute, redirect } from '@tanstack/react-router';

import { useAuth } from '@/features/auth/auth-context';
import { Navigate } from '@/lib/app-link';

function SettingsIndex() {
  const { can } = useAuth();
  return (
    <Navigate
      to={can('admin:approval_matrix') ? '/settings/approval-matrix' : '/settings/cover'}
      replace
    />
  );
}

export const Route = createFileRoute('/_app/settings/')({
  beforeLoad: ({ context }) => {
    if (context.auth.isLoading || !context.auth.user) return;
    redirect({
      throw: true,
      to: context.auth.permissions.has('admin:approval_matrix')
        ? '/settings/approval-matrix'
        : '/settings/cover',
      replace: true,
    });
  },
  component: SettingsIndex,
});
