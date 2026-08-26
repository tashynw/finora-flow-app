import { createContext, useCallback, useContext, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AuthMethodsResponse,
  CurrentUserResponse,
} from '@finora/shared-types';

import { api, ApiError } from '@/lib/api-client';
import { useWorkBadges } from '@/features/work/use-work';

// Generated from the API's OpenAPI schema, so a contract change breaks the
// build here rather than surfacing as an undefined field at runtime.
export type CurrentUser = CurrentUserResponse;
export type AuthMethods = AuthMethodsResponse;

interface AuthContextValue {
  user: CurrentUser | null;
  isLoading: boolean;
  methods: AuthMethods | null;
  signIn: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  can: (permission: string) => boolean;
  /** Counts of work awaiting this user, keyed by nav badge. */
  badges: Record<string, number>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();

  const userQuery = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => api.get<CurrentUser>('/auth/me'),
    // A 401 is the expected answer for a signed-out visitor, not a fault, so it
    // must not be retried into a delay before the login screen appears.
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.isUnauthenticated) && failureCount < 2,
    staleTime: 60_000,
  });

  const methodsQuery = useQuery({
    queryKey: ['auth', 'methods'],
    queryFn: () => api.get<AuthMethods>('/auth/methods'),
    staleTime: 5 * 60_000,
  });

  const user =
    userQuery.data ??
    (userQuery.error instanceof ApiError && userQuery.error.isUnauthenticated
      ? null
      : (userQuery.data ?? null));

  const badgesQuery = useWorkBadges(Boolean(user?.permissions.includes('report:view')));

  const signInMutation = useMutation({
    mutationFn: (email: string) =>
      api.post<CurrentUser>('/auth/local/sign-in', { email }),
    onSuccess: (signedIn) => {
      queryClient.setQueryData(['auth', 'me'], signedIn);
      void queryClient.invalidateQueries({ queryKey: ['work'] });
    },
  });

  const signOutMutation = useMutation({
    mutationFn: () => api.post<void>('/auth/sign-out'),
    onSuccess: () => {
      // Every cached query was fetched under the previous identity, so none of
      // it may be shown to whoever signs in next.
      queryClient.clear();
      queryClient.setQueryData(['auth', 'me'], null);
    },
  });

  const permissionSet = useMemo(
    () => new Set(user?.permissions ?? []),
    [user?.permissions],
  );

  const can = useCallback(
    (permission: string) => permissionSet.has(permission),
    [permissionSet],
  );

  const signIn = useCallback(
    async (email: string) => {
      await signInMutation.mutateAsync(email);
    },
    [signInMutation],
  );

  const signOut = useCallback(async () => {
    await signOutMutation.mutateAsync();
  }, [signOutMutation]);

  const badges = useMemo(() => {
    const data = badgesQuery.data;
    if (!data) return {};
    return {
      myWork: data.myWork,
      awaitingMyApproval: data.awaitingMyApproval,
      documentsNeedingReview: data.documentsNeedingReview,
      intakeUnprocessed: data.intakeUnprocessed,
      vendorNeedingReview: data.vendorNeedingReview,
      operationalAlerts: data.operationalAlerts,
    };
  }, [badgesQuery.data]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading: userQuery.isLoading,
      methods: methodsQuery.data ?? null,
      signIn,
      signOut,
      can,
      badges,
    }),
    [user, userQuery.isLoading, methodsQuery.data, signIn, signOut, can, badges],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside an AuthProvider.');
  }
  return context;
}
