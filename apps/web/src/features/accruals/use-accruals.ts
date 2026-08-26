import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AccrualCandidateEdit,
  AccrualCandidateFinalize,
  AccrualCandidateOut,
  AccrualExportRequest,
  AccrualPeriodDetail,
  AccrualPeriodLock,
  AccrualPeriodOpen,
  AccrualPeriodSummary,
  AccrualStanding,
} from '@finora/shared-types';

import { API_PREFIX, api, toQuery } from '@/lib/api-client';

export const accrualKeys = {
  all: ['accruals'] as const,
  periods: (standing?: AccrualStanding) =>
    ['accruals', 'periods', standing ?? 'all'] as const,
  period: (id: string) => ['accruals', 'period', id] as const,
};

export function useAccrualPeriods(standing?: AccrualStanding) {
  return useQuery({
    queryKey: accrualKeys.periods(standing),
    queryFn: () =>
      api.get<AccrualPeriodSummary[]>(
        `/accruals/periods${toQuery({ standing })}`,
      ),
    staleTime: 10_000,
  });
}

export function useAccrualPeriod(id: string | undefined) {
  return useQuery({
    queryKey: accrualKeys.period(id ?? ''),
    queryFn: () => api.get<AccrualPeriodDetail>(`/accruals/periods/${id ?? ''}`),
    enabled: Boolean(id),
  });
}

export function useOpenAccrualPeriod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AccrualPeriodOpen) =>
      api.post<AccrualPeriodDetail>('/accruals/periods', body),
    onSuccess: (detail) => {
      queryClient.setQueryData(accrualKeys.period(detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: ['accruals', 'periods'] });
    },
  });
}

export function useGenerateCandidates(periodId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<AccrualPeriodDetail>(
        `/accruals/periods/${periodId ?? ''}/candidates/generate`,
      ),
    onSuccess: (detail) => {
      queryClient.setQueryData(accrualKeys.period(detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: ['accruals', 'periods'] });
    },
  });
}

export function useEditCandidate(periodId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      candidateId,
      body,
    }: {
      candidateId: string;
      body: AccrualCandidateEdit;
    }) =>
      api.patch<AccrualCandidateOut>(`/accruals/candidates/${candidateId}`, body),
    onSuccess: () => {
      if (periodId) {
        void queryClient.invalidateQueries({ queryKey: accrualKeys.period(periodId) });
      }
      void queryClient.invalidateQueries({ queryKey: ['accruals', 'periods'] });
    },
  });
}

export function useFinalizeCandidate(periodId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      candidateId,
      body,
    }: {
      candidateId: string;
      body: AccrualCandidateFinalize;
    }) =>
      api.post<AccrualCandidateOut>(`/accruals/candidates/${candidateId}/finalize`, body),
    onSuccess: () => {
      if (periodId) {
        void queryClient.invalidateQueries({ queryKey: accrualKeys.period(periodId) });
      }
      void queryClient.invalidateQueries({ queryKey: ['accruals', 'periods'] });
    },
  });
}

export function useLockPeriod(periodId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AccrualPeriodLock) =>
      api.post<AccrualPeriodDetail>(`/accruals/periods/${periodId ?? ''}/lock`, body),
    onSuccess: (detail) => {
      queryClient.setQueryData(accrualKeys.period(detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: ['accruals', 'periods'] });
    },
  });
}

/**
 * Export a period as a file download.
 *
 * The API returns a binary response with the filename in X-Finora-Export-*
 * headers, so this mutation bypasses the JSON api client and uses fetch
 * directly to stream the blob into a browser download.
 */
export function useExportPeriod(periodId: string | undefined) {
  return useMutation({
    mutationFn: async (body: AccrualExportRequest) => {
      const response = await fetch(
        `${API_PREFIX}/accruals/periods/${periodId ?? ''}/export`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        const text = await response.text();
        let detail = 'Export failed. Please try again.';
        try {
          detail = (JSON.parse(text) as { detail?: string }).detail ?? detail;
        } catch {
          // The response was not JSON — keep the generic message.
        }
        throw new Error(detail);
      }
      const blob = await response.blob();
      const filename =
        response.headers.get('X-Finora-Export-Filename') ??
        response.headers
          .get('content-disposition')
          ?.match(/filename="?([^";]+)"?/)?.[1] ??
        `accruals-export.${body.format}`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    },
  });
}
