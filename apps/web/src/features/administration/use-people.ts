import { useQuery } from '@tanstack/react-query';

import type { ApprovalPersonOut } from '@finora/shared-types';

import { api } from '@/lib/api-client';

/**
 * Everybody who could hold a level or stand in for somebody.
 *
 * Cached for the session rather than refetched per dialog: the list changes when
 * somebody joins or leaves, which is not on the timescale of opening a modal.
 */
export function usePeople() {
  return useQuery({
    queryKey: ['admin', 'people'],
    queryFn: () => api.get<ApprovalPersonOut[]>('/admin/people'),
    staleTime: 5 * 60 * 1000,
  });
}
