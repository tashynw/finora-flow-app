/**
 * Screen permissions granted by each Finora role.
 *
 * These match the role map the application already enforces, so a session from
 * Better Auth can drive the same route gates. The API remains the authority
 * for the data behind each screen.
 */

const ROLE_PERMISSIONS = {
  requester: [
    'intake:view',
    'intake:upload',
    'document:view',
    'estimate:view',
    'estimate:create',
    'estimate:edit',
    'estimate:submit',
    'invoice:view',
    'invoice:sign_off',
    'requisition:view',
    'requisition:create',
    'report:view',
  ],
  approver: [
    'document:view',
    'estimate:view',
    'invoice:view',
    'approval:view',
    'approval:decide',
    'approval:delegate',
    'requisition:view',
    'purchase_order:view',
    'report:view',
  ],
  payment_coordinator: [
    'document:view',
    'invoice:view',
    'payment:view',
    'payment:package_manage',
    'payment:submit',
    'vendor:view',
    'vendor:confirmation_review',
    'purchase_order:view',
    'report:view',
  ],
  finance: [
    'intake:view',
    'intake:upload',
    'document:view',
    'document:download',
    'extraction:view',
    'extraction:edit',
    'extraction:accept',
    'estimate:view',
    'invoice:view',
    'invoice:create',
    'invoice:edit',
    'invoice:submit',
    'approval:view',
    'requisition:view',
    'purchase_order:view',
    'purchase_order:manage',
    'payment:view',
    'payment:mark_paid',
    'vendor:view',
    'vendor:confirmation_review',
    'credit_card:view',
    'credit_card:code',
    'credit_card:close_period',
    'accrual:view',
    'accrual:edit',
    'accrual:finalize',
    'accrual:lock_period',
    'accrual:export',
    'report:view',
    'report:export',
  ],
  operations: [
    'intake:view',
    'intake:retry',
    'intake:view_raw_headers',
    'quarantine:view',
    'operations:view',
    'operations:retry',
    'report:view',
  ],
  administrator: [
    'admin:users',
    'admin:roles',
    'admin:approval_matrix',
    'admin:thresholds',
    'admin:reference_data',
    'admin:templates',
    'admin:mail_config',
    'admin:ai_config',
    'admin:retention',
    'operations:view',
    'quarantine:view',
    'quarantine:release',
    'report:view',
  ],
  auditor: [
    'audit:view',
    'intake:view',
    'document:view',
    'estimate:view',
    'invoice:view',
    'approval:view',
    'requisition:view',
    'purchase_order:view',
    'payment:view',
    'vendor:view',
    'credit_card:view',
    'accrual:view',
    'report:view',
    'operations:view',
  ],
} as const;

export type FinoraRoleName = keyof typeof ROLE_PERMISSIONS;

const ROLE_NAMES = new Set<string>(Object.keys(ROLE_PERMISSIONS));

export function rolesFromField(roleField: string | null | undefined): FinoraRoleName[] {
  if (!roleField) return [];
  const roles: FinoraRoleName[] = [];
  for (const part of roleField.split(',')) {
    const name = part.trim();
    if (ROLE_NAMES.has(name)) roles.push(name as FinoraRoleName);
  }
  return roles;
}

export function permissionsForRoles(roles: readonly FinoraRoleName[]): string[] {
  const granted = new Set<string>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission);
  }
  return [...granted];
}
