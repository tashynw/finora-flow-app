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

export type OverviewOut = {
  generated_at: string;
  primary_currency: string;
  kpis: KpiOut[];
  invoice_states: SliceOut[];
  aging: SliceOut[];
  monthly_activity: TrendOut[];
};

export const overviewKeys = {
  metrics: ['overview', 'metrics'] as const,
};

export function useOverview(enabled: boolean) {
  return useQuery({
    queryKey: overviewKeys.metrics,
    queryFn: () => api.get<OverviewOut>('/overview/metrics'),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
