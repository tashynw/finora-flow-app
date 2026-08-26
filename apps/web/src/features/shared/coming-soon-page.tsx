import { CalendarClock } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/features/shared/page-header';

/**
 * Placeholder for a route whose phase has not been built.
 *
 * The release bar forbids a placeholder that pretends to work. This page offers
 * no controls at all and says plainly that the section is not available, so it
 * cannot be mistaken for a broken screen or a feature that silently fails.
 */
export function ComingSoonPage({
  title,
  deliveredBy,
}: {
  title: string;
  deliveredBy: string;
}) {
  return (
    <>
      <PageHeader
        title={title}
        purpose={`This section is part of ${deliveredBy} and has not been built yet.`}
      />
      <Card>
        <EmptyState
          icon={CalendarClock}
          title="Not available yet"
          explanation={`${title} is delivered as part of ${deliveredBy}, which is still to come in the build sequence.`}
          nextStep="Nothing is missing from your account. This section will appear here once that part of the platform is complete."
        />
      </Card>
    </>
  );
}
