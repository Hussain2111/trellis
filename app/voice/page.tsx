import { activeVoice } from '@/lib/analysis/voice';
import { Badge, Empty, Panel, PanelHeader } from '@/components/ui/primitives';

export const dynamic = 'force-dynamic';

function FieldRow({
  label,
  value,
}: {
  label: string;
  value: string | string[];
}): React.JSX.Element {
  return (
    <div className="border-b border-line px-4 py-2.5 last:border-b-0">
      <div className="label mb-1">{label}</div>
      {Array.isArray(value) ? (
        value.length === 0 ? (
          <span className="text-[12px] text-ink-faint">none</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {value.map((v) => (
              <Badge key={v}>{v}</Badge>
            ))}
          </div>
        )
      ) : (
        <p className="text-[13px] text-ink">{value}</p>
      )}
    </div>
  );
}

export default async function VoicePage(): Promise<React.JSX.Element> {
  const voice = await activeVoice();

  if (!voice) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-6">
        <Panel>
          <PanelHeader title="Voice profile" />
          <Empty
            title="No voice profile yet."
            detail="Built automatically from your top captions once analysis has run."
          />
        </Panel>
      </div>
    );
  }

  const { fields } = voice;

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-[20px] leading-tight font-semibold">Voice profile</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            Reverse-engineered from your own captions — used to keep every draft sounding like you.
          </p>
        </div>
        <Badge tone="signal">v{voice.version}</Badge>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Summary" />
          <div className="px-4 py-3 text-[13px] whitespace-pre-wrap text-ink">{voice.markdown}</div>
        </Panel>

        <Panel>
          <PanelHeader title="Fields" />
          <FieldRow label="Tone" value={fields.tone} />
          <FieldRow label="Sentence rhythm" value={fields.sentence_rhythm} />
          <FieldRow label="Vocabulary" value={fields.vocabulary} />
          <FieldRow label="Recurring phrases" value={fields.recurring_phrases} />
          <FieldRow label="Banned words" value={fields.banned_words} />
          <FieldRow label="CTA style" value={fields.cta_style} />
          <FieldRow label="Emoji policy" value={fields.emoji_policy} />
          <FieldRow label="Formatting habits" value={fields.formatting_habits} />
          <FieldRow label="Recurring subjects" value={fields.recurring_subjects} />
        </Panel>
      </div>
    </div>
  );
}
