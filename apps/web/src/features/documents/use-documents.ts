import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  DocumentDetail,
  DocumentKind,
  DocumentPage,
  DocumentSignal,
  ExtractionStatus,
  FieldName,
  FieldReview,
  ReadRequested,
  ViewerUrl,
} from '@finora/shared-types';

import { api, toQuery } from '@/lib/api-client';

export const documentKeys = {
  all: ['documents'] as const,
  list: (status: ExtractionStatus | 'all', kind: DocumentKind | 'all', offset: number) =>
    ['documents', 'list', status, kind, offset] as const,
  detail: (id: string) => ['documents', 'detail', id] as const,
};

export const PAGE_SIZE = 25;

/**
 * The review queue.
 *
 * Polled, because documents arrive here without anyone asking: the mailbox
 * worker enrols them and a background reader fills them in. A reviewer who has
 * to reload to discover work is a reviewer who stops looking.
 */
export function useDocuments(
  status: ExtractionStatus | 'all',
  kind: DocumentKind | 'all',
  offset = 0,
) {
  return useQuery({
    queryKey: documentKeys.list(status, kind, offset),
    queryFn: () =>
      api.get<DocumentPage>(
        `/documents${toQuery({
          status: status === 'all' ? undefined : status,
          kind: kind === 'all' ? undefined : kind,
          limit: PAGE_SIZE,
          offset,
        })}`,
      ),
    // Faster while any document on the page is still being read, because those
    // rows are about to change on their own and a minute-old "waiting to be
    // read" invites a reviewer to press the button again.
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (item) => item.status === 'pending' || item.status === 'extracting',
      )
        ? 5_000
        : 30_000,
    staleTime: 5_000,
  });
}

/**
 * One document and its current reading.
 *
 * Polled only while the reading is still in progress. Once values are on screen
 * a refetch would replace what the reviewer is working through underneath them,
 * so from that point the page changes only in response to their own actions.
 */
export function useDocument(id: string | undefined) {
  return useQuery({
    queryKey: documentKeys.detail(id ?? ''),
    queryFn: () => api.get<DocumentDetail>(`/documents/${id ?? ''}`),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'pending' || status === 'extracting' ? 3_000 : false;
    },
  });
}

/**
 * Every write returns the whole document, and the response is written straight
 * into the cache rather than triggering a refetch.
 *
 * A correction can clear a warning, change the status and remove a blocker at
 * once. Taking the server's own answer for all of it means the screen never
 * shows a half-updated record, and the reviewer never sees their correction
 * land and the blocker list lag a moment behind it.
 */
function useDocumentWrite<TVariables>(
  request: (id: string, variables: TVariables) => Promise<DocumentDetail>,
  documentId: string | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: TVariables) => request(documentId ?? '', variables),
    onSuccess: (detail) => {
      queryClient.setQueryData(documentKeys.detail(detail.id), detail);
      // The queue shows counts that this write has just changed, and it is a
      // different query, so it is marked stale rather than written to.
      void queryClient.invalidateQueries({ queryKey: ['documents', 'list'] });
    },
  });
}

export function useCorrectField(documentId: string | undefined) {
  return useDocumentWrite<{ name: FieldName; text: string; reason?: string }>(
    (id, { name, text, reason }) =>
      api.patch<DocumentDetail>(`/documents/${id}/fields/${name}`, {
        text,
        reason: reason ?? null,
      }),
    documentId,
  );
}

export function useReviewField(documentId: string | undefined) {
  return useDocumentWrite<{ name: FieldName; review: FieldReview }>(
    (id, { name, review }) =>
      api.post<DocumentDetail>(`/documents/${id}/fields/${name}/review`, { review }),
    documentId,
  );
}

export function useSetKind(documentId: string | undefined) {
  return useDocumentWrite<{ kind: DocumentKind }>(
    (id, { kind }) => api.post<DocumentDetail>(`/documents/${id}/kind`, { kind }),
    documentId,
  );
}

export function useAcknowledgeSignal(documentId: string | undefined) {
  return useDocumentWrite<{ signal: DocumentSignal }>(
    (id, { signal }) => api.post<DocumentDetail>(`/documents/${id}/acknowledge`, { signal }),
    documentId,
  );
}

export function useAcceptDocument(documentId: string | undefined) {
  return useDocumentWrite<{ note?: string }>(
    (id, { note }) => api.post<DocumentDetail>(`/documents/${id}/accept`, { note: note ?? null }),
    documentId,
  );
}

export function useRereadDocument(documentId: string | undefined) {
  return useDocumentWrite<void>(
    (id) => api.post<DocumentDetail>(`/documents/${id}/read`),
    documentId,
  );
}

/** Start reading whatever is waiting. Safe to call twice; existing readings stand. */
export function useReadPending() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post<ReadRequested>('/documents/read-pending'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: documentKeys.all });
    },
  });
}

/**
 * A short-lived link to the document itself.
 *
 * Requested when the viewer is about to render, not with the list. Issuing a
 * link is an audited event, so pre-issuing them for documents nobody opens
 * would fill the audit trail with views that never happened.
 */
export function useViewerUrl(documentId: string | undefined) {
  return useQuery({
    queryKey: ['documents', 'viewer-url', documentId ?? ''] as const,
    queryFn: () => api.get<ViewerUrl>(`/documents/${documentId ?? ''}/viewer-url`),
    enabled: Boolean(documentId),
    // Refetched well inside the signature's lifetime, so a reviewer reading a
    // long document does not reach a page that will not load.
    staleTime: 4 * 60_000,
    refetchInterval: 4 * 60_000,
    gcTime: 0,
  });
}
