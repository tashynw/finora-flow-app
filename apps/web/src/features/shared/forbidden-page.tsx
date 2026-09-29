import { useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * Shown when a signed-in user reaches a section their roles do not cover.
 *
 * The message says what to do next without revealing whether any records exist
 * behind it, so this page cannot be used to probe for information.
 */
export function ForbiddenPage() {
  const navigate = useNavigate();

  return (
    <Card>
      <EmptyState
        titleAs="h1"
        icon={Lock}
        title="You do not have access to this section"
        explanation="Your current roles do not include this part of the platform."
        nextStep="If you need access for your work, ask an administrator to review your roles."
        action={{
          label: 'Go to dashboard',
          onClick: () => {
            void navigate('/');
          },
        }}
      />
    </Card>
  );
}
