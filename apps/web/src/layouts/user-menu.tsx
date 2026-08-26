import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, LogOut, UserRound } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useAuth } from '@/features/auth/auth-context';

const ROLE_LABELS: Record<string, string> = {
  requester: 'Requester',
  approver: 'Approver',
  payment_coordinator: 'Payment coordinator',
  finance: 'Finance',
  administrator: 'Administrator',
  operations: 'Operations',
  auditor: 'Auditor',
};

export function UserMenu() {
  const { user, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  if (!user) return null;

  const initials = user.display_name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className={cn(
          'flex h-11 items-center gap-2 rounded-[var(--radius-sm)] px-2',
          'text-[var(--text-body-sm)] transition-colors duration-[var(--duration-fast)]',
          'hover:bg-[var(--color-surface-subtle)]',
          'focus-visible:outline-2 focus-visible:outline-offset-2',
          'focus-visible:outline-[var(--color-primary-600)]',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-full',
            'bg-[image:var(--gradient-signature)] text-[11px] font-bold',
            'text-[var(--color-text-inverse)]',
          )}
        >
          {initials || <UserRound className="size-4" />}
        </span>
        <span className="hidden max-w-[160px] flex-col items-start leading-tight sm:flex">
          <span className="truncate font-semibold text-[var(--color-text-strong)]">
            {user.display_name}
          </span>
          <span className="truncate text-[length:var(--text-overline)] text-[var(--color-text-muted)]">
            {user.roles.map((role) => ROLE_LABELS[role] ?? role).join(', ')}
          </span>
        </span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 opacity-60" />
        <span className="sr-only">Open account menu</span>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className={cn(
            'motion-fade-in z-50 min-w-[248px] rounded-[var(--radius-md)]',
            'border border-[var(--color-border)] bg-[var(--color-surface)]',
            'p-1.5 shadow-[var(--shadow-lg)]',
          )}
        >
          <div className="px-2.5 py-2">
            <p className="m-0 truncate text-[var(--text-body-sm)] font-semibold text-[var(--color-text-strong)]">
              {user.display_name}
            </p>
            <p className="m-0 truncate text-[var(--text-caption)] text-[var(--color-text-muted)]">
              {user.email}
            </p>
            {user.department ? (
              <p className="m-0 mt-1 truncate text-[var(--text-caption)] text-[var(--color-text-subtle)]">
                {user.department}
              </p>
            ) : null}
          </div>

          <DropdownMenu.Separator className="my-1 h-px bg-[var(--color-divider)]" />

          <DropdownMenu.Item
            onSelect={() => {
              setSigningOut(true);
              void signOut().finally(() => setSigningOut(false));
            }}
            disabled={signingOut}
            className={cn(
              'flex min-h-10 cursor-pointer select-none items-center gap-2 rounded-[var(--radius-xs)]',
              'px-2.5 text-[var(--text-body-sm)] text-[var(--color-text)] outline-none',
              'data-[highlighted]:bg-[var(--color-surface-subtle)]',
              'data-[disabled]:pointer-events-none data-[disabled]:opacity-55',
            )}
          >
            <LogOut aria-hidden="true" className="size-4" />
            {signingOut ? 'Signing out' : 'Sign out'}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
