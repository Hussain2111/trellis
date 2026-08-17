import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { draftAssets, drafts } from '../../db/schema';
import { selfAccount } from '../../ingest/upsert';
import { getImageProvider } from '../../providers';
import { paletteForDraft, renderSlide, slidesForDraft } from '../../slides/render';
import { uploadAsset } from '../../storage';
import { JobPermanentError, type JobContext } from '../types';

/**
 * Carousel drafts only — reels and single images have nothing to render into
 * a slide sequence. Slide *text* is always rendered in code (satori + resvg);
 * only the background may come from a free image model, and a failure there
 * degrades to a palette gradient rather than blocking the render.
 */
export async function renderSlides(ctx: JobContext<'render_slides'>): Promise<void> {
  const [draft] = await db()
    .select()
    .from(drafts)
    .where(eq(drafts.id, ctx.payload.draftId))
    .limit(1);
  if (!draft) throw new JobPermanentError(`draft ${ctx.payload.draftId} no longer exists`);

  if (draft.format !== 'carousel') {
    await ctx.save({ progress: 1, label: `${draft.format} draft has no slides to render` });
    return;
  }

  const self = await selfAccount();
  const specs = slidesForDraft(draft.body, draft.hook, draft.cta);
  const palette = paletteForDraft(draft.id);
  const imageProvider = getImageProvider();

  const background = await imageProvider.background({
    prompt: `abstract background, ${palette.name.toLowerCase()} tones, for a social post titled "${draft.title}"`,
    width: 1080,
    height: 1080,
    seed: draft.id,
  });
  const backgroundImage = background.bytes
    ? `data:image/png;base64,${Buffer.from(background.bytes).toString('base64')}`
    : undefined;

  // Idempotent: a re-render replaces the prior set rather than accumulating.
  await db().delete(draftAssets).where(eq(draftAssets.draftId, draft.id));

  const assetIds: number[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const png = await renderSlide({
      spec,
      index: i + 1,
      total: specs.length,
      handle: self?.handle ?? 'account',
      palette,
      ...(backgroundImage ? { backgroundImage } : {}),
    });

    const uploaded = await uploadAsset(`${draft.id}/slide-${i + 1}.png`, png, 'image/png');

    const [row] = await db()
      .insert(draftAssets)
      .values({
        draftId: draft.id,
        kind: 'slide',
        slideIndex: i + 1,
        storagePath: uploaded.storagePath,
        publicUrl: uploaded.publicUrl,
        provider: imageProvider.id,
      })
      .returning({ id: draftAssets.id });
    assetIds.push(row!.id);

    await ctx.save({
      progress: (i + 1) / specs.length,
      label: `rendered slide ${i + 1}/${specs.length}`,
    });
  }

  await ctx.save({
    progress: 1,
    label: `${assetIds.length} slide(s) rendered`,
    checkpoint: { assetIds },
  });
}
