import { createFileRoute } from '@tanstack/react-router';

import { VendorConfirmationRegisterPage } from '@/features/vendor-confirmations/vendor-confirmation-register-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(records)/vendor-confirmations/')({
  component: guard('vendor:confirmation_review', VendorConfirmationRegisterPage),
});
