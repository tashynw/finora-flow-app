import { createFileRoute } from '@tanstack/react-router';

import { VendorConfirmationDetailPage } from '@/features/vendor-confirmations/vendor-confirmation-detail-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(records)/vendor-confirmations/$checkInId')({
  component: guard('vendor:confirmation_review', VendorConfirmationDetailPage),
});
