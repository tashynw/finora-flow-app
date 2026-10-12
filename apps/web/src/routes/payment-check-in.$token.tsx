import { createFileRoute } from '@tanstack/react-router';

import { VendorCheckInPage } from '@/features/vendor-confirmations/vendor-check-in-page';

/**
 * A supplier has no account. This route sits beside the signed-in tree so it
 * cannot pick up the shell or a sign-in redirect.
 */
export const Route = createFileRoute('/payment-check-in/$token')({
  component: VendorCheckInPage,
});
