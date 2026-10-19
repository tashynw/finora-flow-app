import { Outlet, createRootRouteWithContext, useRouterState } from '@tanstack/react-router';

import { FinoraMark } from '@/components/brand/finora-mark';
import { useAuth } from '@/features/auth/auth-context';
import { Navigate } from '@/lib/app-link';
import { intendedPath, safeInternalPath, type RouterContext } from '@/lib/router-context';

export type { RouterContext };

function CheckingSession() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-dvh flex-col items-center justify-center gap-4"
    >
      <FinoraMark showWordmark />
      <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
        Checking your session
      </p>
    </div>
  );
}

/**
 * Session gate that reads the live auth context.
 *
 * `beforeLoad` sees the router context from the last time the router was
 * invalidated. This component sees the session as soon as the query settles,
 * so a signed-out visitor is never shown the shell while that catch-up runs.
 */
function RootLayout() {
  const { user, isLoading } = useAuth();
  const location = useRouterState({ select: (state) => state.location });
  const supplier = location.pathname.startsWith('/payment-check-in/');
  const signingIn = location.pathname === '/sign-in';
  const resettingPassword = location.pathname === '/reset-password';
  const forgotPassword = location.pathname === '/forgot-password';
  const publicPage = supplier || signingIn || resettingPassword || forgotPassword;

  if (!publicPage && isLoading) return <CheckingSession />;

  if (!publicPage && !user) {
    return (
      <Navigate
        to="/sign-in"
        replace
        state={{ from: intendedPath(location.pathname, location.searchStr) }}
      />
    );
  }

  if (user && signingIn) {
    return <Navigate to={safeInternalPath(location.state.from)} replace />;
  }

  return <Outlet />;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});
