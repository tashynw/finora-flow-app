import { useCallback, useEffect, useId, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Menu, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  NAV_GROUPS,
  sectionTabs,
  sidebarGroups,
  type SidebarGroup,
} from '@/layouts/navigation';
import { useAuth } from '@/features/auth/auth-context';
import { FinoraMark } from '@/components/brand/finora-mark';
import { UserMenu } from '@/layouts/user-menu';
import { NotificationsButton } from '@/layouts/topbar-actions';
import { SectionTabs } from '@/layouts/section-tabs';
import {
  CommandBar,
  SearchPalette,
  useCommandPaletteHotkey,
} from '@/features/search/search-palette';
import atmosphere from '@/assets/scene/app-atmosphere.jpg';

/**
 * AppShell.
 *
 * A floating glass sidebar on desktop and an off-canvas drawer below 768px,
 * with the command field and account controls along the top of the content.
 * The shell owns the skip link and the single `<main>` landmark, so every page
 * inherits correct document structure rather than re-declaring it.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, badges } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navId = useId();

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  useCommandPaletteHotkey(openPalette);

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
  const groups = user ? sidebarGroups(permissions) : [];
  const tabs = user ? sectionTabs(location.pathname, permissions) : [];

  return (
    <div className="relative min-h-dvh bg-[#f3f7ff]">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <img
        src={atmosphere}
        alt=""
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 h-[70vh] w-full select-none object-cover object-top"
      />

      <div className="relative flex min-h-dvh">
        {/* Desktop navigation */}
        <nav
          id={navId}
          aria-label="Main"
          className={cn(
            'sticky top-3 m-3 mr-0 hidden h-[calc(100dvh-24px)] shrink-0 flex-col md:flex',
            'rounded-[20px] border border-white/80 bg-white/72 backdrop-blur-xl',
            'shadow-[0_10px_30px_rgb(70_100_180_/_0.10)]',
            'transition-[width] duration-[var(--duration-standard)]',
          )}
          style={{
            width: collapsed
              ? 'var(--shell-sidebar-collapsed-width)'
              : 'var(--shell-sidebar-width)',
          }}
        >
          <div
            className={cn(
              'flex h-[76px] shrink-0 items-center',
              collapsed ? 'justify-center' : 'justify-between pl-5 pr-2',
            )}
          >
            <FinoraMark showWordmark={!collapsed} />
            {!collapsed ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setCollapsed(true)}
                aria-label="Collapse navigation"
                aria-expanded
                aria-controls={navId}
                className="size-9 text-[var(--color-text-subtle)]"
              >
                <PanelLeftClose aria-hidden="true" className="size-4" />
              </Button>
            ) : null}
          </div>

          {collapsed ? (
            <div className="flex justify-center pb-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setCollapsed(false)}
                aria-label="Expand navigation"
                aria-expanded={false}
                aria-controls={navId}
                className="size-9 text-[var(--color-text-subtle)]"
              >
                <PanelLeftOpen aria-hidden="true" className="size-4" />
              </Button>
            </div>
          ) : null}

          <SidebarLinks groups={groups} badges={badges} collapsed={collapsed} />

          {user && !collapsed ? <WorkspaceCard /> : null}
        </nav>

        {/* Mobile drawer */}
        {mobileOpen ? (
          <div className="fixed inset-0 z-50 md:hidden">
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
              className="absolute inset-0 h-full w-full bg-[rgb(17_24_39_/_0.4)]"
            />
            <nav
              aria-label="Main"
              className={cn(
                'motion-drawer-enter absolute inset-y-0 left-0 flex w-[min(84vw,280px)]',
                'flex-col bg-[var(--color-surface)] shadow-[var(--shadow-lg)]',
              )}
            >
              <div className="flex h-[72px] items-center justify-between px-5">
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
            className="sticky top-0 z-30 flex h-[76px] items-center gap-[var(--space-3)] px-4 md:px-6"
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

            <div className="flex min-w-0 max-w-[460px] flex-1 items-center">
              <CommandBar onOpen={openPalette} open={paletteOpen} />
            </div>

            <div className="ml-auto flex items-center gap-[var(--space-3)]">
              <NotificationsButton />
              <UserMenu />
            </div>
          </header>

          <SearchPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

          <main
            id="main-content"
            className="motion-page-enter min-w-0 flex-1 px-4 pb-10 pt-2 md:px-6"
          >
            <div className="mx-auto w-full max-w-[var(--shell-content-max-width)]">
              {tabs.length > 1 ? <SectionTabs tabs={tabs} /> : null}
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

/**
 * The signed-in person's workspace, at the foot of the sidebar: their
 * department when one is recorded, otherwise the product.
 */
function WorkspaceCard() {
  const { user } = useAuth();
  if (!user) return null;
  const name = user.department ?? 'Finora Flow';
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div className="m-3 mt-2 flex items-center gap-3 rounded-[14px] border border-white/90 bg-[linear-gradient(135deg,rgb(238_243_255_/_0.95),rgb(248_245_255_/_0.9))] px-3 py-3">
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-white text-[12px] font-bold text-[var(--color-primary-700)] shadow-[0_2px_6px_rgb(53_105_244_/_0.12)]"
      >
        {initials}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold text-[var(--color-text-heading)]">
          {name}
        </span>
        <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
          Finance operations
        </span>
      </span>
    </div>
  );
}

function SidebarLinks({
  groups,
  badges,
  collapsed,
}: {
  groups: SidebarGroup[];
  badges: Record<string, number>;
  collapsed: boolean;
}) {
  const location = useLocation();

  if (groups.length === 0) {
    return (
      <div className="flex-1 px-[var(--space-4)] py-[var(--space-4)]">
        {!collapsed ? (
          <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
            No sections are available for your roles yet. An administrator can
            grant access.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn('flex-1 overflow-y-auto pb-2', collapsed ? 'px-2' : 'px-3')}>
      {groups.map((group) => (
        <div key={group.label ?? 'main'} className={cn(group.label && 'mt-6')}>
          {group.label && !collapsed ? (
            <p className="m-0 px-3 pb-2 text-[12px] font-medium text-[var(--color-text-subtle)]">
              {group.label}
            </p>
          ) : group.label ? (
            <div aria-hidden="true" className="mx-2 mb-2 border-t border-[var(--color-divider)]" />
          ) : null}
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {group.entries.map((entry) => {
              const count = entry.badgeKey ? badges[entry.badgeKey] : undefined;
              const sectionActive = entry.match.some((prefix) =>
                location.pathname.startsWith(prefix),
              );
              return (
                <li key={entry.label}>
                  <NavLink
                    to={entry.to}
                    end={entry.to === '/'}
                    title={collapsed ? entry.label : undefined}
                    className={({ isActive }) => {
                      const active = isActive || sectionActive;
                      return cn(
                        'group relative flex h-10 items-center gap-3 rounded-[12px] px-3',
                        'text-[14px] no-underline transition-colors duration-[var(--duration-fast)]',
                        collapsed && 'justify-center px-0',
                        active
                          ? 'bg-[#e6eeff] font-semibold text-[var(--color-primary-700)]'
                          : 'font-medium text-[#3b4868] hover:bg-white/70 hover:text-[var(--color-text-heading)]',
                      );
                    }}
                  >
                    {({ isActive }) => {
                      const active = isActive || sectionActive;
                      return (
                        <>
                          <entry.icon
                            aria-hidden="true"
                            className={cn(
                              'size-[18px] shrink-0',
                              active ? 'text-[var(--color-primary-600)]' : 'text-[#5b6a92]',
                            )}
                          />
                          {!collapsed ? (
                            <span className="truncate">{entry.label}</span>
                          ) : (
                            <span className="sr-only">{entry.label}</span>
                          )}
                          {count && count > 0 ? (
                            <span
                              className={cn(
                                'ml-auto min-w-6 rounded-[var(--radius-pill)] bg-[#dfe8ff] px-2 py-0.5 text-center',
                                'text-[11px] font-semibold text-[var(--color-primary-700)] tabular',
                                collapsed && 'absolute right-0 top-0 ml-0 min-w-0 px-1.5',
                              )}
                            >
                              {count > 99 ? '99+' : count}
                              <span className="sr-only"> items need attention</span>
                            </span>
                          ) : null}
                        </>
                      );
                    }}
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
