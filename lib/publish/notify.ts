import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import notifier from 'node-notifier';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { draftAssets, drafts } from '../db/schema';

/**
 * Mode A: manual. A notification at the scheduled time, then a "ready to post"
 * view. Zero API surface, zero setup, and it works the day you install this.
 */

export function notify(title: string, message: string): void {
  try {
    notifier.notify({ title, message, sound: false, wait: false });
  } catch {
    // A missing notification daemon must never fail a scheduled post.
    console.log(`[notify] ${title}: ${message}`);
  }
}

/** Caption formatted for copy-paste: body, blank line, then hashtags. */
export function formatForClipboard(draft: {
  caption: string;
  hashtags: unknown;
  cta: string | null;
}): string {
  const tags = Array.isArray(draft.hashtags) ? (draft.hashtags as string[]) : [];
  const normalised = tags.map((t) => (t.startsWith('#') ? t : `#${t}`));
  return [draft.caption.trim(), draft.cta?.trim(), normalised.join(' ')]
    .filter((part) => part && part.length > 0)
    .join('\n\n');
}

/** Zip a draft's rendered assets so they can be moved to a phone in one step. */
export async function zipAssets(draftId: number): Promise<string | null> {
  const assets = db().select().from(draftAssets).where(eq(draftAssets.draftId, draftId)).all();
  const files = assets
    .map((a) => a.localPath)
    .filter((p): p is string => !!p && fs.existsSync(p));

  if (files.length === 0) return null;

  const outDir = path.join(process.cwd(), 'data', 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `draft-${draftId}.zip`);

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(output);
    for (const file of files) archive.file(file, { name: path.basename(file) });

    const draft = db().select().from(drafts).where(eq(drafts.id, draftId)).get();
    if (draft) {
      archive.append(formatForClipboard(draft), { name: 'caption.txt' });
    }
    void archive.finalize();
  });

  return outPath;
}

export interface PostingChecklist {
  step: string;
  detail: string;
}

export function checklistFor(format: string): PostingChecklist[] {
  const common: PostingChecklist[] = [
    { step: 'Copy the caption', detail: 'Hashtags are already appended in the right order.' },
    { step: 'Check the first line', detail: 'It is the only part shown before "more".' },
  ];

  if (format === 'reel') {
    return [
      { step: 'Shoot to the beat list', detail: 'The hook line is what goes in the first two seconds, verbatim.' },
      { step: 'Vertical, 9:16', detail: 'Anything else gets cropped badly in the feed.' },
      ...common,
      { step: 'Add the on-screen text', detail: 'Per beat, as written — the hook has to be readable with sound off.' },
    ];
  }
  if (format === 'carousel') {
    return [
      { step: 'Download the slide zip', detail: 'Slides are numbered in posting order.' },
      { step: 'Upload in order', detail: 'Slide 1 is the hook and decides whether anyone swipes.' },
      ...common,
    ];
  }
  return [
    { step: 'Shoot or source the image', detail: 'The image direction is in the draft.' },
    ...common,
  ];
}
