import { createFileRoute } from '@tanstack/react-router';

import { ReferenceDataPage } from '@/features/administration/reference-data-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/settings/reference')({
  component: guard('admin:reference_data', ReferenceDataPage),
});
