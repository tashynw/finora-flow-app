import { createFileRoute } from '@tanstack/react-router';

import { ThresholdsPage } from '@/features/administration/thresholds-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/settings/thresholds')({
  component: guard('admin:thresholds', ThresholdsPage),
});
