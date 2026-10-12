import type { ReactNode } from 'react';

import { useAuth } from '@/features/auth/auth-context';
import { ForbiddenPage } from '@/features/shared/forbidden-page';

type PageComponent = () => ReactNode;

/** Any one of the named permissions is enough, matching the screens that accept either. */
export function guard(
  permission: string | readonly string[],
  Page: PageComponent,
): PageComponent {
  const names = typeof permission === 'string' ? [permission] : permission;
  return function PermissionGate() {
    const { can } = useAuth();
    if (!names.some((name) => can(name))) return <ForbiddenPage />;
    return <Page />;
  };
}
