import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, toQuery } from '@/lib/api-client';

export type AuditEntryOut = {
  sequence: number;
  entry_hash: string;
  previous_hash: string;
  occurred_at: string;
  action: string;
  actor_type: string;
  actor_label: string;
  actor_id: string | null;
  subject_type: string;
  subject_id: string | null;
  correlation_id: string | null;
  detail: Record<string, unknown>;
};

export type AuditEntryPage = {
  items: AuditEntryOut[];
  total: number;
  limit: number;
  offset: number;
};

export type AuditVerifyResult = {
  ok: boolean;
  checked_count: number;
  first_bad_sequence: number | null;
  message: string;
  reason: string | null;
};

export const PAGE_SIZE = 50;

export type AuditFilters = {
  action?: string | undefined;
  subject_type?: string | undefined;
};

export const auditKeys = {
  all: ['audit'] as const,
  page: (filters: AuditFilters, page: number) =>
    ['audit', 'entries', filters.action ?? '', filters.subject_type ?? '', page] as const,
};

export function useAuditEntries(filters: AuditFilters, page = 1) {
  return useQuery({
    queryKey: auditKeys.page(filters, page),
    queryFn: () =>
      api.get<AuditEntryPage>(
        `/audit/entries${toQuery({
          action: filters.action || undefined,
          subject_type: filters.subject_type || undefined,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        })}`,
      ),
  });
}

export function useVerifyAuditChain() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { start_sequence?: number; limit?: number }) =>
      api.post<AuditVerifyResult>('/audit/verify', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: auditKeys.all });
    },
  });
}
