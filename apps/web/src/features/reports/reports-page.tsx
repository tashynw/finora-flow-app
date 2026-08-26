/**
 * Reports hub — deep links to export and review surfaces.
 *
 * This is not an analytics dashboard. Full charts are not claimed; each card opens
 * an existing register, trail or queue where exports and review already live.
 */

import { Link } from 'react-router-dom';
import {
  CalendarClock,
  ChevronRight,
  CreditCard,
  FileCheck2,
  ScrollText,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { PageHeader } from '@/features/shared/page-header';
import { useAuth } from '@/features/auth/auth-context';

type ReportLink = {
  to: string;
  title: string;
  description: string;
  permission: string;
  icon: LucideIcon;
};

const REPORT_LINKS: ReportLink[] = [
  {
    to: '/audit',
    title: 'Audit trail',
    description: 'The complete record of decisions, exports and configuration changes.',
    permission: 'audit:view',
    icon: ScrollText,
  },
  {
    to: '/payments',
    title: 'Payment packages / manifests',
    description: 'Open packages and download payment manifests for bank submission.',
    permission: 'payment:view',
    icon: Wallet,
  },
  {
    to: '/accruals',
    title: 'Accrual exports',
    description: 'Period registers and finalized accrual export packs.',
    permission: 'accrual:view',
    icon: CalendarClock,
  },
  {
    to: '/work',
    title: 'My work queue',
    description: 'Items waiting on you — approvals, reviews and confirmations.',
    permission: 'report:view',
    icon: FileCheck2,
  },
  {
    to: '/credit-cards',
    title: 'Credit-card periods',
    description: 'Statement periods, coding progress and period close.',
    permission: 'credit_card:view',
    icon: CreditCard,
  },
];

/**
 * Export and review hub.
 *
 * Each link is gated by the same permission the destination route already
 * requires. Cards the signed-in user cannot open are simply not shown.
 */
export function ReportsPage() {
  const { can } = useAuth();
  const links = REPORT_LINKS.filter((link) => can(link.permission));

  return (
    <>
      <PageHeader
        title="Reports"
        purpose="Export and review surfaces that already exist in Finora — audit trail, payment manifests, accrual packs, your work queue and credit-card periods. Analytics charts are not part of this hub."
      />

      {links.length === 0 ? (
        <p className="m-0 text-[var(--text-body)] text-[var(--color-text-muted)]">
          No report destinations are available with your current access. Contact an
          administrator if you need export or review rights.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-[var(--space-3)] p-0">
          {links.map((link) => (
            <li key={link.to}>
              <Link
                to={link.to}
                className={cn(
                  'motion-interactive flex items-start gap-[var(--space-4)]',
                  'rounded-[var(--radius-md)] border border-[var(--color-border)]',
                  'bg-[var(--color-surface)] px-[var(--space-5)] py-[var(--space-4)]',
                  'no-underline hover:bg-[var(--color-surface-subtle)]',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]',
                    'bg-[var(--color-primary-50)] text-[var(--color-primary-700)]',
                  )}
                >
                  <link.icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-[var(--color-text-strong)]">
                    {link.title}
                  </span>
                  <span className="mt-1 block text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                    {link.description}
                  </span>
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="mt-1 size-5 shrink-0 text-[var(--color-text-subtle)]"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
