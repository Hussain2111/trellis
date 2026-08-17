import { desc } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { draftAssets, drafts } from '@/lib/db/schema';
import { Badge, Empty, Panel, PanelHeader } from '@/components/ui/primitives';
import { GeneratedBy } from '@/components/ui/data';
import { ScheduleDraftForm } from '@/components/schedule-draft-form';

export const dynamic = 'force-dynamic';

const STATUS_TONE = {
  draft: 'neutral',
  approved: 'info',
  scheduled: 'signal',
  published: 'good',
  discarded: 'bad',
} as const;

function DraftBody({ body }: { body: unknown }): React.JSX.Element | null {
  if (!body || typeof body !== 'object') return null;
  const kind = (body as { kind?: string }).kind;
  if (kind === 'carousel') {
    const slides = (body as { slides: { heading: string; body: string }[] }).slides;
    return (
      <ol className="list-decimal space-y-1 pl-4 text-[12px] text-ink-muted">
        {slides.map((s, i) => (
          <li key={i}>
            <span className="text-ink">{s.heading}</span> — {s.body}
          </li>
        ))}
      </ol>
    );
  }
  if (kind === 'image') {
    const b = body as { concept: string; image_direction: string };
    return (
      <p className="text-[12px] text-ink-muted">
        <span className="text-ink">{b.concept}</span> — {b.image_direction}
      </p>
    );
  }
  if (kind === 'reel') {
    const b = body as { hook_line: string; beats: { shot: string; on_screen_text: string }[] };
    return (
      <div className="space-y-1 text-[12px] text-ink-muted">
        <p>
          <span className="label">hook line</span> {b.hook_line}
        </p>
        <ol className="list-decimal space-y-1 pl-4">
          {b.beats.map((beat, i) => (
            <li key={i}>
              {beat.shot} — <span className="text-ink">{beat.on_screen_text}</span>
            </li>
          ))}
        </ol>
      </div>
    );
  }
  return null;
}

export default async function DraftsPage(): Promise<React.JSX.Element> {
  const rows = await db().select().from(drafts).orderBy(desc(drafts.id));
  const assets = await db().select().from(draftAssets);
  const assetsByDraft = new Map<number, typeof assets>();
  for (const a of assets) {
    const list = assetsByDraft.get(a.draftId) ?? [];
    list.push(a);
    assetsByDraft.set(a.draftId, list);
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5">
        <h1 className="text-[20px] leading-tight font-semibold">Drafts</h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          12/week, matched to your voice and format mix, each closing the biggest gap.
        </p>
      </header>

      {rows.length === 0 ? (
        <Panel>
          <PanelHeader title="Drafts" />
          <Empty
            title="No drafts yet."
            detail="Generated automatically once analysis and a voice profile exist."
          />
        </Panel>
      ) : (
        <div className="space-y-4">
          {rows.map((draft) => {
            const slides = (assetsByDraft.get(draft.id) ?? [])
              .filter((a) => a.kind === 'slide')
              .sort((a, b) => (a.slideIndex ?? 0) - (b.slideIndex ?? 0));
            return (
              <Panel key={draft.id}>
                <PanelHeader
                  title={draft.title}
                  aside={
                    <>
                      <Badge tone="neutral">{draft.format}</Badge>
                      <Badge tone={STATUS_TONE[draft.status]}>{draft.status}</Badge>
                      <GeneratedBy value={draft.generatedBy} />
                    </>
                  }
                />
                <div className="grid gap-4 px-4 py-3 lg:grid-cols-[1fr_auto]">
                  <div className="space-y-2">
                    <p className="text-[13px] text-ink">
                      <span className="label mr-2">hook</span>
                      {draft.hook}
                    </p>
                    <DraftBody body={draft.body} />
                    <p className="text-[12px] whitespace-pre-wrap text-ink-muted">
                      {draft.caption}
                    </p>
                    {draft.hashtags.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {draft.hashtags.map((h) => (
                          <span key={h} className="font-mono text-[11px] text-info">
                            #{h}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {draft.rationale ? (
                      <p className="text-[11px] text-ink-faint">
                        <span className="label mr-1">why</span>
                        {draft.rationale}
                      </p>
                    ) : null}
                  </div>

                  {slides.length > 0 ? (
                    <div className="flex gap-1.5">
                      {slides.map((s) => (
                        // eslint-disable-next-line @next/next/no-img-element -- external/local storage URL, not a static import
                        <img
                          key={s.id}
                          src={s.publicUrl ?? undefined}
                          alt={`Slide ${s.slideIndex}`}
                          className="h-24 w-24 rounded-[3px] border border-line-strong object-cover"
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
                {draft.status === 'draft' || draft.status === 'approved' ? (
                  <div className="border-t border-line px-4 py-3">
                    <ScheduleDraftForm draftId={draft.id} />
                  </div>
                ) : null}
              </Panel>
            );
          })}
        </div>
      )}
    </div>
  );
}
