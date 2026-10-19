import { createFileRoute } from '@tanstack/react-router';

import { InvoiceDetailPage } from '@/features/invoices/invoice-detail-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(records)/invoices/$invoiceId')({
  component: guard('invoice:view', InvoiceDetailPage),
});
