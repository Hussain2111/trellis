import type { Provider } from '../types';

export interface TranscribeRequest {
  /** Local path to the downloaded clip. Deleted by the caller afterwards. */
  audioPath: string;
  /** Only the opening matters: reel hooks live in the first few seconds. */
  seconds: number;
}

export interface TranscribeResult {
  text: string;
  model: string;
  durationMs: number;
}

export interface TranscriptionProvider extends Provider {
  /** False when the binary or model file is missing — callers degrade to caption-only. */
  available(): Promise<boolean>;
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
}
