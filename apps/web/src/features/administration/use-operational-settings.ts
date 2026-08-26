import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api-client';

export type OperationalAiSnapshot = {
  enabled: boolean;
  kill_switch_env: boolean;
  kill_switch_effective: boolean;
  model_extraction: string;
  model_classification: string;
};

export type OperationalWorkflowSnapshot = {
  reminder_interval_hours: number;
  reminder_max_count: number;
  display_timezone: string;
  base_currency: string;
  invoice_tolerance_percent: number;
  invoice_tolerance_minor_units: number;
  sign_off_link_ttl_hours: number;
  vendor_check_in_link_ttl_hours: number;
  link_ttl_seconds: number;
};

export type OperationalSettingsSnapshot = {
  ai: OperationalAiSnapshot;
  workflow: OperationalWorkflowSnapshot;
};

export type KillSwitchBody = {
  engaged: boolean;
  reason: string;
};

export type KillSwitchResult = {
  engaged: boolean;
  kill_switch_effective: boolean;
};

export const operationalSettingsKeys = {
  all: ['admin', 'operational-settings'] as const,
  snapshot: () => [...operationalSettingsKeys.all, 'snapshot'] as const,
};

export function useOperationalSettings() {
  return useQuery({
    queryKey: operationalSettingsKeys.snapshot(),
    queryFn: () => api.get<OperationalSettingsSnapshot>('/admin/operational-settings'),
  });
}

export function useSetAiKillSwitch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: KillSwitchBody) =>
      api.post<KillSwitchResult>('/admin/operational-settings/ai-kill-switch', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: operationalSettingsKeys.all });
    },
  });
}
