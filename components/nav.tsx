'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

/**
 * Post analytics, the tracker, commenters and follower movement are all on the
 * Dashboard now rather than being four tabs of their own. They are four views
 * of one question — how is this account doing — and splitting them meant
 * answering it took four clicks and a memory of which tab held which number.
 *
 * What stays a tab is either about *other* accounts (Ideas, Hot topics,
 * Competitors) or about doing rather than reading (Calendar, Chat).
 *
 * `/analytics` and `/posts` survive off-nav: the full post table is 100+ rows
 * and wants a page of its own, reachable from the Dashboard section that
 * summarises it.
 */
const ROUTES: { href: string; label: string }[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/weekly', label: 'This week' },
  { href: '/opportunities', label: 'Opportunities' },
  { href: '/ideas', label: 'Ideas' },
  { href: '/topics', label: 'Hot topics' },
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
