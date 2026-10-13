import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  IntakeStatus,
  MessageDetail,
  MessagePage,
  OperationsReport,
  SignedUrlResponse,
  UploadAccepted,
} from '@finora/shared-types';

import { api, toQuery } from '@/lib/api-client';
import {
  uploadDocumentToS3,
  type DocumentFolderKind,
} from '@/features/documents/upload-to-s3';

export const intakeKeys = {
  all: ['intake'] as const,
  messages: (status: IntakeStatus | 'all', offset: number) =>
    ['intake', 'messages', status, offset] as const,
  message: (id: string) => ['intake', 'message', id] as const,
  operations: (probeMailbox: boolean) =>
    ['intake', 'operations', probeMailbox] as const,
};

export const PAGE_SIZE = 25;

export function useMessages(status: IntakeStatus | 'all', offset = 0) {
  return useQuery({
    queryKey: intakeKeys.messages(status, offset),
    queryFn: () =>
      api.get<MessagePage>(
        `/intake/messages${toQuery({
          status: status === 'all' ? undefined : status,
          limit: PAGE_SIZE,
          offset,
        })}`,
      ),
    // Intake is a queue that others feed, so a stale list misleads about what
    // still needs attention.
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
}

export function useMessage(id: string | undefined) {
  return useQuery({
    queryKey: intakeKeys.message(id ?? ''),
    queryFn: () => api.get<MessageDetail>(`/intake/messages/${id ?? ''}`),
    enabled: Boolean(id),
  });
}

export function useUploadDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      file,
      note,
      kind = 'unknown',
    }: {
      file: File;
      note?: string;
      kind?: DocumentFolderKind;
    }) => {
      const stored = await uploadDocumentToS3(file, kind);
      const message = await api.post<{ id: string; documents?: { id: string }[] }>(
        '/intake/uploads',
        {
          filename: stored.filename,
          contentType: stored.contentType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          key: stored.fileKey,
          bucket: stored.bucket,
          note,
          kind,
        },
      );
      const storedCount = message.documents?.length ?? 1;
      const accepted: UploadAccepted = {
        message_id: message.id,
        enrolled_documents: storedCount,
        quarantined_attachments: 0,
        rejected_attachments: 0,
        stored_attachments: storedCount,
        status: 'ready',
      };
      return accepted;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: intakeKeys.all });
    },
  });
}

/**
 * Intake operational health, read from stored state.
 *
 * Polled on a short interval because the question it answers ("is intake still
 * running") is only useful if the answer is current; a stale green page is worse
 * than no page. Touches no network beyond this API.
 */
export function useIntakeOperations() {
  return useQuery({
    queryKey: intakeKeys.operations(false),
    queryFn: () => api.get<OperationsReport>('/intake/operations'),
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
}

/**
 * The same report, plus a live mailbox connection.
 *
 * Disabled until explicitly run, and never polled. Each call opens a real IMAP
 * connection and attempts a sign-in, and repeated logins from a dashboard that
 * refreshes itself are the kind of thing a mail provider rate-limits or treats
 * as an attack. It is an action a person takes, not a reading a page collects.
 */
export function useMailboxProbe() {
  return useQuery({
    queryKey: intakeKeys.operations(true),
    queryFn: () =>
      api.get<OperationsReport>(
        `/intake/operations${toQuery({ probe_mailbox: 'true' })}`,
      ),
    enabled: false,
    staleTime: Infinity,
    gcTime: 0,
  });
}

/**
 * Fetches a signed link at the moment of the click.
 *
 * Not prefetched with the list: a link is short-lived and issuing one is an
 * audited event, so pre-issuing links for rows nobody opens would both expire
 * uselessly and fill the audit trail with downloads that never happened.
 */
export function useAttachmentLink() {
  return useMutation({
    mutationFn: (attachmentId: string) =>
      api.get<SignedUrlResponse>(
        `/intake/attachments/${attachmentId}/download-url`,
      ),
  });
}
