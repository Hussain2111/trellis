import { providerStatuses } from '@/lib/providers';
import { monthlyCostSummary, recentRuns } from '@/lib/runs/log';
import { getSettings } from '@/lib/settings';
import { SmokeTest } from '@/components/smoke-test';
import {
  Badge,
  Button,
  Field,
  Input,
  Panel,
  PanelHeader,
  Select,
  Stat,
} from '@/components/ui/primitives';
import { formatRelative, formatUsd } from '@/lib/utils';
import { acknowledgePrivacyAction, saveSettingsAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function SettingsPage(): Promise<React.JSX.Element> {
  const settings = getSettings();
  const providers = await providerStatuses();
  const cost = monthlyCostSummary();
  const runs = recentRuns(12);

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <h1 className="mb-6 text-[20px] font-semibold">Settings</h1>

      {settings.privacyNoticeAcknowledgedAt === null ? (
        <Panel className="mb-4 border-signal/30 bg-signal/[0.05]">
          <div className="px-5 py-4">
            <div className="label text-signal/70">Before anything is sent to Google</div>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
              Tier A runs on Google AI Studio&apos;s free tier, and free-tier terms permit Google to
              use prompts to improve their products. Your captions are already public, so that is
              probably fine for analysis. Your <strong className="text-ink">voice profile</strong>{' '}
              and <strong className="text-ink">chat history</strong> are a different matter — those
              are yours and not public. The switch below keeps both on the local tier, at the cost
              of noticeably worse writing.
            </p>
            <form action={acknowledgePrivacyAction} className="mt-3">
              <Button size="sm" variant="primary" type="submit">
                Understood
              </Button>
            </form>
          </div>
        </Panel>
      ) : null}

      <form action={saveSettingsAction} className="grid gap-4">
        <Panel>
          <PanelHeader title="Account" />
          <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
            <Field label="Instagram handle" hint="Without the @.">
              <Input name="handle" defaultValue={settings.handle} placeholder="yourhandle" />
            </Field>
            <Field label="Posting cadence" hint="Posts per week; sets the draft batch size.">
              <Input name="postsPerWeek" type="number" min={0} defaultValue={settings.postsPerWeek} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Niche" hint="One sentence. It anchors every benchmark I make.">
                <Input
                  name="niche"
                  defaultValue={settings.niche}
                  placeholder="Landscape photography tutorials for beginners"
                />
              </Field>
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Analysis" />
          <div className="grid gap-4 px-4 py-4 sm:grid-cols-3">
            <Field label="Scan cooldown (days)" hint="Per account. Scraping costs credits.">
              <Input
                name="scanCooldownDays"
                type="number"
                min={1}
                defaultValue={settings.scanCooldownDays}
              />
            </Field>
            <Field label="Analysis window (days)">
              <Input
                name="analysisWindowDays"
                type="number"
                min={7}
                defaultValue={settings.analysisWindowDays}
              />
            </Field>
            <Field label="Publishing mode" hint="Mode B needs docs/instagram-setup.md first.">
              <Select name="publishingMode" defaultValue={settings.publishingMode}>
                <option value="manual">manual — notify me, I post</option>
                <option value="api">api — publish via Graph API</option>
              </Select>
            </Field>
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Models"
            aside={
              <div className="flex gap-2">
                <SmokeTest tier="A" label="test tier A" />
                <SmokeTest tier="B" label="test tier B" />
              </div>
            }
          />
          <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
            <Field
              label="Local model (tier B)"
              hint="Set by npm run bench:llm. Blank means Tier B is unavailable."
            >
              <Input
                name="ollamaModel"
                defaultValue={settings.ollamaModel || (process.env.OLLAMA_MODEL ?? '')}
                placeholder="qwen3:4b"
              />
            </Field>
            <label className="flex items-start gap-2.5 pt-6">
              <input
                type="checkbox"
                name="localOnlyVoiceAndChat"
                defaultChecked={settings.localOnlyVoiceAndChat}
                className="mt-0.5 accent-[var(--color-signal)]"
              />
              <span className="text-[13px]">
                Keep voice profile and chat local-only
                <span className="mt-0.5 block text-[12px] text-ink-faint">
                  Never sends either to Google. Slower, and the writing will be worse.
                </span>
              </span>
            </label>
          </div>
        </Panel>

        <div className="flex justify-end">
          <Button variant="primary" type="submit">
            Save settings
          </Button>
        </div>
      </form>

      <Panel className="mt-6">
        <PanelHeader
          title="Cost"
          aside={
            <Badge tone={cost.monthToDateUsd === 0 ? 'good' : 'bad'}>
              {formatUsd(cost.monthToDateUsd)} month to date
            </Badge>
          }
        />
        <div className="grid grid-cols-3 divide-x divide-line border-b border-line">
          <Stat label="Calls" value={<span className="tabular">{cost.callCount}</span>} />
          <Stat
            label="Billable calls"
            value={<span className="tabular">{cost.paidCallCount}</span>}
            tone={cost.paidCallCount > 0 ? 'bad' : 'good'}
          />
          <Stat
            label="Total"
            value={formatUsd(cost.monthToDateUsd)}
            tone={cost.monthToDateUsd === 0 ? 'good' : 'bad'}
            sub="should read $0.00"
          />
        </div>
        <ul className="divide-y divide-line">
          {providers.map((p) => (
            <li key={`${p.kind}-${p.id}`} className="flex items-center gap-3 px-4 py-2">
              <span className="font-mono text-[12px]">{p.id}</span>
              <span className="text-[12px] text-ink-faint">{p.costNote}</span>
              <span className="ml-auto">
                {p.costsMoney ? <Badge tone="bad">billable</Badge> : <Badge tone="good">free</Badge>}
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel className="mt-4">
        <PanelHeader title="Recent external calls" />
        {runs.length === 0 ? (
          <p className="px-4 py-6 text-center text-[12px] text-ink-faint">
            Nothing has left this machine yet.
          </p>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-line text-left">
                {['when', 'provider', 'operation', 'tier', 'ms', 'status'].map((h) => (
                  <th key={h} className="label px-4 py-1.5 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-1.5 text-ink-faint">{formatRelative(r.createdAt)}</td>
                  <td className="px-4 py-1.5 font-mono">{r.provider}</td>
                  <td className="px-4 py-1.5">{r.operation}</td>
                  <td className="px-4 py-1.5 font-mono">{r.tier}</td>
                  <td className="px-4 py-1.5 tabular">{r.durationMs ?? '—'}</td>
                  <td className="px-4 py-1.5">
                    <Badge
                      tone={r.status === 'ok' ? 'good' : r.status === 'quota' ? 'signal' : 'bad'}
                    >
                      {r.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
