/**
 * Reports hub — deep links to export and review surfaces.
 *
 * This is not an analytics dashboard. Full charts are not claimed; each card opens
 * an existing register, trail or queue where exports and review already live.
 */

import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { PageHeader } from '@/features/shared/page-header';
import { useAuth } from '@/features/auth/auth-context';

type ReportLink = {
  to: string;
  title: string;
  description: string;
  permission: string;
};

const REPORT_LINKS: ReportLink[] = [
  {
    to: '/audit',
    title: 'Audit trail',
    description: 'Every decision, export and configuration change.',
    permission: 'audit:view',
  },
  {
    to: '/payments',
    title: 'Payment manifests',
    description: 'Payment packages and the manifests downloaded for bank submission.',
    permission: 'payment:view',
  },
  {
    to: '/accruals',
    title: 'Accrual exports',
    description: 'Month-end registers and finalized export packs, by period.',
    permission: 'accrual:view',
  },
  {
    to: '/work',
    title: 'My work queue',
    description: 'Everything waiting on you — approvals, reviews and confirmations.',
    permission: 'report:view',
  },
  {
    to: '/credit-cards',
    title: 'Credit-card periods',
    description: 'Open and closed statement periods, with coding progress.',
    permission: 'credit_card:view',
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
        purpose="Operational reports and finance control outputs."
      />

      {links.length === 0 ? (
        <p className="m-0 text-[length:var(--text-body)] text-[var(--color-text-muted)]">
          No report destinations are available with your current access. Contact an
          administrator if you need export or review rights.
        </p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 gap-[var(--space-4)] p-0 md:grid-cols-2">
          {links.map((link) => (
            <li key={link.to}>
              <Link
                to={link.to}
                className={cn(
                  'surface-card group motion-interactive flex h-full flex-col px-[var(--space-4)] py-[var(--space-4)]',
                  'no-underline hover:border-[var(--color-primary-600)]',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]',
                )}
              >
                <span className="text-[14px] font-semibold text-[var(--color-text-strong)]">
                  {link.title}
                </span>
                <span className="mt-1.5 text-[12px] text-[var(--color-text-muted)]">
                  {link.description}
                </span>
                <span className="mt-auto inline-flex items-center gap-1 pt-[var(--space-4)] text-[12px] font-medium text-[var(--color-primary-600)] group-hover:underline">
                  Open report
                  <ArrowRight aria-hidden="true" className="size-3.5" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
