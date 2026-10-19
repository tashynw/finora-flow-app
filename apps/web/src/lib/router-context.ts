import type { CurrentUser } from '@/features/auth/auth-context';

export interface RouterAuth {
  user: CurrentUser | null;
  isLoading: boolean;
  permissions: ReadonlySet<string>;
}

export interface RouterContext {
  auth: RouterAuth;
}

/**
 * Only a path within this application is ever followed. An absolute URL would
 * be an open redirect, and this value is reachable from a link somebody else
 * composed.
 */
export function safeInternalPath(from: unknown): string {
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/';
}

export function intendedPath(pathname: string, search: string): string {
  return pathname + search;
}
