import { createFileRoute } from '@tanstack/react-router';

import { EstimateRegisterPage } from '@/features/estimates/estimate-register-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(records)/estimates/')({
  component: guard('estimate:view', EstimateRegisterPage),
});
