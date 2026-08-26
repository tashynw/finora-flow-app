import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  ApprovalAssignmentOut,
  ApprovalDelegationOut,
  ApprovalLevel,
  MatrixOut,
  MatrixRuleRequest,
  RoutePreviewOut,
} from '@finora/shared-types';

import { api, toQuery } from '@/lib/api-client';

export const adminKeys = {
  matrix: (recordType: string, includeRetired: boolean) =>
    ['admin', 'matrix', recordType, includeRetired] as const,
  preview: (recordType: string, amount: string, currency: string, department: string) =>
    ['admin', 'preview', recordType, amount, currency, department] as const,
  assignments: ['admin', 'assignments'] as const,
  delegations: ['admin', 'delegations'] as const,
};

/** The record types that have an approval matrix of their own. */
export const RECORD_TYPES = [
  { id: 'estimate', label: 'Estimates' },
  { id: 'invoice', label: 'Invoices' },
  { id: 'purchase_order', label: 'Purchase orders' },
] as const;

export function useMatrix(recordType: string, includeRetired = false) {
  return useQuery({
    queryKey: adminKeys.matrix(recordType, includeRetired),
    queryFn: () =>
      api.get<MatrixOut>(
        `/admin/matrix/${recordType}${toQuery({
          include_retired: includeRetired ? true : undefined,
        })}`,
      ),
  });
}

/**
 * What a given amount would do under the live matrix.
 *
 * Fetched from the same endpoint the submission path uses rather than worked out
 * here. An administrator checking their rules against a second implementation
 * would be checking the wrong thing, and the moment the two disagreed the screen
 * would be the more convincing of the pair.
 */
export function useRoutePreview(
  recordType: string,
  amountMinorUnits: number | null,
  currency: string,
  department: string,
) {
  return useQuery({
    queryKey: adminKeys.preview(
      recordType,
      String(amountMinorUnits ?? ''),
      currency,
      department,
    ),
    queryFn: () =>
      api.get<RoutePreviewOut>(
        `/admin/matrix/${recordType}/preview${toQuery({
          amount_minor_units: amountMinorUnits ?? 0,
          currency,
          department: department.trim() || undefined,
        })}`,
      ),
    enabled: amountMinorUnits !== null,
  });
}

/**
 * Every matrix write answers with the whole matrix, and that answer replaces the
 * cache.
 *
 * A rule is only meaningful next to the others: adding one can leave a hole
 * where the previous one ended, and the gaps come back on success for exactly
 * that reason. Refetching a list of rows and working out the consequences here
 * would be the browser re-deciding what the platform will refuse.
 */
function useMatrixWrite<TVariables>(
  request: (variables: TVariables) => Promise<MatrixOut>,
  recordType: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: request,
    onSuccess: (matrix) => {
      queryClient.setQueryData(adminKeys.matrix(recordType, false), matrix);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'matrix'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'preview'] });
    },
  });
}

export function useAddRule(recordType: string) {
  return useMatrixWrite<MatrixRuleRequest>(
    (body) => api.post<MatrixOut>('/admin/matrix/rules', body),
    recordType,
  );
}

export function useRetireRule(recordType: string) {
  return useMatrixWrite<{ ruleId: string; reason: string }>(
    ({ ruleId, reason }) => api.post<MatrixOut>(`/admin/matrix/rules/${ruleId}/retire`, { reason }),
    recordType,
  );
}

export function useAssignments(level?: ApprovalLevel) {
  return useQuery({
    queryKey: adminKeys.assignments,
    queryFn: () =>
      api.get<ApprovalAssignmentOut[]>(`/admin/assignments${toQuery({ level })}`),
  });
}

function useAssignmentWrite<TVariables>(
  request: (variables: TVariables) => Promise<ApprovalAssignmentOut[]>,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: request,
    onSuccess: (rows) => {
      queryClient.setQueryData(adminKeys.assignments, rows);
      // Who holds a level decides whether the matrix has an unstaffed rung, and
      // that is reported as part of the matrix rather than here.
      void queryClient.invalidateQueries({ queryKey: ['admin', 'matrix'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'preview'] });
    },
  });
}

export function useAssignLevel() {
  return useAssignmentWrite<{ userId: string; level: ApprovalLevel; department?: string }>(
    ({ userId, level, department }) =>
      api.post<ApprovalAssignmentOut[]>('/admin/assignments', {
        user_id: userId,
        level,
        department: department?.trim() || null,
      }),
  );
}

export function useUnassignLevel() {
  return useAssignmentWrite<{ assignmentId: string }>(({ assignmentId }) =>
    api.delete<ApprovalAssignmentOut[]>(`/admin/assignments/${assignmentId}`),
  );
}

export function useDelegations() {
  return useQuery({
    queryKey: adminKeys.delegations,
    queryFn: () => api.get<ApprovalDelegationOut[]>('/admin/delegations'),
  });
}

export function useSetCover() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: {
      userId: string;
      delegateToId: string | null;
      outOfOfficeUntil: string | null;
    }) =>
      api.put<ApprovalDelegationOut>(`/admin/delegations/${variables.userId}`, {
        delegate_to_id: variables.delegateToId,
        out_of_office_until: variables.outOfOfficeUntil,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.delegations });
      // Cover changes who a step will actually reach, so anybody's assignment
      // row may now name a different person as covering it.
      void queryClient.invalidateQueries({ queryKey: adminKeys.assignments });
    },
  });
}
