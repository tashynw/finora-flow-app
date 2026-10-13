import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { nestApi, toQuery } from '@/lib/api-client';

export type DepartmentOut = {
  id: string;
  name: string;
  costCentreNumber: string;
  isActive: boolean;
};

export type DepartmentWrite = {
  name: string;
  costCentreNumber: string;
};

export const departmentKeys = {
  all: ['departments'] as const,
  list: (includeInactive: boolean) => ['departments', includeInactive] as const,
};

export function useDepartments(includeInactive: boolean, enabled = true) {
  return useQuery({
    queryKey: departmentKeys.list(includeInactive),
    queryFn: () =>
      nestApi.get<DepartmentOut[]>(
        `/departments${toQuery({ includeInactive })}`,
      ),
    enabled,
  });
}

export function useCreateDepartment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DepartmentWrite) => nestApi.post<DepartmentOut>('/departments', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: departmentKeys.all });
    },
  });
}

export function useUpdateDepartment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: DepartmentWrite }) =>
      nestApi.put<DepartmentOut>(`/departments/${id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: departmentKeys.all });
    },
  });
}

export function useSetDepartmentActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      nestApi.post<DepartmentOut>(`/departments/${id}/active`, { isActive }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: departmentKeys.all });
    },
  });
}
