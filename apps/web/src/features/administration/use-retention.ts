import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, toQuery } from '@/lib/api-client';

export type RetentionPolicyOut = {
  id: string;
  record_class: string;
  retention_days: number;
  description: string;
  is_active: boolean;
};

export type RetentionUpdateBody = {
  retention_days: number;
  reason: string;
};

export type ActiveBody = {
  is_active: boolean;
  reason: string;
};

export const retentionKeys = {
  all: ['admin', 'retention'] as const,
  list: (includeInactive: boolean) =>
    ['admin', 'retention', includeInactive ? 'all' : 'active'] as const,
};

export function useRetentionPolicies(includeInactive = true) {
  return useQuery({
    queryKey: retentionKeys.list(includeInactive),
    queryFn: () =>
      api.get<RetentionPolicyOut[]>(
        `/admin/retention${toQuery({ include_inactive: includeInactive })}`,
      ),
  });
}

export function useUpdateRetentionPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: RetentionUpdateBody }) =>
      api.patch<RetentionPolicyOut>(`/admin/retention/${id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: retentionKeys.all });
    },
  });
}

export function useSetRetentionActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ActiveBody }) =>
      api.post<RetentionPolicyOut>(`/admin/retention/${id}/active`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: retentionKeys.all });
    },
  });
}
