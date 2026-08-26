import {
  Activity,
  BadgeDollarSign,
  Banknote,
  BarChart3,
  BookMarked,
  Building2,
  CalendarClock,
  CreditCard,
  FileCheck2,
  FileText,
  Hourglass,
  Inbox,
  LayoutDashboard,
  MailCheck,
  ScrollText,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UserRoundCheck,
  UsersRound,
  Wallet,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Navigation model.
 *
 * Each item declares the permission required to see it. The sidebar filters on
 * that, but visibility is a convenience only: the API authorizes every request
 * independently, so hiding a link is never the access control.
 */
export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  permission: string;
  /** Shown as a count beside the label, for work awaiting this user. */
  badgeKey?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      {
        label: 'Dashboard',
        to: '/',
        icon: LayoutDashboard,
        permission: 'report:view',
      },
      {
        label: 'My work',
        to: '/work',
        icon: FileCheck2,
        permission: 'report:view',
        badgeKey: 'myWork',
      },
    ],
  },
  {
    label: 'Intake',
    items: [
      {
        label: 'Inbox',
        to: '/intake',
        icon: Inbox,
        permission: 'intake:view',
        badgeKey: 'intakeUnprocessed',
      },
      {
        // Asks for the right to see what was read from a document rather than
        // the right to see the document, because that is what the screen shows.
        label: 'Documents',
        to: '/documents',
        icon: FileText,
        permission: 'extraction:view',
        badgeKey: 'documentsNeedingReview',
      },
    ],
  },
  {
    label: 'Workflow',
    items: [
      {
        label: 'Estimates',
        to: '/estimates',
        icon: ScrollText,
        permission: 'estimate:view',
      },
      {
        label: 'Invoices',
        to: '/invoices',
        icon: BadgeDollarSign,
        permission: 'invoice:view',
      },
      {
        label: 'Approvals',
        to: '/approvals',
        icon: ShieldCheck,
        permission: 'approval:view',
        badgeKey: 'awaitingMyApproval',
      },
      {
        label: 'Purchase orders',
        to: '/purchase-orders',
        icon: Building2,
        permission: 'purchase_order:view',
      },
    ],
  },
  {
    label: 'Payments',
    items: [
      {
        label: 'Payment packages',
        to: '/payments',
        icon: Wallet,
        permission: 'payment:view',
      },
      {
        label: 'Vendor confirmations',
        to: '/vendor-confirmations',
        icon: Banknote,
        permission: 'vendor:confirmation_review',
      },
    ],
  },
  {
    label: 'Finance',
    items: [
      {
        label: 'Credit cards',
        to: '/credit-cards',
        icon: CreditCard,
        permission: 'credit_card:view',
      },
      {
        label: 'Accruals',
        to: '/accruals',
        icon: CalendarClock,
        permission: 'accrual:view',
      },
      {
        label: 'Reports',
        to: '/reports',
        icon: BarChart3,
        permission: 'report:view',
      },
    ],
  },
  {
    label: 'Administration',
    items: [
      {
        label: 'System health',
        to: '/operations',
        icon: Activity,
        permission: 'operations:view',
        badgeKey: 'operationalAlerts',
      },
      {
        label: 'Intake health',
        to: '/operations/intake',
        icon: MailCheck,
        permission: 'operations:view',
      },
      {
        label: 'Audit trail',
        to: '/audit',
        icon: ScrollText,
        permission: 'audit:view',
      },
      {
        label: 'Users and roles',
        to: '/settings/users',
        icon: UsersRound,
        permission: 'admin:users',
      },
      {
        label: 'Reference data',
        to: '/settings/reference',
        icon: BookMarked,
        permission: 'admin:reference_data',
      },
      {
        label: 'PO thresholds',
        to: '/settings/thresholds',
        icon: BadgeDollarSign,
        permission: 'admin:thresholds',
      },
      {
        label: 'Retention',
        to: '/settings/retention',
        icon: Hourglass,
        permission: 'admin:retention',
      },
      {
        label: 'Operational settings',
        to: '/settings/operations',
        icon: SlidersHorizontal,
        permission: 'admin:ai_config',
      },
      {
        label: 'Approval matrix',
        to: '/settings/approval-matrix',
        icon: Settings,
        permission: 'admin:approval_matrix',
      },
      {
        label: 'Who approves what',
        to: '/settings/approvers',
        icon: UsersRound,
        permission: 'admin:approval_matrix',
      },
      {
        // The one administration screen an approver reaches. Arranging your own
        // cover is not an administrative act, and putting it behind the admin
        // right would mean nobody could go on leave without asking IT.
        label: 'Cover while away',
        to: '/settings/cover',
        icon: UserRoundCheck,
        permission: 'approval:delegate',
      },
    ],
  },
];

export function visibleGroups(
  permissions: ReadonlySet<string>,
): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => permissions.has(item.permission)),
  })).filter((group) => group.items.length > 0);
}
