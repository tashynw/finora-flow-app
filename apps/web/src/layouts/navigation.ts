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
  History,
  Hourglass,
  House,
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

/**
 * The flat sidebar, in the order the redesign lists it.
 *
 * Operations and Settings are single entries that stand for a section. Each
 * links to the first screen in its section the person can open, and stays
 * active across the whole section. The screens inside a section are reached
 * from the section tabs at the top of those pages.
 */
export interface SidebarEntry {
  label: string;
  to: string;
  icon: LucideIcon;
  badgeKey?: string | undefined;
  /** Path prefixes that keep this entry highlighted. */
  match: string[];
}

export interface SectionTab {
  label: string;
  to: string;
}

export interface SidebarGroup {
  /** Null for the unlabelled main group. */
  label: string | null;
  entries: SidebarEntry[];
}

const MAIN_ORDER: { label?: string; icon?: LucideIcon; to: string }[] = [
  { to: '/', label: 'Home', icon: House },
  { to: '/work' },
  { to: '/approvals' },
  { to: '/invoices' },
  { to: '/estimates' },
  { to: '/purchase-orders' },
  { to: '/payments' },
  { to: '/credit-cards' },
  { to: '/accruals' },
  { to: '/vendor-confirmations', label: 'Vendor confirms' },
  { to: '/reports' },
];

const SYSTEM_ORDER: { label?: string; icon?: LucideIcon; to: string }[] = [
  { to: '/documents' },
  { to: '/intake' },
  { to: '/audit', icon: History },
];

const ALL_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

function findItem(to: string): NavItem | undefined {
  return ALL_ITEMS.find((item) => item.to === to);
}

const OPERATIONS_ROUTES = ['/operations', '/operations/intake'];
const SETTINGS_ROUTES = [
  '/settings/users',
  '/settings/reference',
  '/settings/thresholds',
  '/settings/retention',
  '/settings/operations',
  '/settings/approval-matrix',
  '/settings/approvers',
  '/settings/cover',
];

function permittedTabs(
  routes: string[],
  permissions: ReadonlySet<string>,
): SectionTab[] {
  return routes
    .map((to) => findItem(to))
    .filter((item): item is NavItem => Boolean(item && permissions.has(item.permission)))
    .map((item) => ({ label: item.label, to: item.to }));
}

export function sectionTabs(
  pathname: string,
  permissions: ReadonlySet<string>,
): SectionTab[] {
  if (pathname.startsWith('/operations')) {
    return permittedTabs(OPERATIONS_ROUTES, permissions);
  }
  if (pathname.startsWith('/settings')) {
    return permittedTabs(SETTINGS_ROUTES, permissions);
  }
  return [];
}

function permittedEntries(
  order: { label?: string; icon?: LucideIcon; to: string }[],
  permissions: ReadonlySet<string>,
): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  for (const slot of order) {
    const item = findItem(slot.to);
    if (!item || !permissions.has(item.permission)) continue;
    entries.push({
      label: slot.label ?? item.label,
      to: item.to,
      icon: slot.icon ?? item.icon,
      badgeKey: item.badgeKey,
      match: item.to === '/' ? [] : [item.to],
    });
  }
  return entries;
}

export function sidebarGroups(permissions: ReadonlySet<string>): SidebarGroup[] {
  const main = permittedEntries(MAIN_ORDER, permissions);
  const system = permittedEntries(SYSTEM_ORDER, permissions);

  const operations = permittedTabs(OPERATIONS_ROUTES, permissions);
  if (operations[0]) {
    system.push({
      label: 'Operational health',
      to: operations[0].to,
      icon: Activity,
      badgeKey: 'operationalAlerts',
      match: ['/operations'],
    });
  }

  const settings = permittedTabs(SETTINGS_ROUTES, permissions);
  if (settings[0]) {
    system.push({
      label: 'Settings',
      to: settings[0].to,
      icon: Settings,
      match: ['/settings'],
    });
  }

  return [
    { label: null, entries: main },
    { label: 'System', entries: system },
  ].filter((group) => group.entries.length > 0);
}

export function visibleGroups(
  permissions: ReadonlySet<string>,
): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => permissions.has(item.permission)),
  })).filter((group) => group.items.length > 0);
}
