export const AI_KILL_SWITCH_SETTING_KEY = 'ai.kill_switch';

export const RETENTION_SETTING_PREFIX = 'retention.';

/** Seeded defaults when no SystemSetting row exists (mirrors Python migration). */
export const RETENTION_DEFAULTS: {
  record_class: string;
  retention_days: number;
  description: string;
}[] = [
  { record_class: 'inbound_messages', retention_days: 2555, description: 'Inbound mail and attachments' },
  { record_class: 'documents', retention_days: 2555, description: 'Accepted document readings' },
  { record_class: 'estimates', retention_days: 2555, description: 'Estimates and approval history' },
  { record_class: 'invoices', retention_days: 2555, description: 'Invoices and payment history' },
  { record_class: 'payment_packages', retention_days: 2555, description: 'Payment packages and manifests' },
  { record_class: 'audit_entries', retention_days: 3650, description: 'Immutable audit trail' },
  { record_class: 'credit_card_periods', retention_days: 2555, description: 'Credit-card statement periods' },
  { record_class: 'accrual_periods', retention_days: 2555, description: 'Month-end accrual periods' },
];

export function retentionSettingKey(recordClass: string): string {
  const trimmed = recordClass.trim();
  if (trimmed.startsWith(RETENTION_SETTING_PREFIX)) return trimmed;
  return `${RETENTION_SETTING_PREFIX}${trimmed}`;
}

export function recordClassFromSettingKey(key: string): string {
  return key.startsWith(RETENTION_SETTING_PREFIX)
    ? key.slice(RETENTION_SETTING_PREFIX.length)
    : key;
}
