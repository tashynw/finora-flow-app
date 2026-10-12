import { createFileRoute } from '@tanstack/react-router';

import { InvoiceRegisterPage } from '@/features/invoices/invoice-register-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(records)/invoices/')({
  component: guard('invoice:view', InvoiceRegisterPage),
});
