import { createFileRoute } from '@tanstack/react-router';

import { RetentionPage } from '@/features/administration/retention-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/settings/retention')({
  component: guard('admin:retention', RetentionPage),
});
