import { createFileRoute } from '@tanstack/react-router';

import { SignedLinkPage } from '@/features/invoices/signed-link-page';

/**
 * Not permission-gated. The token names a destination, not a right, and the
 * page it lands on fetches the record through the ordinary authenticated
 * endpoint — which is where authority is decided. Gating the landing itself
 * would tell a holder which tokens are real.
 */
export const Route = createFileRoute('/_app/(records)/link/$token')({
  component: SignedLinkPage,
});
