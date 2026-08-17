import path from 'node:path';
import type { ProviderHealth } from '../types';
import type { TranscribeRequest, TranscribeResult, TranscriptionProvider } from './types';

export class FakeTranscriber implements TranscriptionProvider {
  readonly id = 'fake-whisper';
  readonly kind = 'transcription' as const;
  readonly costsMoney = false;
  readonly costNote = 'Fake transcription. No binary, no cost.';

  async health(): Promise<ProviderHealth> {
    return { ok: true, detail: 'fake transcriber is always healthy' };
  }

  async available(): Promise<boolean> {
    return true;
  }

  async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
    const stem = path.basename(request.audioPath).replace(/\.[^.]+$/, '');
    return {
      text: `Here's the thing nobody tells you about ${stem}`,
      model: 'fake-base.en',
      durationMs: 5,
    };
  }
}

/** Degraded stand-in used when whisper.cpp is genuinely absent. */
export class UnavailableTranscriber implements TranscriptionProvider {
  readonly id = 'whisper-unavailable';
  readonly kind = 'transcription' as const;
  readonly costsMoney = false;
  readonly costNote = 'whisper.cpp not installed — captions only.';
  private readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  async health(): Promise<ProviderHealth> {
    return { ok: false, detail: this.reason };
  }

  async available(): Promise<boolean> {
    return false;
  }

  async transcribe(): Promise<TranscribeResult> {
    throw new Error(`Transcription unavailable: ${this.reason}`);
  }
}
