import { useEffect } from 'react';
import { createRouter, RouterProvider } from '@tanstack/react-router';

import { useAuth } from '@/features/auth/auth-context';
import { routeTree } from '@/routeTree.gen';

/**
 * Routing.
 *
 * The route files under `src/routes` are the source of truth. The Vite plugin
 * generates `routeTree.gen.ts` from them. Client-side permission checks keep a
 * user out of a screen they cannot use; the API's check is what actually
 * protects the data. The browser still talks to the original Python API
 * through the Vite proxy on port 8000.
 */

export const router = createRouter({
  routeTree,
  context: {
    auth: {
      user: null,
      isLoading: true,
      permissions: new Set<string>(),
    },
  },
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

declare module '@tanstack/history' {
  interface HistoryState {
    /** Where a signed-out visitor was trying to go. Kept out of the URL. */
    from?: string;
  }
}

export function AppRouter() {
  const auth = useAuth();

  // beforeLoad reads router context, which only refreshes when the router is
  // invalidated. The session query settling is that moment.
  useEffect(() => {
    void router.invalidate();
  }, [auth.user, auth.isLoading]);

  return (
    <RouterProvider
      router={router}
      context={{
        auth: {
          user: auth.user,
          isLoading: auth.isLoading,
          permissions: new Set(auth.user?.permissions ?? []),
        },
      }}
    />
  );
}
