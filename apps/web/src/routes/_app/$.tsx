import { createFileRoute } from '@tanstack/react-router';

import { NotFoundPage } from '@/features/shared/not-found-page';

export const Route = createFileRoute('/_app/$')({
  component: NotFoundPage,
});
