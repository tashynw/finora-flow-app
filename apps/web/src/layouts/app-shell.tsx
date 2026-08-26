import { useEffect, useId, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Menu, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { NAV_GROUPS, visibleGroups } from '@/layouts/navigation';
import { useAuth } from '@/features/auth/auth-context';
import { FinoraMark } from '@/components/brand/finora-mark';
import { UserMenu } from '@/layouts/user-menu';
import { GlobalSearchTrigger } from '@/features/search/search-palette';

/**
 * AppShell.
 *
 * Persistent left navigation on desktop, an off-canvas drawer below 768px. The
 * shell owns the skip link and the single `<main>` landmark, so every page
 * inherits correct document structure rather than re-declaring it.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, badges } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const navId = useId();

  // A navigation is a completed intent; leaving the drawer open would hide the
  // page the user just asked for.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  const permissions = new Set(user?.permissions ?? []);
  const groups = user ? visibleGroups(permissions) : [];

  return (
    <div className="min-h-dvh bg-[var(--color-background)]">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <div className="flex min-h-dvh">
        {/* Desktop navigation */}
        <nav
          id={navId}
          aria-label="Main"
          className={cn(
            'hidden shrink-0 flex-col border-r border-[var(--color-border)]',
            'bg-[var(--color-surface)] md:flex',
            'transition-[width] duration-[var(--duration-standard)]',
          )}
          style={{
            width: collapsed
              ? 'var(--shell-sidebar-collapsed-width)'
              : 'var(--shell-sidebar-width)',
          }}
        >
          <div className="flex h-[var(--shell-topbar-height)] items-center gap-2 px-[var(--space-4)]">
            <FinoraMark showWordmark={!collapsed} />
          </div>

          <SidebarLinks
            groups={groups}
            badges={badges}
            collapsed={collapsed}
          />

          <div className="border-t border-[var(--color-divider)] p-[var(--space-2)]">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setCollapsed((value) => !value)}
              aria-label={
                collapsed ? 'Expand navigation' : 'Collapse navigation'
              }
              aria-expanded={!collapsed}
              aria-controls={navId}
            >
              {collapsed ? (
                <PanelLeftOpen aria-hidden="true" className="size-5" />
              ) : (
                <PanelLeftClose aria-hidden="true" className="size-5" />
              )}
            </Button>
          </div>
        </nav>

        {/* Mobile drawer */}
        {mobileOpen ? (
          <div className="fixed inset-0 z-50 md:hidden">
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
              className="absolute inset-0 h-full w-full bg-[rgb(11_23_57_/_0.45)]"
            />
            <nav
              aria-label="Main"
              className={cn(
                'motion-drawer-enter absolute inset-y-0 left-0 flex w-[min(84vw,300px)]',
                'flex-col bg-[var(--color-surface)] shadow-[var(--shadow-lg)]',
              )}
            >
              <div className="flex h-[var(--shell-topbar-height)] items-center justify-between px-[var(--space-4)]">
                <FinoraMark showWordmark />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setMobileOpen(false)}
                  aria-label="Close navigation"
                >
                  <X aria-hidden="true" className="size-5" />
                </Button>
              </div>
              <SidebarLinks groups={groups} badges={badges} collapsed={false} />
            </nav>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <header
            data-visual-sticky
            className={cn(
              'sticky top-0 z-30 flex h-[var(--shell-topbar-height)] items-center gap-[var(--space-3)]',
              'border-b border-[var(--color-border)] bg-[var(--color-surface-raised)]',
              'px-[var(--shell-page-padding)] backdrop-blur-[var(--glass-blur)]',
            )}
          >
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
              aria-expanded={mobileOpen}
            >
              <Menu aria-hidden="true" className="size-5" />
            </Button>

            <GlobalSearchTrigger />

            <div className="ml-auto flex items-center gap-[var(--space-2)]">
              <UserMenu />
            </div>
          </header>

          <main
            id="main-content"
            className="motion-page-enter min-w-0 flex-1 px-[var(--shell-page-padding)] py-[var(--space-6)]"
          >
            <div className="mx-auto w-full max-w-[var(--shell-content-max-width)]">
              {children}
            </div>
          </main>

          {/* The one place the signature gradient appears as a full-width band. */}
          <footer
            className="h-1 w-full shrink-0"
            style={{ backgroundImage: 'var(--gradient-footer)' }}
          />
        </div>
      </div>
    </div>
  );
}

function SidebarLinks({
  groups,
  badges,
  collapsed,
}: {
  groups: ReturnType<typeof visibleGroups>;
  badges: Record<string, number>;
  collapsed: boolean;
}) {
  if (groups.length === 0) {
    return (
      <div className="flex-1 px-[var(--space-4)] py-[var(--space-4)]">
        {!collapsed ? (
          <p className="m-0 text-[var(--text-caption)] text-[var(--color-text-muted)]">
            No sections are available for your roles yet. An administrator can
            grant access.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-[var(--space-2)] py-[var(--space-2)]">
      {groups.map((group) => (
        <div key={group.label} className="mb-[var(--space-4)]">
          {!collapsed ? (
            <p className="m-0 px-[var(--space-3)] pb-[var(--space-1)] text-[length:var(--text-overline)] font-semibold uppercase tracking-wider text-[var(--color-text-subtle)]">
              {group.label}
            </p>
          ) : (
            <div
              aria-hidden="true"
              className="mx-[var(--space-3)] mb-[var(--space-2)] border-t border-[var(--color-divider)]"
            />
          )}

          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {group.items.map((item) => {
              const count = item.badgeKey ? badges[item.badgeKey] : undefined;
              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === '/'}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      cn(
                        'flex min-h-11 items-center gap-[var(--space-3)] rounded-[var(--radius-sm)]',
                        'px-[var(--space-3)] text-[var(--text-body-sm)] font-medium',
                        'transition-colors duration-[var(--duration-fast)]',
                        collapsed && 'justify-center px-0',
                        isActive
                          ? [
                              'bg-[image:var(--gradient-signature-soft)]',
                              'text-[var(--color-primary-800)]',
                              // Active state carries a shape cue as well as
                              // colour, so it survives greyscale and low vision.
                              'shadow-[inset_2px_0_0_0_var(--color-primary-600)]',
                            ].join(' ')
                          : 'text-[var(--color-text)] hover:bg-[var(--color-surface-subtle)]',
                      )
                    }
                  >
                    <item.icon aria-hidden="true" className="size-[18px] shrink-0" />
                    {!collapsed ? <span className="truncate">{item.label}</span> : null}
                    {count && count > 0 ? (
                      <span
                        className={cn(
                          'ml-auto rounded-[var(--radius-pill)] px-1.5 py-0.5',
                          'bg-[var(--color-primary-600)] text-[length:var(--text-overline)]',
                          'font-bold text-[var(--color-text-inverse)] tabular',
                          collapsed && 'ml-0',
                        )}
                      >
                        {count > 99 ? '99+' : count}
                        <span className="sr-only"> items need attention</span>
                      </span>
                    ) : null}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export { NAV_GROUPS };
