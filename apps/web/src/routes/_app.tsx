import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';

import { AppShell } from '@/layouts/app-shell';
import { intendedPath } from '@/lib/router-context';

function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export const Route = createFileRoute('/_app')({
  beforeLoad: ({ context, location }) => {
    if (context.auth.isLoading || context.auth.user) return;
    redirect({
      throw: true,
      to: '/sign-in',
      replace: true,
      state: { from: intendedPath(location.pathname, location.searchStr) },
    });
  },
  component: AppLayout,
});
