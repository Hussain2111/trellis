import { activeVoice, voiceVersions } from '@/lib/analysis/voice';
import { Badge, Button, Empty, Panel, PanelHeader } from '@/components/ui/primitives';
import { GeneratedBy } from '@/components/ui/data';
import { ActionButton } from '@/components/action-button';
import { activateVoiceAction, runJobAction, saveVoiceAction } from '../actions';
import { formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function VoicePage(): Promise<React.JSX.Element> {
  const voice = activeVoice();
  const versions = voiceVersions();

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold">Voice</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-ink-muted">
            Built from your best captions, then edited by you. Your edits always beat regeneration.
            It rides along in every generation prompt, so it is kept deliberately short.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {voice ? <GeneratedBy value={voice.generatedBy} /> : null}
          <ActionButton
            action={runJobAction.bind(null, 'build_voice_profile')}
            label={voice ? 'regenerate' : 'build profile'}
            confirm={
              voice
                ? 'Regenerate? The current version is kept and you can switch back to it.'
                : undefined
            }
          />
        </div>
      </header>

      {!voice ? (
        <Panel>
          <Empty
            title="No voice profile yet."
            detail="It reads your top ~20 captions in one call. Without it, drafts default to a generic register you will not recognise as yours."
          />
        </Panel>
      ) : (
        <>
          <Panel className="mb-4">
            <PanelHeader
              title={`Version ${voice.version}`}
              aside={voice.editedByUser ? <Badge tone="signal">edited by you</Badge> : null}
            />
            <form action={saveVoiceAction} className="px-4 py-4">
              <textarea
                name="markdown"
                defaultValue={voice.markdown}
                rows={16}
                className="w-full rounded-[3px] border border-line-strong bg-canvas px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink focus:border-signal/50 focus:outline-none"
              />
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[11px] text-ink-faint">
                  Saving creates a new version. Nothing is overwritten.
                </span>
                <Button variant="primary" size="sm" type="submit">
                  Save as new version
                </Button>
              </div>
            </form>
          </Panel>

          <Panel className="mb-4">
            <PanelHeader title="Structured fields" />
            <dl className="divide-y divide-line">
              {Object.entries(voice.fields).map(([key, value]) => (
                <div key={key} className="flex gap-4 px-4 py-2">
                  <dt className="label w-40 shrink-0 pt-0.5">{key.replace(/_/g, ' ')}</dt>
                  <dd className="text-[13px] text-ink-muted">
                    {Array.isArray(value)
                      ? value.length > 0
                        ? value.join(', ')
                        : '—'
                      : String(value) || '—'}
                  </dd>
                </div>
              ))}
            </dl>
          </Panel>

          {versions.length > 1 ? (
            <Panel>
              <PanelHeader title="History" />
              <ul className="divide-y divide-line">
                {versions.map((version) => (
                  <li key={version.id} className="flex items-center gap-3 px-4 py-2">
                    <span className="metric text-[12px]">v{version.version}</span>
                    <span className="text-[12px] text-ink-faint">
                      {formatRelative(version.createdAt)}
                    </span>
                    {version.editedByUser ? <Badge tone="signal">yours</Badge> : null}
                    {version.active ? <Badge tone="good">active</Badge> : null}
                    <span className="ml-auto">
                      {version.active ? null : (
                        <ActionButton
                          action={activateVoiceAction.bind(null, version.id)}
                          label="restore"
                          variant="ghost"
                        />
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </>
      )}
    </div>
  );
}
