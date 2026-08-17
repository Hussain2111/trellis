import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropTempDb, useTempDb } from './helpers';
import { DEFAULT_SETTINGS, getSetting, getSettings, setSetting, setSettings } from '@/lib/settings';
import { db } from '@/lib/db/client';
import { settings } from '@/lib/db/schema';

beforeAll(() => useTempDb());
afterAll(() => dropTempDb());

describe('settings', () => {
  it('returns defaults for anything unset', () => {
    expect(getSetting('scanCooldownDays')).toBe(DEFAULT_SETTINGS.scanCooldownDays);
    expect(getSettings().publishingMode).toBe('manual');
  });

  it('round-trips values', () => {
    setSetting('handle', 'someone');
    setSetting('formatMix', { reel: 0.6, carousel: 0.3, image: 0.1 });
    expect(getSetting('handle')).toBe('someone');
    expect(getSetting('formatMix').reel).toBeCloseTo(0.6);
  });

  it('rejects invalid values rather than storing them', () => {
    expect(() => setSetting('scanCooldownDays', -3)).toThrow();
    expect(() => setSetting('publishingMode', 'carrier-pigeon' as 'manual')).toThrow();
  });

  it('falls back to the default when a stored row is corrupt', () => {
    db()
      .insert(settings)
      .values({ key: 'analysisWindowDays', value: '"not a number"' })
      .onConflictDoUpdate({ target: settings.key, set: { value: '"not a number"' } })
      .run();
    expect(getSetting('analysisWindowDays')).toBe(DEFAULT_SETTINGS.analysisWindowDays);
  });

  it('writes a partial update without clobbering the rest', () => {
    setSettings({ niche: 'landscape photography' });
    expect(getSetting('handle')).toBe('someone');
    expect(getSetting('niche')).toBe('landscape photography');
  });
});
