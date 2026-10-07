/** Finora role → permission strings (mirrors Python domain.roles). */

export const FINORA_ROLE_IDS = [
  'requester',
  'approver',
  'payment_coordinator',
  'finance',
  'administrator',
  'operations',
  'auditor',
] as const;

export type FinoraRoleId = (typeof FINORA_ROLE_IDS)[number];

const ROLE_PERMISSIONS: Record<FinoraRoleId, readonly string[]> = {
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
  operations: [
    'intake:view',
    'intake:retry',
    'intake:view_raw_headers',
    'quarantine:view',
    'operations:view',
    'operations:retry',
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
};

export function parseRoleField(role: string | null | undefined): FinoraRoleId[] {
  if (!role?.trim()) return [];
  return role
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part): part is FinoraRoleId =>
      (FINORA_ROLE_IDS as readonly string[]).includes(part),
    );
}

export function formatRoleField(roles: string[]): string {
  const normalized = roles
    .map((r) => r.trim().toLowerCase())
    .filter((r) => (FINORA_ROLE_IDS as readonly string[]).includes(r));
  return [...new Set(normalized)].join(',');
}

export function permissionsForRoles(roles: Iterable<string>): string[] {
  const granted = new Set<string>();
  for (const role of roles) {
    const id = role.trim().toLowerCase() as FinoraRoleId;
    const perms = ROLE_PERMISSIONS[id];
    if (perms) for (const p of perms) granted.add(p);
  }
  return [...granted].sort();
}

export function assertRolesCompatible(roles: string[]): void {
  const perms = new Set(permissionsForRoles(roles));
  if (perms.has('admin:approval_matrix') && perms.has('approval:decide')) {
    throw new Error(
      'These roles cannot be held together: admin:approval_matrix and approval:decide must sit with different people.',
    );
  }
}

export function mayDecide(roles: Iterable<string>): boolean {
  return permissionsForRoles(roles).includes('approval:decide');
}
