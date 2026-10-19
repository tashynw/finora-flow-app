import { createFileRoute } from '@tanstack/react-router';

import { EstimateDetailPage } from '@/features/estimates/estimate-detail-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(records)/estimates/$estimateId')({
  component: guard('estimate:view', EstimateDetailPage),
});
