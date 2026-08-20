'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, Field, Input, Select } from '@/components/ui/primitives';
import { tickPublish } from '@/app/actions/tick';

/** Pokes the job queue every 20s while the calendar is open, so a due post
 * can publish without waiting for the next cron sweep. */
export function CalendarTickPoller(): null {
  const router = useRouter();
  useEffect(() => {
    const interval = setInterval(() => {
      void tickPublish().then(() => router.refresh());
    }, 20_000);
    return () => clearInterval(interval);
  }, [router]);
  return null;
}

export function DeleteEntryButton({ entryId }: { entryId: number }): React.JSX.Element {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function onClick(): Promise<void> {
    setLoading(true);
    await fetch(`/api/schedule/${entryId}`, { method: 'DELETE' });
    router.refresh();
    setLoading(false);
  }

  return (
    <Button size="sm" variant="ghost" onClick={() => void onClick()} disabled={loading}>
      delete
    </Button>
  );
}

export function MarkPostedButton({ entryId }: { entryId: number }): React.JSX.Element {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function onClick(): Promise<void> {
    setLoading(true);
    await fetch(`/api/schedule/${entryId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark_posted' }),
    });
    router.refresh();
    setLoading(false);
  }

  return (
    <Button size="sm" variant="default" onClick={() => void onClick()} disabled={loading}>
      mark posted
    </Button>
  );
}

export interface EntryDraft {
  id: number;
  scheduledFor: string;
  format: string;
  title: string;
  hook: string;
  caption: string;
  hashtags: string[];
  notes: string;
}

/** `datetime-local` wants local wall-clock with no zone, to the minute. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * v1 filled the calendar from generated drafts. v2 has no generation, so this
 * is now the only way an entry gets created — the calendar would otherwise be
 * permanently empty. The same form edits an existing entry when handed one.
 */
export function NewEntryForm({
  entry,
  onDone,
}: {
  entry?: EntryDraft;
  onDone?: () => void;
} = {}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(Boolean(entry));
  const [scheduledFor, setScheduledFor] = useState(entry ? toLocalInput(entry.scheduledFor) : '');
  const [format, setFormat] = useState(entry?.format ?? 'image');
  const [title, setTitle] = useState(entry?.title ?? '');
  const [hook, setHook] = useState(entry?.hook ?? '');
  const [caption, setCaption] = useState(entry?.caption ?? '');
  const [hashtags, setHashtags] = useState((entry?.hashtags ?? []).join(' '));
  const [notes, setNotes] = useState(entry?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = {
        // `datetime-local` has no zone; the browser's own zone is the one the
        // user typed in, so let Date resolve it and store the real instant.
        scheduledFor: new Date(scheduledFor).toISOString(),
        format,
        title,
        hook: hook.trim() || null,
        caption,
        hashtags: hashtags
          .split(/[\s,]+/)
          .map((h) => h.replace(/^#/, '').trim())
          .filter(Boolean),
        notes: notes.trim() || null,
      };

      const response = entry
        ? await fetch(`/api/schedule/${entry.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'update', ...body }),
          })
        : await fetch('/api/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Could not save the entry.');
      setOpen(false);
      onDone?.();
      if (!entry) {
        // Only a create form is reused; an edit form unmounts on save.
        setScheduledFor('');
        setTitle('');
        setHook('');
        setCaption('');
        setHashtags('');
        setNotes('');
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the entry.');
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        plan a post
      </Button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="w-full space-y-3 border-t border-line px-4 py-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="When">
          <Input
            type="datetime-local"
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
            required
          />
        </Field>
        <Field label="Format">
          <Select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="image">image</option>
            <option value="carousel">carousel</option>
            <option value="reel">reel</option>
            <option value="story">story</option>
          </Select>
        </Field>
      </div>
      <Field label="Title">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="working name"
        />
      </Field>
      <Field label="Hook">
        <Input
          value={hook}
          onChange={(e) => setHook(e.target.value)}
          placeholder="the opening line"
        />
      </Field>
      <Field label="Caption">
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          rows={4}
          className="w-full rounded-[3px] border border-line-strong bg-surface-2 px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-signal"
        />
      </Field>
      <Field label="Hashtags">
        <Input
          value={hashtags}
          onChange={(e) => setHashtags(e.target.value)}
          placeholder="space or comma separated"
        />
      </Field>
      <Field label="Notes">
        <Input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="anything you want to remember"
        />
      </Field>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={saving || !scheduledFor}>
          {saving ? 'saving…' : 'save'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            onDone?.();
          }}
          disabled={saving}
        >
          cancel
        </Button>
        {error ? <span className="text-[12px] text-negative">{error}</span> : null}
      </div>
    </form>
  );
}

/** One calendar row, with an inline edit form the page itself cannot hold. */
export function EntryActions({
  entry,
  canPost,
}: {
  entry: EntryDraft;
  canPost: boolean;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return <NewEntryForm entry={entry} onDone={() => setEditing(false)} />;
  }

  return (
    <div className="flex shrink-0 gap-2">
      {canPost ? <MarkPostedButton entryId={entry.id} /> : null}
      <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
        edit
      </Button>
      <DeleteEntryButton entryId={entry.id} />
    </div>
  );
}
