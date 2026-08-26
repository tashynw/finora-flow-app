import { useQuery } from '@tanstack/react-query';

import { api, toQuery } from '@/lib/api-client';

export type WorkItemOut = {
  kind: string;
  kind_label: string;
  record_id: string;
  record_path: string;
  reference: string;
  title: string;
  subtitle: string;
  waiting_since: string;
  waiting_hours: number;
  amount_formatted: string | null;
  detail: string | null;
};

export type WorkQueueOut = {
  items: WorkItemOut[];
  total: number;
  counts_by_kind: Record<string, number>;
};

export type WorkBadgesOut = {
  myWork: number;
  awaitingMyApproval: number;
  documentsNeedingReview: number;
  intakeUnprocessed: number;
  vendorNeedingReview: number;
  operationalAlerts: number;
};

export const PAGE_SIZE = 25;

export const workKeys = {
  all: ['work'] as const,
  queue: (kinds: readonly string[], page: number) =>
    ['work', 'queue', [...kinds].sort().join(','), page] as const,
  dashboard: ['work', 'dashboard'] as const,
  badges: ['work', 'badges'] as const,
};

export function useWorkQueue(kinds: readonly string[], page = 1) {
  return useQuery({
    queryKey: workKeys.queue(kinds, page),
    queryFn: () =>
      api.get<WorkQueueOut>(
        `/work/queue${toQuery({
          kind: kinds.length > 0 ? kinds : undefined,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        })}`,
      ),
    refetchOnWindowFocus: true,
  });
}

export function useWorkDashboard(limit = 5) {
  return useQuery({
    queryKey: workKeys.dashboard,
    queryFn: () => api.get<WorkQueueOut>(`/work/dashboard${toQuery({ limit })}`),
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
}

export function useWorkBadges(enabled: boolean) {
  return useQuery({
    queryKey: workKeys.badges,
    queryFn: () => api.get<WorkBadgesOut>('/work/badges'),
    enabled,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
}
