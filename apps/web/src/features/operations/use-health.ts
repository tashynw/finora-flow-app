import { useQuery } from '@tanstack/react-query';

import type {
  DependencyReport,
  DependencyState,
  ReadinessResponse,
} from '@finora/shared-types';

import { api } from '@/lib/api-client';

export type { DependencyReport, DependencyState, ReadinessResponse };

/** Plain-language names and consequences, so an operator does not need to know
 * the infrastructure to understand the impact. */
export const DEPENDENCY_INFO: Record<
  string,
  { label: string; impact: string }
> = {
  postgresql: {
    label: 'Database',
    impact: 'Nothing can be read or saved while this is unavailable.',
  },
  redis: {
    label: 'Job queue',
    impact:
      'Mailbox polling, reminders and outbound email pause. Nothing is lost; queued work resumes.',
  },
  malware_scanner: {
    label: 'Malware scanner',
    impact:
      'Intake stops accepting attachments. Files are never passed through unscanned.',
  },
  object_storage: {
    label: 'Document storage',
    impact: 'New documents cannot be stored and existing ones cannot be opened.',
  },
  imap: {
    label: 'Mailbox (incoming)',
    impact:
      'New email is not collected. It stays in the mailbox and is picked up once the connection returns.',
  },
  smtp: {
    label: 'Email sending',
    impact:
      'Notifications and reminders queue instead of sending. They are retried automatically.',
  },
  ai_gateway: {
    label: 'AI assistance',
    impact:
      'Suggestions are unavailable. Every workflow can still be completed manually.',
  },
};

export function useHealth() {
  return useQuery({
    queryKey: ['health', 'ready'],
    queryFn: () => api.get<ReadinessResponse>('/health/ready'),
    // Operational status is only useful if it is current.
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}
