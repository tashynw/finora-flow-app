import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, toQuery } from '@/lib/api-client';

export type SavedViewOut = {
  id: string;
  scope: string;
  name: string;
  definition: Record<string, unknown>;
  is_default: boolean;
};

export type SavedViewCreateBody = {
  scope: string;
  name: string;
  definition: Record<string, unknown>;
  is_default?: boolean;
};

export const savedViewKeys = {
  all: ['saved-views'] as const,
  scope: (scope: string) => ['saved-views', scope] as const,
};

export function useSavedViews(scope: string) {
  return useQuery({
    queryKey: savedViewKeys.scope(scope),
    queryFn: () =>
      api.get<SavedViewOut[]>(`/saved-views${toQuery({ scope })}`),
  });
}

export function useCreateSavedView() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SavedViewCreateBody) =>
      api.post<SavedViewOut>('/saved-views', body),
    onSuccess: (row) => {
      void queryClient.invalidateQueries({
        queryKey: savedViewKeys.scope(row.scope),
      });
    },
  });
}

export function useDeleteSavedView(scope: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (viewId: string) => api.delete(`/saved-views/${viewId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: savedViewKeys.scope(scope),
      });
    },
  });
}
