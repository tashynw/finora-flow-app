import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, toQuery } from '@/lib/api-client';

export type ThresholdOut = {
  id: string;
  currency: string;
  applies_above_minor_units: number;
  is_active: boolean;
};

export type ThresholdUpsertBody = {
  currency: string;
  applies_above_minor_units: number;
  reason: string;
};

export type ActiveBody = {
  is_active: boolean;
  reason: string;
};

export const thresholdKeys = {
  all: ['admin', 'thresholds'] as const,
  list: (includeInactive: boolean) =>
    ['admin', 'thresholds', includeInactive ? 'all' : 'active'] as const,
};

export function useThresholds(includeInactive = true) {
  return useQuery({
    queryKey: thresholdKeys.list(includeInactive),
    queryFn: () =>
      api.get<ThresholdOut[]>(
        `/admin/thresholds${toQuery({ include_inactive: includeInactive })}`,
      ),
  });
}

export function useUpsertThreshold() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ThresholdUpsertBody) =>
      api.put<ThresholdOut>('/admin/thresholds', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: thresholdKeys.all });
    },
  });
}

export function useSetThresholdActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ActiveBody }) =>
      api.post<ThresholdOut>(`/admin/thresholds/${id}/active`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: thresholdKeys.all });
    },
  });
}
