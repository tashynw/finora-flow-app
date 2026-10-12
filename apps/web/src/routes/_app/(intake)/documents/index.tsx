import { createFileRoute } from '@tanstack/react-router';

import { DocumentQueuePage } from '@/features/documents/document-queue-page';
import { guard } from '@/lib/route-guard';

// Reading a document is a different right from seeing that one exists.

export const Route = createFileRoute('/_app/(intake)/documents/')({
  component: guard('extraction:view', DocumentQueuePage),
});
