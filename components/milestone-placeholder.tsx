import { Panel } from '@/components/ui/primitives';

/**
 * An honest placeholder. The route exists so the shape of the app is visible
 * from day one, and it says exactly which milestone fills it in rather than
 * showing an empty dashboard that looks broken.
 */
export function MilestonePlaceholder({
  title,
  milestone,
  description,
}: {
  title: string;
  milestone: string;
  description: string;
}): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <h1 className="mb-1 text-[20px] font-semibold">{title}</h1>
      <p className="mb-6 text-[13px] text-ink-muted">{description}</p>
      <Panel>
        <div className="px-5 py-8 text-center">
          <div className="metric text-[28px] text-signal">{milestone}</div>
          <p className="mt-2 text-[13px] text-ink-muted">Not built yet.</p>
          <p className="mx-auto mt-1 max-w-md text-[12px] text-ink-faint">
            Milestones ship one at a time and each one stands alone, so nothing here pretends to
            work before it does.
          </p>
        </div>
      </Panel>
    </div>
  );
}
