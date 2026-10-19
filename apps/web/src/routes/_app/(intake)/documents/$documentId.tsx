import { createFileRoute } from '@tanstack/react-router';

import { DocumentReviewPage } from '@/features/documents/document-review-page';
import { guard } from '@/lib/route-guard';

// Reading a document is a different right from seeing that one exists.

export const Route = createFileRoute('/_app/(intake)/documents/$documentId')({
  component: guard('extraction:view', DocumentReviewPage),
});
