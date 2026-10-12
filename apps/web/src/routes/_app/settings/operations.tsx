import { createFileRoute } from '@tanstack/react-router';

import { OperationalSettingsPage } from '@/features/administration/operational-settings-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/settings/operations')({
  component: guard('admin:ai_config', OperationalSettingsPage),
});
