import { createFileRoute, redirect } from '@tanstack/react-router';

import { SignInPage } from '@/features/auth/sign-in-page';
import { safeInternalPath } from '@/lib/router-context';

export const Route = createFileRoute('/sign-in')({
  beforeLoad: ({ context, location }) => {
    if (context.auth.isLoading || !context.auth.user) return;
    redirect({
      throw: true,
      href: safeInternalPath(location.state.from),
      replace: true,
    });
  },
  component: SignInPage,
});
