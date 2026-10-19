import { Link } from '@/lib/app-link';
import { Bell } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useAuth } from '@/features/auth/auth-context';

/**
 * NotificationsButton.
 *
 * A bell that links to the one place this person's work lives. The dot shows
 * only while something is waiting, and the accessible name carries the count,
 * so the signal never rests on colour alone.
 */
export function NotificationsButton() {
  const { badges } = useAuth();
  const count = badges.myWork ?? 0;

  return (
    <Link
      to="/work"
      aria-label={
        count > 0
          ? `Notifications: ${count} item${count === 1 ? '' : 's'} waiting on you`
          : 'Notifications: nothing waiting on you'
      }
      className={cn(
        'relative flex size-10 shrink-0 items-center justify-center rounded-full',
        'text-[var(--color-text-muted)] transition-colors duration-[var(--duration-fast)]',
        'hover:bg-white/70 hover:text-[var(--color-text-strong)]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary-600)]',
      )}
    >
      <Bell aria-hidden="true" className="size-5" />
      {count > 0 ? (
        <span
          aria-hidden="true"
          className="absolute right-[9px] top-[8px] size-2.5 rounded-full border-2 border-[#f3f7ff] bg-[#ef4444]"
        />
      ) : null}
    </Link>
  );
}
