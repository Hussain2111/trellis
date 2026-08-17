import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { draftAssets, drafts } from '../../db/schema';
import { getImageProvider } from '../../providers';
import { selfAccount } from '../../ingest/upsert';
import {
  assetDirFor,
  paletteForDraft,
  renderSlide,
  slidesForDraft,
} from '../../slides/render';
import { JobPermanentError, type JobContext } from '../types';

/**
 * Render a draft's slides to PNG. Backgrounds are attempted only when a
 * provider is configured, and any failure falls back to the palette gradient
 * rather than blocking the draft.
 */
export async function renderSlides(ctx: JobContext<'render_slides'>): Promise<void> {
  const draft = db().select().from(drafts).where(eq(drafts.id, ctx.payload.draftId)).get();
  if (!draft) throw new JobPermanentError(`draft ${ctx.payload.draftId} not found`);

  const self = selfAccount();
  const handle = self?.handle ?? 'yourhandle';
  const palette = paletteForDraft(draft.id);
  const specs = slidesForDraft(draft.body, draft.hook, draft.cta);

  if (specs.length === 0) throw new JobPermanentError('draft has nothing to render');

  const dir = assetDirFor(draft.id);
  const provider = getImageProvider();

  // Clear previous renders so a re-run doesn't leave stale slides behind.
  db().delete(draftAssets).where(eq(draftAssets.draftId, draft.id)).run();

  for (let i = 0; i < specs.length; i++) {
    if (ctx.shouldStop()) {
      ctx.save({ checkpoint: i, label: `paused at slide ${i}/${specs.length}` });
      return;
    }

    const spec = specs[i]!;
    let backgroundImage: string | undefined;

    if (provider.id !== 'none') {
      const background = await provider.background({
        prompt: `abstract textured backdrop, ${palette.name.toLowerCase()} tones, no text, no letters`,
        width: 1080,
        height: 1080,
        seed: draft.id * 100 + i,
      });
      if (background.bytes) {
        backgroundImage = `data:image/jpeg;base64,${Buffer.from(background.bytes).toString('base64')}`;
      } else {
        ctx.save({ label: background.note });
      }
    }

    const png = await renderSlide({
      spec,
      index: i + 1,
      total: specs.length,
      handle,
      palette,
      ...(backgroundImage === undefined ? {} : { backgroundImage }),
    });

    const file = path.join(dir, `slide-${String(i + 1).padStart(2, '0')}.png`);
    fs.writeFileSync(file, png);

    db()
      .insert(draftAssets)
      .values({
        draftId: draft.id,
        kind: 'slide',
        slideIndex: i + 1,
        localPath: file,
        provider: backgroundImage ? provider.id : 'gradient',
      })
      .run();

    ctx.save({ progress: (i + 1) / specs.length, label: `slide ${i + 1}/${specs.length}` });
  }

  ctx.save({ progress: 1, label: `${specs.length} slides rendered` });
}
