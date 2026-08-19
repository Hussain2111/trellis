'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

/**
 * The cockpit. Ordered by how the pipeline actually runs, not alphabetically.
 *
 * `/posts` is dormant in v2, not deleted: the route still renders the scraped
 * back catalogue, but it is off the nav until the Graph-API-sourced Post
 * Analytics view replaces it. Gap, Voice and Drafts are gone outright.
 */
const ROUTES: { href: string; label: string }[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/analytics', label: 'Post analytics' },
  { href: '/tracker', label: 'Post tracker' },
  { href: '/audience', label: 'Followers' },
  { href: '/competitors', label: 'Competitors' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/chat', label: 'Chat' },
  { href: '/settings', label: 'Settings' },
];

export function Nav(): React.JSX.Element {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5 px-2">
      {ROUTES.map((route) => {
        const active = pathname === route.href;
        return (
          <Link
            key={route.href}
            href={route.href}
            className={cn(
              'group flex items-center justify-between rounded-[3px] px-2.5 py-1.5 text-[13px] transition-colors',
              active
                ? 'bg-surface-2 text-ink'
                : 'text-ink-muted hover:bg-surface-2/60 hover:text-ink',
            )}
          >
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'h-3.5 w-px',
                  active ? 'bg-signal' : 'bg-transparent group-hover:bg-line-strong',
                )}
              />
              {route.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
