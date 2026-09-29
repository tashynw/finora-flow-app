import type { RegisterSummaryOut } from '@finora/shared-types';

import { StatCards, type StatCardItem } from '@/components/ui/stat-cards';

/**
 * StatBand.
 *
 * A register's headline figures as a row of stat cards, all from one
 * whole-dataset aggregate. The API supplies up to three figures; the fourth
 * card is the work still in sign-off or approval, read from the same status
 * mix. It shows nothing the API did not count, and an absent summary renders
 * quiet skeletons.
 */
export function StatBand({
  summary,
  isLoading,
  className,
  meta,
}: {
  summary: RegisterSummaryOut | undefined;
  isLoading?: boolean;
  className?: string;
  /** One line under each figure, keyed by the stat key. */
  meta?: Record<string, string>;
}) {
  if (!summary) {
    return <StatCards items={[]} isLoading={isLoading ?? false} className={className} />;
  }

  const items: StatCardItem[] = summary.stats.map((stat) => ({
    key: stat.key,
    label: stat.label,
    value: stat.value,
    meta: meta?.[stat.key],
  }));

  const pending = summary.status_mix.find((slice) => slice.tone === 'primary');
  if (items.length < 4 && pending) {
    items.push({
      key: 'pending',
      label: 'Pending',
      value: pending.count,
      meta: `${pending.label} now`,
    });
  }

  return <StatCards items={items} className={className} />;
}
