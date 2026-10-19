import { createContext, useCallback, useContext, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { CurrentUserResponse } from '@finora/shared-types';

import { authClient } from '@/lib/auth-client';
import { useWorkBadges } from '@/features/work/use-work';
import { permissionsForRoles, rolesFromField } from '@/features/auth/role-permissions';

export type CurrentUser = CurrentUserResponse;

interface AuthContextValue {
  user: CurrentUser | null;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  can: (permission: string) => boolean;
  /** Counts of work awaiting this user, keyed by nav badge. */
  badges: Record<string, number>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const sessionKey = ['auth', 'session'] as const;

function toCurrentUser(
  sessionUser: {
    id: string;
    email: string;
    name: string;
    role?: string | null;
  } | null,
): CurrentUser | null {
  if (!sessionUser) return null;
  const roles = rolesFromField(sessionUser.role);
  return {
    id: sessionUser.id,
    email: sessionUser.email,
    display_name: sessionUser.name,
    department: null,
    roles,
    permissions: permissionsForRoles(roles),
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();

  // The supplier page has no account. Asking who is signed in would hold that
  // screen on a request that is going to answer nobody, so the session call
  // stays off while the address is a check-in link.
  const supplierPage =
    typeof window !== 'undefined' &&
    window.location.pathname.startsWith('/payment-check-in/');

  const sessionQuery = useQuery({
    queryKey: sessionKey,
    queryFn: async () => {
      const result = await authClient.getSession();
      if (result.error) {
        throw new Error(result.error.message ?? 'The session could not be loaded.');
      }
      return result.data;
    },
    enabled: !supplierPage,
    staleTime: 60_000,
  });

  const user = toCurrentUser(sessionQuery.data?.user ?? null);

  const badgesQuery = useWorkBadges(Boolean(user?.permissions.includes('report:view')));

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await authClient.signIn.email({
        email,
        password,
        rememberMe: true,
      });
      if (result.error) {
        throw new Error(result.error.message ?? 'Sign-in could not be completed.');
      }
      const session = await authClient.getSession();
      queryClient.setQueryData(sessionKey, session.data ?? null);
      void queryClient.invalidateQueries({ queryKey: ['work'] });
    },
    [queryClient],
  );

  const signOut = useCallback(async () => {
    const result = await authClient.signOut();
    if (result.error) {
      throw new Error(result.error.message ?? 'Sign-out could not be completed.');
    }
    // Every cached query was fetched under the previous identity, so none of
    // it may be shown to whoever signs in next.
    queryClient.clear();
    queryClient.setQueryData(sessionKey, null);
  }, [queryClient]);

  const permissionSet = useMemo(
    () => new Set(user?.permissions ?? []),
    [user?.permissions],
  );

  const can = useCallback(
    (permission: string) => permissionSet.has(permission),
    [permissionSet],
  );

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
      isLoading: sessionQuery.isLoading,
      signIn,
      signOut,
      can,
      badges,
    }),
    [user, sessionQuery.isLoading, signIn, signOut, can, badges],
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
