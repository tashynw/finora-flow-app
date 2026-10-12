import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import '@fontsource-variable/inter';
import '@/styles/theme.css';
import { AppRouter } from '@/router';
import { AuthProvider } from '@/features/auth/auth-context';
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

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AppRouter />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
