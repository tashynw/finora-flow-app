import { useNavigate } from 'react-router-dom';
import { FileQuestion } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';

export function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <Card>
      <EmptyState
        icon={FileQuestion}
        title="That page does not exist"
        explanation="The address may have been mistyped, or the record may have been moved or archived."
        nextStep="Check the link, or return to your dashboard to find what you need."
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
