import fs from 'node:fs';
import path from 'node:path';
import { assertProviderAllowed } from '../guard';
import { run, which } from '../../media/audio';
import type { ProviderHealth } from '../types';
import type { TranscribeRequest, TranscribeResult, TranscriptionProvider } from './types';

const DESCRIPTOR = {
  id: 'whisper.cpp',
  kind: 'transcription' as const,
  costsMoney: false,
  costNote: 'Local whisper.cpp. Free.',
};

/**
 * whisper.cpp as a subprocess. `base.en` on 15 seconds of audio is fast even on
 * this CPU — the expensive part is getting the video down, not transcribing it.
 *
 * The binary has been renamed across releases (`main` → `whisper-cli`), so
 * several names are probed before giving up.
 */
const BINARY_CANDIDATES = ['whisper-cli', 'whisper.cpp', 'whisper', 'main'];

export class WhisperTranscriber implements TranscriptionProvider {
  readonly id = DESCRIPTOR.id;
  readonly kind = DESCRIPTOR.kind;
  readonly costsMoney = DESCRIPTOR.costsMoney;
  readonly costNote = DESCRIPTOR.costNote;
  private readonly binary: string | null;
  private readonly modelPath: string | null;

  constructor(options: { binary?: string; modelPath?: string } = {}) {
    assertProviderAllowed(DESCRIPTOR);
    this.binary = options.binary || BINARY_CANDIDATES.map((b) => which(b)).find(Boolean) || null;
    this.modelPath = options.modelPath ?? null;
  }

  async health(): Promise<ProviderHealth> {
    if (!this.binary) {
      return {
        ok: false,
        detail: 'whisper.cpp not found. Set WHISPER_BIN, or captions-only analysis is used.',
      };
    }
    if (!this.modelPath || !fs.existsSync(this.modelPath)) {
      return {
        ok: false,
        detail: `Model file missing. Set WHISPER_MODEL_PATH to a ggml base.en model.`,
      };
    }
    return { ok: true, detail: `${path.basename(this.binary)} + ${path.basename(this.modelPath)}` };
  }

  async available(): Promise<boolean> {
    return (await this.health()).ok;
  }

  async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
    if (!this.binary || !this.modelPath) {
      throw new Error('whisper.cpp is not configured');
    }
    const started = Date.now();
    const outPrefix = request.audioPath.replace(/\.wav$/i, '');

    const result = await run(
      this.binary,
      [
        '-m', this.modelPath,
        '-f', request.audioPath,
        '-l', 'en',
        // Only the opening matters; the audio is already trimmed, and this caps
        // the work if a caller hands over something longer.
        '-d', String(request.seconds * 1000),
        '-otxt',
        '-of', outPrefix,
        '-np',
        '-nt',
      ],
      180_000,
    );

    const textFile = `${outPrefix}.txt`;
    let text = '';
    if (fs.existsSync(textFile)) {
      text = fs.readFileSync(textFile, 'utf8').trim();
      fs.rmSync(textFile, { force: true });
    } else if (result.code === 0) {
      text = result.stdout.trim();
    }

    if (result.code !== 0 && !text) {
      throw new Error(`whisper failed (${result.code}): ${result.stderr.slice(-300)}`);
    }

    return {
      text: text.replace(/\s+/g, ' ').trim(),
      model: path.basename(this.modelPath),
      durationMs: Date.now() - started,
    };
  }
}
