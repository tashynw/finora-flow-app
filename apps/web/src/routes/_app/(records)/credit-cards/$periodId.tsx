import { createFileRoute } from '@tanstack/react-router';

import { CreditCardPeriodPage } from '@/features/credit-cards/credit-card-period-page';
import { guard } from '@/lib/route-guard';

export const Route = createFileRoute('/_app/(records)/credit-cards/$periodId')({
  component: guard('credit_card:view', CreditCardPeriodPage),
});
