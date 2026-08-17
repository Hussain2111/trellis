import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../lib/bootstrap-env';

/**
 * `npm run bench:llm`
 *
 * Measures what this machine actually does, because every sizing decision in
 * this build depends on real prefill and generation numbers rather than the
 * estimates in the spec.
 *
 * Reports, per candidate model:
 *   - prefill (prompt eval) tok/s at 3 prompt sizes
 *   - generation tok/s
 *   - time-to-first-token at ~2,000 tokens, which is the number that decides
 *     whether long prompts can ever run locally
 * And for the embedding model:
 *   - texts/sec, extrapolated to a 1,100-post corpus (the Layer B workhorse)
 *
 * Usage:
 *   npm run bench:llm
 *   npm run bench:llm -- --models qwen3:4b,gemma3:4b --predict 96
 *   npm run bench:llm -- --quick
 */

const BASE_URL = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? '5m';

const DEFAULT_CANDIDATES = ['qwen3:4b', 'gemma3:4b', 'llama3.1:8b'];
const PROMPT_SIZES = [200, 800, 2000];

interface Args {
  models: string[];
  predict: number;
  quick: boolean;
  embedOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const quick = argv.includes('--quick');
  return {
    models: (get('--models') ?? '').split(',').filter(Boolean),
    predict: Number(get('--predict') ?? (quick ? 48 : 128)),
    quick,
    embedOnly: argv.includes('--embed-only'),
  };
}

interface GenerateStats {
  promptEvalCount: number;
  promptEvalDurationNs: number;
  evalCount: number;
  evalDurationNs: number;
  totalDurationNs: number;
  loadDurationNs: number;
}

async function generate(model: string, prompt: string, numPredict: number): Promise<GenerateStats> {
  const res = await fetch(`${BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      keep_alive: KEEP_ALIVE,
      options: { num_predict: numPredict, temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`/api/generate → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as Record<string, number>;
  return {
    promptEvalCount: body.prompt_eval_count ?? 0,
    promptEvalDurationNs: body.prompt_eval_duration ?? 0,
    evalCount: body.eval_count ?? 0,
    evalDurationNs: body.eval_duration ?? 0,
    totalDurationNs: body.total_duration ?? 0,
    loadDurationNs: body.load_duration ?? 0,
  };
}

/**
 * A prompt of roughly `tokens` tokens. Deliberately prose-like: synthetic
 * repeated tokens compress differently and would flatter the prefill number.
 */
function buildPrompt(tokens: number): string {
  const sentence =
    'The reel opened with a settings tip and the caption asked a question about lighting before the call to action. ';
  const perSentence = 22;
  const repeats = Math.max(1, Math.ceil(tokens / perSentence));
  return (
    'Summarise the following notes in one short sentence.\n\n' +
    sentence.repeat(repeats).slice(0, tokens * 4)
  );
}

async function installedModels(): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/api/tags`);
  if (!res.ok) throw new Error(`/api/tags → ${res.status}`);
  const body = (await res.json()) as { models?: { name: string }[] };
  return (body.models ?? []).map((m) => m.name);
}

async function ollamaVersion(): Promise<string> {
  try {
    const res = await fetch(`${BASE_URL}/api/version`);
    const body = (await res.json()) as { version?: string };
    return body.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

interface ModelResult {
  model: string;
  sizes: {
    requested: number;
    promptTokens: number;
    prefillTps: number;
    genTps: number;
    ttftS: number;
    totalS: number;
  }[];
  loadS: number;
  error?: string;
}

async function benchModel(model: string, args: Args): Promise<ModelResult> {
  const sizes = args.quick ? [PROMPT_SIZES[0]!, PROMPT_SIZES[2]!] : PROMPT_SIZES;
  const result: ModelResult = { model, sizes: [], loadS: 0 };

  try {
    // Warm-up: pays the model-load cost once so it doesn't pollute size #1.
    process.stdout.write(`  ${model}: loading…`);
    const warm = await generate(model, 'Say OK.', 4);
    result.loadS = warm.loadDurationNs / 1e9;
    process.stdout.write(` ${result.loadS.toFixed(1)}s\n`);

    for (const size of sizes) {
      process.stdout.write(`  ${model}: ${size}-token prompt…`);
      const stats = await generate(model, buildPrompt(size), args.predict);
      const prefillS = stats.promptEvalDurationNs / 1e9;
      const genS = stats.evalDurationNs / 1e9;
      const entry = {
        requested: size,
        promptTokens: stats.promptEvalCount,
        prefillTps: prefillS > 0 ? stats.promptEvalCount / prefillS : 0,
        genTps: genS > 0 ? stats.evalCount / genS : 0,
        ttftS: prefillS,
        totalS: stats.totalDurationNs / 1e9,
      };
      result.sizes.push(entry);
      process.stdout.write(
        ` prefill ${entry.prefillTps.toFixed(1)} tok/s · gen ${entry.genTps.toFixed(1)} tok/s · TTFT ${entry.ttftS.toFixed(1)}s\n`,
      );
    }
  } catch (error) {
    result.error = (error as Error).message;
    process.stdout.write(` failed: ${result.error}\n`);
  }
  return result;
}

interface EmbedResult {
  model: string;
  count: number;
  seconds: number;
  perSecond: number;
  corpusMinutes: number;
  dim: number;
  error?: string;
}

async function benchEmbeddings(model: string, count: number): Promise<EmbedResult> {
  const texts = Array.from(
    { length: count },
    (_, i) =>
      `The setting nobody tells you about, part ${i}: shoot at golden hour and drop the shutter.`,
  );
  const started = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts, keep_alive: KEEP_ALIVE }),
    });
    if (!res.ok) throw new Error(`/api/embed → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { embeddings?: number[][] };
    const seconds = (Date.now() - started) / 1000;
    const dim = body.embeddings?.[0]?.length ?? 0;
    const perSecond = count / seconds;
    return {
      model,
      count,
      seconds,
      perSecond,
      corpusMinutes: 1100 / perSecond / 60,
      dim,
    };
  } catch (error) {
    return {
      model,
      count,
      seconds: 0,
      perSecond: 0,
      corpusMinutes: 0,
      dim: 0,
      error: (error as Error).message,
    };
  }
}

function verdict(r: ModelResult): { usable: boolean; line: string } {
  if (r.error) return { usable: false, line: `unavailable — ${r.error}` };
  const small = r.sizes.find((s) => s.requested <= 200);
  const big = r.sizes.find((s) => s.requested >= 2000);
  if (!small) return { usable: false, line: 'no measurement' };

  // The Tier B ceiling is 800 tokens; what matters is whether a short
  // constrained call returns in a few seconds, not whether it can write essays.
  const shortCallS = small.ttftS + 64 / Math.max(small.genTps, 0.1);
  const usable = shortCallS < 20;
  const bigNote = big ? ` A 2k-token prompt costs ${big.ttftS.toFixed(0)}s of prefill alone.` : '';
  return {
    usable,
    line: usable
      ? `usable for Tier B — a short constrained call lands in ~${shortCallS.toFixed(0)}s.${bigNote}`
      : `too slow for interactive use — a short call takes ~${shortCallS.toFixed(0)}s.${bigNote}`,
  };
}

function table(results: ModelResult[]): string {
  const rows: string[] = [
    '| model | prompt tok | prefill tok/s | gen tok/s | TTFT |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const r of results) {
    if (r.error) {
      rows.push(`| ${r.model} | — | — | — | not available |`);
      continue;
    }
    for (const s of r.sizes) {
      rows.push(
        `| ${r.model} | ${s.promptTokens} | ${s.prefillTps.toFixed(1)} | ${s.genTps.toFixed(1)} | ${s.ttftS.toFixed(1)}s |`,
      );
    }
  }
  return rows.join('\n');
}

function writeNotes(section: string): void {
  const notesPath = path.join(process.cwd(), 'NOTES.md');
  const START = '<!-- BENCH:START -->';
  const END = '<!-- BENCH:END -->';
  const block = `${START}\n${section}\n${END}`;

  let existing = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : '';
  if (existing.includes(START) && existing.includes(END)) {
    existing = existing.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block);
  } else {
    existing = existing.trimEnd() + `\n\n## M0 benchmark — measured on this machine\n\n${block}\n`;
  }
  fs.writeFileSync(notesPath, existing);
  console.log(`\nWrote results to ${notesPath}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log('Trellis LLM benchmark');
  console.log(`  host    ${BASE_URL}`);
  console.log(`  cpu     ${os.cpus()[0]?.model ?? 'unknown'} (${os.cpus().length} threads)`);
  console.log(`  memory  ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB total`);
  console.log(`  ollama  ${await ollamaVersion()}\n`);

  let installed: string[];
  try {
    installed = await installedModels();
  } catch (error) {
    console.error(
      `Could not reach Ollama at ${BASE_URL} (${(error as Error).message}).\n` +
        'Start it (`ollama serve`) and try again.',
    );
    process.exit(1);
  }

  const embedModel = process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text';
  const candidates = args.models.length
    ? args.models
    : DEFAULT_CANDIDATES.filter((c) => installed.some((i) => i === c || i.startsWith(`${c}:`)));

  const missing = (args.models.length ? args.models : DEFAULT_CANDIDATES).filter(
    (c) => !installed.some((i) => i === c || i.startsWith(`${c}:`)),
  );
  if (missing.length) {
    console.log('Not installed (skipped). Pull any you want measured:');
    for (const m of missing) console.log(`  ollama pull ${m}`);
    console.log(
      '\nModel tags churn fast — check https://ollama.com/library before trusting these names.\n',
    );
  }

  const results: ModelResult[] = [];
  if (!args.embedOnly) {
    if (candidates.length === 0) {
      console.log('No generation models installed to benchmark.\n');
    } else {
      console.log('Generation:');
      for (const model of candidates) results.push(await benchModel(model, args));
      console.log('');
    }
  }

  console.log('Embeddings:');
  const embedInstalled = installed.some(
    (i) => i === embedModel || i.startsWith(`${embedModel}:`),
  );
  if (!embedInstalled) {
    console.log(`  ${embedModel} not installed. Run: ollama pull ${embedModel}\n`);
  }
  const embed = await benchEmbeddings(embedModel, args.quick ? 20 : 50);
  if (embed.error) {
    console.log(`  ${embedModel}: failed — ${embed.error}\n`);
  } else {
    console.log(
      `  ${embedModel}: ${embed.perSecond.toFixed(1)} texts/s (dim ${embed.dim}) → ` +
        `~${embed.corpusMinutes.toFixed(1)} min for a 1,100-post corpus\n`,
    );
  }

  // --- recommendation ---
  const scored = results
    .filter((r) => !r.error)
    .map((r) => ({ r, v: verdict(r) }))
    .sort((a, b) => {
      const at = a.r.sizes[0]?.genTps ?? 0;
      const bt = b.r.sizes[0]?.genTps ?? 0;
      return bt - at;
    });
  const best = scored.find((s) => s.v.usable) ?? scored[0];

  console.log('Verdict:');
  for (const { r, v } of scored) console.log(`  ${r.model}: ${v.line}`);
  if (best) {
    console.log(`\nRecommended OLLAMA_MODEL=${best.r.model}`);
    console.log('Set it in .env.local, or in Settings once the app is running.');
  }

  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const section = [
    `_Measured ${now} · ${os.cpus()[0]?.model ?? 'unknown cpu'} · ` +
      `${(os.totalmem() / 1024 ** 3).toFixed(1)} GB RAM · Ollama ${await ollamaVersion()}_`,
    '',
    results.length ? table(results) : '_No generation models were available to benchmark._',
    '',
    embed.error
      ? `Embeddings (\`${embedModel}\`): failed — ${embed.error}`
      : `Embeddings (\`${embedModel}\`): **${embed.perSecond.toFixed(1)} texts/s**, dim ${embed.dim} → ` +
        `~**${embed.corpusMinutes.toFixed(1)} min** to embed 1,100 posts.`,
    '',
    '**Verdict**',
    '',
    ...scored.map(({ r, v }) => `- \`${r.model}\` — ${v.line}`),
    '',
    best ? `**Chosen:** \`OLLAMA_MODEL=${best.r.model}\`` : '**Chosen:** none — nothing usable yet.',
    '',
    '_Prefill is the number that matters: it is why Tier B prompts are capped at ' +
      '`TIER_B_MAX_PROMPT_TOKENS` and why all long-context reasoning goes to Tier A._',
  ].join('\n');

  writeNotes(section);
}

await main();
