import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { draftAssets, drafts, schedule } from '@/lib/db/schema';
import { postsByIds } from '@/lib/analysis/benchmark';
import { checklistFor, formatForClipboard } from '@/lib/publish/notify';
import { Badge, Button, Empty, Input, Panel, PanelHeader } from '@/components/ui/primitives';
import { GeneratedBy } from '@/components/ui/data';
import { ActionButton } from '@/components/action-button';
import { ActionForm } from '@/components/action-form';
import { CopyButton, RewriteBox } from '@/components/draft-editor';
import {
  renderSlidesAction,
  scheduleDraftAction,
  setDraftStatusAction,
  updateDraftAction,
} from '@/app/actions';
import { formatNumber } from '@/lib/utils';

export const dynamic = 'force-dynamic';

interface CarouselBody {
  kind: 'carousel';
  slides: { heading: string; body: string }[];
}
interface ReelBody {
  kind: 'reel';
  hook_line: string;
  beats: { shot: string; on_screen_text: string; spoken: string }[];
}
interface ImageBody {
  kind: 'image';
  concept: string;
  image_direction: string;
}

export default async function DraftPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const draft = db().select().from(drafts).where(eq(drafts.id, Number(id))).get();
  if (!draft) notFound();

  const assets = db().select().from(draftAssets).where(eq(draftAssets.draftId, draft.id)).all();
  const scheduled = db().select().from(schedule).where(eq(schedule.draftId, draft.id)).get();
  const evidence = postsByIds((draft.evidence as number[]) ?? []);
  const body = draft.body as CarouselBody | ReelBody | ImageBody;
  const hashtags = (draft.hashtags as string[]) ?? [];
  const clipboard = formatForClipboard(draft);

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <header className="mb-5">
        <Link href="/drafts" className="label hover:text-ink-muted">
          ← drafts
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[20px] leading-tight font-semibold">{draft.title}</h1>
            <p className="mt-1 text-[13px] text-ink-muted">{draft.hook}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={draft.status === 'published' ? 'good' : 'neutral'}>{draft.status}</Badge>
            <Badge>{draft.format}</Badge>
            <GeneratedBy value={draft.generatedBy} />
          </div>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Content" />
            <div className="space-y-3 px-4 py-4">
              {body.kind === 'carousel' ? (
                <ol className="space-y-2.5">
                  {body.slides.map((slide, index) => (
                    <li key={index} className="border-l-2 border-line pl-3">
                      <div className="flex items-baseline gap-2">
                        <span className="metric text-[11px] text-ink-faint">{index + 1}</span>
                        <span className="text-[14px] font-medium">{slide.heading}</span>
                      </div>
                      <p className="mt-0.5 text-[13px] text-ink-muted">{slide.body}</p>
                    </li>
                  ))}
                </ol>
              ) : null}

              {body.kind === 'reel' ? (
                <>
                  <div className="rounded-[3px] border border-signal/30 bg-signal/[0.06] px-3 py-2">
                    <div className="label text-signal/70">first two seconds, verbatim</div>
                    <p className="mt-1 text-[15px] font-medium">{body.hook_line}</p>
                  </div>
                  <ol className="space-y-2.5">
                    {body.beats.map((beat, index) => (
                      <li key={index} className="border-l-2 border-line pl-3">
                        <div className="flex items-baseline gap-2">
                          <span className="metric text-[11px] text-ink-faint">{index + 1}</span>
                          <span className="text-[13px]">{beat.shot}</span>
                        </div>
                        <p className="mt-1 font-mono text-[12px] text-signal">
                          {beat.on_screen_text}
                        </p>
                        <p className="mt-0.5 text-[13px] text-ink-muted">{beat.spoken}</p>
                      </li>
                    ))}
                  </ol>
                </>
              ) : null}

              {body.kind === 'image' ? (
                <>
                  <div>
                    <div className="label">concept</div>
                    <p className="mt-1 text-[13px]">{body.concept}</p>
                  </div>
                  <div>
                    <div className="label">image direction</div>
                    <p className="mt-1 text-[13px] text-ink-muted">{body.image_direction}</p>
                  </div>
                </>
              ) : null}
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title="Caption"
              aside={<CopyButton text={clipboard} />}
            />
            <form action={updateDraftAction} className="space-y-3 px-4 py-4">
              <input type="hidden" name="id" value={draft.id} />
              <div>
                <span className="label mb-1.5 block">Title</span>
                <Input name="title" defaultValue={draft.title} />
              </div>
              <div>
                <span className="label mb-1.5 block">Hook</span>
                <Input name="hook" defaultValue={draft.hook} />
              </div>
              <div>
                <span className="label mb-1.5 block">Caption</span>
                <textarea
                  name="caption"
                  defaultValue={draft.caption}
                  rows={9}
                  className="w-full rounded-[3px] border border-line-strong bg-canvas px-2.5 py-2 text-[13px] leading-relaxed text-ink focus:border-signal/50 focus:outline-none"
                />
              </div>
              <div>
                <span className="label mb-1.5 block">CTA</span>
                <Input name="cta" defaultValue={draft.cta ?? ''} />
              </div>
              <div>
                <span className="label mb-1.5 block">Hashtags</span>
                <Input name="hashtags" defaultValue={hashtags.join(' ')} />
              </div>
              <div className="flex justify-end">
                <Button variant="primary" size="sm" type="submit">
                  Save
                </Button>
              </div>
            </form>
          </Panel>

          <Panel>
            <PanelHeader title="Rewrite" />
            <RewriteBox draftId={draft.id} />
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Status" />
            <div className="flex flex-wrap gap-2 px-4 py-3">
              <ActionButton
                action={setDraftStatusAction.bind(null, draft.id, 'approved')}
                label="approve"
                variant="primary"
              />
              <ActionButton
                action={setDraftStatusAction.bind(null, draft.id, 'discarded')}
                label="discard"
                variant="ghost"
              />
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title="Assets"
              aside={<Badge>{assets.length}</Badge>}
            />
            <div className="px-4 py-3">
              {assets.length === 0 ? (
                <p className="text-[12px] text-ink-faint">
                  {draft.format === 'carousel'
                    ? 'Slide text is rendered deterministically — no model touches the lettering.'
                    : 'Nothing to render for this format.'}
                </p>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {assets.map((asset) => (
                    <div key={asset.id} className="overflow-hidden rounded-[3px] border border-line">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/assets/${draft.id}/${asset.localPath?.split(/[\\/]/).pop() ?? ''}`}
                        alt={`slide ${asset.slideIndex}`}
                        className="aspect-square w-full object-cover"
                      />
                    </div>
                  ))}
                </div>
              )}
              {draft.format === 'carousel' ? (
                <div className="mt-3">
                  <ActionButton
                    action={renderSlidesAction.bind(null, draft.id)}
                    label={assets.length ? 're-render slides' : 'render slides'}
                  />
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Schedule" />
            {scheduled ? (
              <div className="px-4 py-3 text-[13px]">
                <Badge tone={scheduled.status === 'failed' ? 'bad' : 'signal'}>
                  {scheduled.status}
                </Badge>
                <p className="mt-2 text-ink-muted">
                  {new Date(scheduled.scheduledFor * 1000).toLocaleString()}
                </p>
                {scheduled.lastError ? (
                  <p className="mt-1 text-[11px] text-negative">{scheduled.lastError}</p>
                ) : null}
                <Link href="/calendar" className="mt-2 block text-[12px] text-info hover:underline">
                  Open the calendar
                </Link>
              </div>
            ) : (
              <ActionForm action={scheduleDraftAction} className="space-y-2 px-4 py-3">
                <input type="hidden" name="draftId" value={draft.id} />
                <Input type="datetime-local" name="scheduledFor" />
                <Button size="sm" type="submit" className="w-full">
                  Schedule
                </Button>
              </ActionForm>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Checklist" />
            <ul className="divide-y divide-line">
              {checklistFor(draft.format).map((item) => (
                <li key={item.step} className="px-4 py-2">
                  <div className="text-[13px]">{item.step}</div>
                  <div className="text-[11px] text-ink-faint">{item.detail}</div>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel>
            <PanelHeader title="Why this draft" />
            <div className="px-4 py-3">
              <p className="text-[13px] text-ink-muted">{draft.rationale ?? 'No rationale recorded.'}</p>
              {evidence.length > 0 ? (
                <ul className="mt-2 space-y-1 border-l border-line pl-2.5">
                  {evidence.map((post) => (
                    <li key={post.id} className="flex items-baseline gap-2 text-[12px]">
                      <span className="metric w-12 shrink-0 text-ink-faint">
                        {formatNumber(post.likes)}
                      </span>
                      <span className="truncate text-ink-muted">
                        {(post.caption ?? '').split('\n')[0]?.slice(0, 60) || post.shortcode}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty title="" detail="No evidence attached to this draft." />
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
