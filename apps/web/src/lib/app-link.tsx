import { forwardRef, type ReactNode } from 'react';
import {
  Link as RouterLink,
  Navigate as RouterNavigate,
  useNavigate as useRouterNavigate,
  useParams as useRouterParams,
  useRouterState,
  type LinkComponentProps,
} from '@tanstack/react-router';

/**
 * String paths for links the API and the navigation model already build.
 *
 * TanStack Router's `to` is a route pattern (`/invoices/$invoiceId`). A finished
 * address such as `/invoices/8f3…` or a `record_path` from search is an `href`.
 * These wrappers keep that distinction at the boundary so call sites can keep
 * handing over the path they already have.
 */

type LinkProps = Omit<LinkComponentProps<'a'>, 'to' | 'href' | 'children'> & {
  to: string;
  children?: ReactNode;
};

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ to, ...props }, ref) {
  // `href` is the finished address. `to` is only here so the registered router
  // accepts the link; buildLocation replaces it with the href path.
  return <RouterLink ref={ref} to="/" href={to} {...props} />;
});

export function Navigate({
  to,
  replace,
  state,
}: {
  to: string;
  replace?: boolean;
  state?: { from?: string };
}) {
  return (
    <RouterNavigate
      to="/"
      href={to}
      {...(replace !== undefined ? { replace } : {})}
      {...(state !== undefined ? { state } : {})}
    />
  );
}

export function useNavigate() {
  const navigate = useRouterNavigate();
  return (to: string) => navigate({ to: '/', href: to });
}

export function useParams<T extends Record<string, string | undefined>>(): T {
  return (useRouterParams as (opts: { strict: false }) => T)({ strict: false });
}

/** Same fields the screens were already reading off the location. */
export function useLocation() {
  const location = useRouterState({ select: (state) => state.location });
  return {
    pathname: location.pathname,
    search: location.searchStr,
    hash: location.hash ? `#${location.hash}` : '',
    state: location.state,
  };
}

function pathIsActive(pathname: string, to: string, end: boolean | undefined): boolean {
  if (end || to === '/') return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}

/**
 * Sidebar and section links. Active means "this screen", with an optional
 * exact match so Home does not stay lit on every other page.
 */
export function NavLink({
  to,
  end,
  title,
  className,
  children,
}: {
  to: string;
  end?: boolean;
  title?: string | undefined;
  className?: string | ((state: { isActive: boolean }) => string);
  children?: ReactNode | ((state: { isActive: boolean }) => ReactNode);
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isActive = pathIsActive(pathname, to, end);
  const classString = typeof className === 'function' ? className({ isActive }) : className;
  const content = typeof children === 'function' ? children({ isActive }) : children;
  return (
    <RouterLink
      to="/"
      href={to}
      {...(title !== undefined ? { title } : {})}
      {...(classString !== undefined ? { className: classString } : {})}
    >
      {content}
    </RouterLink>
  );
}
