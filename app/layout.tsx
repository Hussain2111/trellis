import type { Metadata } from 'next';
import { Nav } from '@/components/nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Trellis',
  description: 'A personal Instagram coach that shows its work.',
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <aside className="sticky top-0 flex h-screen w-52 shrink-0 flex-col border-r border-line bg-surface/40">
            <div className="px-4 py-4">
              <div className="font-mono text-[13px] font-semibold tracking-[0.14em] text-ink uppercase">
                Trellis
              </div>
              <div className="mt-0.5 text-[11px] text-ink-faint">$0/month · no login</div>
            </div>
            <Nav />
            <div className="mt-auto px-4 py-3 text-[11px] text-ink-faint">
              single account · personal use
            </div>
          </aside>
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
