import { useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';

/** Minimal History-API router: real URLs (bookmarkable, back button works), no dependency. */

const EVENT = 'wh:navigate';
/** Fired after every `navigate()` (and Link click) so code outside the router can react to a changed URL. */
export const NAVIGATE_EVENT = EVENT;

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (to === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  dispatchEvent(new Event(EVENT));
  scrollTo(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    addEventListener('popstate', update);
    addEventListener(EVENT, update);
    return () => {
      removeEventListener('popstate', update);
      removeEventListener(EVENT, update);
    };
  }, []);
  return path;
}

/** Match "/workspaces/:id" against a path; returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const a = path.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

/** An <a> that navigates in-app; modified clicks (new tab etc.) behave normally. */
export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        rest.onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/** Match a `page` slot item's path: a "/a/:b" pattern, a RegExp (named groups become params) or a matcher function. */
export function matchPattern(pattern: string | RegExp | ((path: string) => Record<string, string> | null), path: string): Record<string, string> | null {
  if (typeof pattern === 'string') return match(pattern, path);
  if (typeof pattern === 'function') return pattern(path);
  const m = pattern.exec(path);
  return m ? { ...(m.groups ?? {}) } : null;
}
