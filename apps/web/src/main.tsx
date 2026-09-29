import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import '@fontsource-variable/inter';
import '@/styles/theme.css';
import { App } from '@/App';
import { AuthProvider } from '@/features/auth/auth-context';
import { VendorCheckInPage } from '@/features/vendor-confirmations/vendor-check-in-page';
import { ApiError } from '@/lib/api-client';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Financial data must not be silently stale while someone decides on it.
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        // Retrying an authorization failure cannot succeed and only delays the
        // message the user needs to read.
        if (error instanceof ApiError && (error.isUnauthenticated || error.isForbidden)) {
          return false;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      // A financial action is never retried automatically; a duplicate approval
      // or payment is far worse than an error the user can retry deliberately.
      retry: false,
    },
  },
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element is missing from index.html');
}

/**
 * A data router holding the application and, beside it, the supplier's page.
 *
 * The application's own route tree stays where it is readable, as JSX inside
 * `App`. What a data router adds here is navigation blocking: `useBlocker` is
 * only wired up by this kind of router, and without it a half-typed estimate is
 * lost the moment somebody clicks the sidebar. Loaders and actions are
 * deliberately not adopted; server state belongs to React Query, which every
 * screen already uses.
 *
 * The check-in route is a sibling of the application rather than a route inside
 * it, and sits outside `AuthProvider` on purpose. A supplier has no account, so
 * asking "who is signed in" before showing them anything would delay the page
 * on a request that is going to answer nobody. Keeping it out here also means
 * the page cannot acquire the shell, a redirect to sign in, or a permission
 * check by accident later: none of that machinery is above it.
 */
const router = createBrowserRouter([
  {
    path: '/payment-check-in/:token',
    element: <VendorCheckInPage />,
  },
  {
    path: '*',
    element: (
      <AuthProvider>
        <App />
      </AuthProvider>
    ),
  },
]);

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
