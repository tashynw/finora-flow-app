import { NavLink } from '@/lib/app-link';

import { cn } from '@/lib/utils';
import type { SectionTab } from '@/layouts/navigation';

/**
 * SectionTabs.
 *
 * Moves between the screens inside Operations or Settings, which the sidebar
 * shows as one entry each. Same pill language as the register views: the
 * current screen is a dark pill, the rest are plain text.
 */
export function SectionTabs({ tabs }: { tabs: SectionTab[] }) {
  return (
    <nav aria-label="Section" className="mb-[var(--space-5)] -mt-1">
      <ul className="m-0 flex list-none gap-1 overflow-x-auto p-0 md:flex-wrap">
        {tabs.map((tab) => (
          <li key={tab.to} className="shrink-0">
            <NavLink
              to={tab.to}
              end
              className={({ isActive }) =>
                cn(
                  'inline-flex h-8 items-center whitespace-nowrap rounded-[var(--radius-sm)] px-3',
                  'text-[12px] font-medium no-underline',
                  'transition-colors duration-[var(--duration-fast)]',
                  isActive
                    ? 'bg-[var(--color-text-strong)] text-[var(--color-text-inverse)]'
                    : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-subtle)] hover:text-[var(--color-text-strong)]',
                )
              }
            >
              {tab.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
