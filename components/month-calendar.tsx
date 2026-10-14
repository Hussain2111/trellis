'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CopyField } from './copy-field';
import { CloseIcon, PlusIcon, TrashIcon } from './icons';
import { forgetAlerts } from '@/lib/client/alerts';
import { monthLabel, riyadhMonthMatrix, shiftMonth } from '@/lib/time';

/**
 * A month, drawn as a month.
 *
 * The first version grouped drafts into "Week of 17 Aug" headings and listed
 * them. That is a to-do list wearing a calendar's name: you cannot see that the
 * 12th is empty, you cannot see the shape of a month, and adding something to a
 * particular day means opening a form and typing the date back in. Here the
 * date is the thing you click.
 *
 * Every boundary is Riyadh. Nothing in this file does arithmetic on dates —
 * `lib/time.ts` owns that, and the entries arrive already keyed to a Riyadh day.
 */

export interface Entry {
  id: number;
  dayKey: string;
  timeLabel: string;
  state: 'planned' | 'due' | 'overdue' | 'published';
  format: string | null;
  title: string | null;
  hook: string | null;
  caption: string | null;
  hashtags: string[] | null;
  notes: string | null;
}

const STATE_DOT: Record<Entry['state'], string> = {
  planned: 'bg-ink-faint',
  due: 'bg-accent',
  overdue: 'bg-negative',
  published: 'bg-positive',
};

const STATE_LABELS: Record<Entry['state'], string> = {
  planned: 'Planned',
  due: 'Due soon',
  overdue: 'Overdue',
  published: 'Posted',
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

type Overlay = { kind: 'new'; day: string } | { kind: 'entry'; id: number } | null;

export function MonthCalendar({
  entries,
  initialMonth,
  todayKey,
}: {
  entries: Entry[];
  initialMonth: string;
  todayKey: string;
}) {
  const router = useRouter();
  const [month, setMonth] = useState(initialMonth);
  const [overlay, setOverlay] = useState<Overlay>(null);

  const weeks = riyadhMonthMatrix(month);
  const byDay = new Map<string, Entry[]>();
  for (const entry of entries) {
    byDay.set(entry.dayKey, [...(byDay.get(entry.dayKey) ?? []), entry]);
  }

  const open = overlay?.kind === 'entry' ? entries.find((e) => e.id === overlay.id) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">{monthLabel(month)}</h2>
        <div className="flex items-center gap-1">
          <MonthButton label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
            ←
          </MonthButton>
          <button
            type="button"
            onClick={() => setMonth(todayKey.slice(0, 7))}
            className="rounded-lg border border-rule px-3 py-1.5 text-xs font-medium text-ink-muted hover:text-ink"
          >
            Today
          </button>
          <MonthButton label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>
            →
          </MonthButton>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-rule bg-card">
        <div className="grid grid-cols-7 border-b border-rule">
          {WEEKDAYS.map((day) => (
            <div
              key={day}
              className="px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-ink-faint"
            >
              <span className="hidden sm:inline">{day}</span>
              <span className="sm:hidden">{day[0]}</span>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {weeks.flat().map((day, i) => {
            const inMonth = day.startsWith(month);
            const dayEntries = byDay.get(day) ?? [];
            const isToday = day === todayKey;

            return (
              <div
                key={day}
                className={`group relative min-h-[5.5rem] border-rule p-1.5 sm:min-h-[7rem] ${
                  i % 7 !== 6 ? 'border-r' : ''
                } ${i < 35 ? 'border-b' : ''} ${inMonth ? '' : 'bg-paper-sunk/40'}`}
              >
                <div className="flex items-start justify-between">
                  <span
                    className={`grid size-6 place-items-center rounded-full text-xs ${
                      isToday
                        ? 'border border-action-edge bg-action font-semibold text-on-action'
                        : inMonth
                          ? 'text-ink-muted'
                          : 'text-ink-faint'
                    }`}
                  >
                    {Number(day.slice(8))}
                  </span>

                  {/* Always reachable on touch, quiet until hover on a pointer.
                      The plus is the whole point: a day is where you add to. */}
                  <button
                    type="button"
                    onClick={() => setOverlay({ kind: 'new', day })}
                    aria-label={`Add a post on ${day}`}
                    className="rounded-md p-0.5 text-ink-faint transition-opacity hover:bg-paper-sunk hover:text-accent focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                  >
                    <PlusIcon className="size-4" />
                  </button>
                </div>

                <ul className="mt-1 space-y-1">
                  {dayEntries.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => setOverlay({ kind: 'entry', id: entry.id })}
                        className="flex w-full items-center gap-1 rounded-md bg-paper-sunk px-1.5 py-1 text-left text-[11px] text-ink hover:bg-accent-soft"
                      >
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${STATE_DOT[entry.state]}`}
                          aria-hidden
                        />
                        <span className="truncate">
                          {entry.title || entry.hook || entry.format || 'Draft'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>

      <Legend />

      {overlay?.kind === 'new' ? (
        <Sheet title={`New post — ${overlay.day}`} onClose={() => setOverlay(null)}>
          <EntryForm
            day={overlay.day}
            onSaved={() => {
              setOverlay(null);
              forgetAlerts();
              router.refresh();
            }}
          />
        </Sheet>
      ) : null}

      {open ? (
        <Sheet
          title={open.title || open.hook || 'Draft'}
          onClose={() => setOverlay(null)}
          subtitle={`${STATE_LABELS[open.state]} · ${open.dayKey} at ${open.timeLabel}${
            open.format ? ` · ${open.format}` : ''
          }`}
        >
          <EntryDetail
            entry={open}
            onChanged={() => {
              setOverlay(null);
              forgetAlerts();
              router.refresh();
            }}
          />
        </Sheet>
      ) : null}
    </div>
  );
}

function MonthButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="grid size-8 place-items-center rounded-lg border border-rule text-sm text-ink-muted hover:text-ink"
    >
      {children}
    </button>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
      {(Object.keys(STATE_LABELS) as Entry['state'][]).map((state) => (
        <span key={state} className="inline-flex items-center gap-1.5">
          <span className={`size-1.5 rounded-full ${STATE_DOT[state]}`} aria-hidden />
          {STATE_LABELS[state]}
        </span>
      ))}
      <span className="ml-auto">Times are Riyadh.</span>
    </div>
  );
}

/** A plain overlay — no dependency, closes on backdrop click and on Escape. */
function Sheet({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-card shadow-lift sm:rounded-2xl">
        <header className="sticky top-0 flex items-start justify-between gap-4 border-b border-rule bg-card px-5 py-4">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">{title}</h3>
            {subtitle ? <p className="mt-0.5 text-xs text-ink-faint">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            autoFocus
            className="shrink-0 rounded-lg p-1 text-ink-faint hover:text-ink"
          >
            <CloseIcon className="size-5" />
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function EntryDetail({ entry, onChanged }: { entry: Entry; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  async function act(body: object) {
    setBusy(true);
    try {
      await fetch(`/api/calendar/${entry.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await fetch(`/api/calendar/${entry.id}`, { method: 'DELETE' });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="divide-y divide-rule">
        <CopyField label="Hook" value={entry.hook} />
        <CopyField label="Caption" value={entry.caption} multiline />
        <CopyField
          label="Hashtags"
          value={entry.hashtags?.length ? entry.hashtags.join(' ') : null}
        />
        <CopyField label="Notes" value={entry.notes} multiline />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {entry.state !== 'published' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act({ action: 'publish' })}
            className="rounded-full border border-action-edge bg-action px-4 py-2 text-xs font-medium text-on-action hover:bg-action-hover disabled:opacity-50"
          >
            Mark posted
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void remove()}
          className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-rule px-4 py-2 text-xs font-medium text-ink-muted hover:text-negative disabled:opacity-50"
        >
          <TrashIcon className="size-3.5" />
          Delete
        </button>
      </div>
    </>
  );
}

/**
 * The date is already decided — it is the day you clicked. Only the time is
 * asked for, and it is asked for as a Riyadh time, which is what the server
 * stores it as.
 */
function EntryForm({ day, onSaved }: { day: string; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);

  async function submit(form: FormData) {
    setSaving(true);
    try {
      const hashtags = String(form.get('hashtags') ?? '')
        .split(/[\s,]+/)
        .map((tag) => tag.trim())
        .filter(Boolean);

      await fetch('/api/calendar', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          day,
          timeOfDay: String(form.get('timeOfDay') || '12:00'),
          format: String(form.get('format') || '') || undefined,
          title: String(form.get('title') || '') || undefined,
          hook: String(form.get('hook') || '') || undefined,
          caption: String(form.get('caption') || '') || undefined,
          notes: String(form.get('notes') || '') || undefined,
          hashtags,
        }),
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <form action={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Time (Riyadh)">
          <input
            type="time"
            name="timeOfDay"
            defaultValue="12:00"
            className="w-full rounded-lg border border-control bg-paper px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Format">
          <select
            name="format"
            className="w-full rounded-lg border border-control bg-paper px-3 py-2 text-sm"
          >
            <option value="">—</option>
            <option value="carousel">Carousel</option>
            <option value="reel">Reel</option>
            <option value="image">Photo</option>
          </select>
        </Field>
      </div>

      <Field label="Title">
        <input
          name="title"
          autoComplete="off"
          className="w-full rounded-lg border border-control bg-paper px-3 py-2 text-sm"
        />
      </Field>
      <Field label="Hook">
        <input
          name="hook"
          autoComplete="off"
          className="w-full rounded-lg border border-control bg-paper px-3 py-2 text-sm"
        />
      </Field>
      <Field label="Caption">
        <textarea
          name="caption"
          rows={4}
          className="w-full rounded-lg border border-control bg-paper px-3 py-2 text-sm"
        />
      </Field>
      <Field label="Hashtags">
        <input
          name="hashtags"
          placeholder="#kbeauty #skincare"
          className="w-full rounded-lg border border-control bg-paper px-3 py-2 text-sm"
        />
      </Field>
      <Field label="Notes">
        <textarea
          name="notes"
          rows={2}
          className="w-full rounded-lg border border-control bg-paper px-3 py-2 text-sm"
        />
      </Field>

      <button
        type="submit"
        disabled={saving}
        className="w-full rounded-full border border-action-edge bg-action px-4 py-2.5 text-sm font-medium text-on-action hover:bg-action-hover disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save draft'}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">{label}</span>
      {children}
    </label>
  );
}
