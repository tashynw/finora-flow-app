import { useQuery } from '@tanstack/react-query';

import type { ApprovalQueueOut } from '@finora/shared-types';

import { api, toQuery } from '@/lib/api-client';

export const PAGE_SIZE = 25;

export const approvalQueueKeys = {
  page: (recordTypes: readonly string[], page: number) =>
    ['approvals', 'queue', [...recordTypes].sort().join(','), page] as const,
};

/**
 * Everything waiting on this approver, across every kind of record.
 *
 * Refetched when the tab regains focus. An approver who decided something on a
 * phone and came back to the desk should not be looking at a queue that still
 * lists it, and a queue that lies about what is outstanding is a queue people
 * stop trusting.
 */
export function useApprovalQueue(recordTypes: readonly string[], page = 1) {
  return useQuery({
    queryKey: approvalQueueKeys.page(recordTypes, page),
    queryFn: () =>
      api.get<ApprovalQueueOut>(
        `/approvals/queue${toQuery({
          record_type: recordTypes.length > 0 ? recordTypes : undefined,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        })}`,
      ),
    refetchOnWindowFocus: true,
  });
}
