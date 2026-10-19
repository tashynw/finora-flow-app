import { createFileRoute } from '@tanstack/react-router';

import { AuditTrailPage } from '@/features/audit/audit-trail-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(system)/audit')({
  component: guard('audit:view', AuditTrailPage),
});
