import { createFileRoute } from '@tanstack/react-router';

import { CreditCardRegisterPage } from '@/features/credit-cards/credit-card-register-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(records)/credit-cards/')({
  component: guard('credit_card:view', CreditCardRegisterPage),
});
