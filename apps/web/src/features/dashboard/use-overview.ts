import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api-client';

export type MoneyOut = {
  minor_units: number;
  currency: string;
  formatted: string;
};

export type OverviewTone =
  | 'neutral'
  | 'primary'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger';

export type KpiOut = {
  key: string;
  label: string;
  value: number;
  hint: string;
  tone: OverviewTone;
  money: MoneyOut | null;
};

export type SliceOut = {
  label: string;
  count: number;
  tone: OverviewTone;
};

export type TrendOut = {
  label: string;
  invoices: number;
  estimates: number;
};

export type SpendCardOut = {
  key: string;
  label: string;
  hint: string;
  tone: OverviewTone;
  money: MoneyOut | null;
  count: number | null;
  delta_pct: number | null;
  month_money: MoneyOut | null;
  previous_money: MoneyOut | null;
  series: number[];
};

export type MonthlySpendOut = {
  label: string;
  invoices: number;
  purchase_orders: number;
  credit_cards: number;
  accruals: number;
};

export type VendorSpendOut = {
  name: string;
  money: MoneyOut;
  share: number;
};

export type ActivityOut = {
  kind: string;
  kind_label: string;
  reference: string;
  title: string;
  state_label: string;
  tone: OverviewTone;
  when: string;
  amount_formatted: string | null;
};

export type ApprovalPerformanceOut = {
  decided: number;
  avg_hours: number | null;
  approval_rate: number | null;
};

export type OverviewOut = {
  generated_at: string;
  primary_currency: string;
  kpis: KpiOut[];
  spend_cards: SpendCardOut[];
  top_vendors: VendorSpendOut[];
  recent_activity: ActivityOut[];
  approval_performance: ApprovalPerformanceOut;
  invoice_states: SliceOut[];
  aging: SliceOut[];
  monthly_activity: TrendOut[];
  monthly_spend: MonthlySpendOut[];
};

export const overviewKeys = {
  metrics: (months: number) => ['overview', 'metrics', months] as const,
};

export function useOverview(enabled: boolean, months = 6) {
  return useQuery({
    queryKey: overviewKeys.metrics(months),
    queryFn: () => api.get<OverviewOut>(`/overview/metrics?months=${months}`),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    placeholderData: (previous) => previous,
  });
}
