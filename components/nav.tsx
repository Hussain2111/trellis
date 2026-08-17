'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

/**
 * Every route in the spec is listed from the start, with the milestone that
 * fills it in. A nav that hides unfinished work makes the build feel further
 * along than it is.
 */
const ROUTES: { href: string; label: string; milestone?: string }[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/posts', label: 'Posts', milestone: 'M1' },
  { href: '/competitors', label: 'Competitors', milestone: 'M3' },
  { href: '/archetypes', label: 'Archetypes', milestone: 'M4' },
  { href: '/gap', label: 'Gap', milestone: 'M5' },
  { href: '/drafts', label: 'Drafts', milestone: 'M7' },
  { href: '/calendar', label: 'Calendar', milestone: 'M10' },
  { href: '/chat', label: 'Chat', milestone: 'M8' },
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
            {route.milestone ? (
              <span className="font-mono text-[10px] text-ink-faint/70">{route.milestone}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
