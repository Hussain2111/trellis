import { describe, expect, it } from 'vitest';
import { JOB_TYPES, parsePayload } from '../lib/jobs/types';

describe('job payload schemas', () => {
  it('applies defaults for scan_account', () => {
    const parsed = parsePayload('scan_account', { accountId: 1 });
    expect(parsed).toEqual({ accountId: 1, limit: 100 });
  });

  it('rejects a malformed payload', () => {
    expect(() => parsePayload('scan_account', { accountId: 'not-a-number' })).toThrow();
  });

  it('registers every job type used by the pipeline', () => {
    expect(JOB_TYPES).toEqual(
      expect.arrayContaining([
        'scan_account',
        'discover_competitors',
        'compute_features',
        'classify_hooks',
        'run_analysis',
        'build_voice_profile',
        'generate_drafts',
        'render_slides',
        'publish_due',
      ]),
    );
  });
});
