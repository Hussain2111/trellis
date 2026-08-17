import { describe, expect, it } from 'vitest';
import { normalizeDataset, normalizePost, normalizePostType } from '../lib/ingest/normalize';
import testFixture from '../fixtures/testaccount.json';

describe('normalizePostType', () => {
  it('recognizes a clips/reel product type', () => {
    expect(normalizePostType({ productType: 'clips', isVideo: true })).toBe('reel');
  });

  it('recognizes a sidecar as a carousel', () => {
    expect(normalizePostType({ type: 'Sidecar' })).toBe('carousel');
  });

  it('recognizes multiple childPosts as a carousel even without a type hint', () => {
    expect(normalizePostType({ childPosts: [{}, {}, {}] })).toBe('carousel');
  });

  it('falls back to video for a long-form video with no clips hint', () => {
    expect(normalizePostType({ isVideo: true, videoDuration: 180 })).toBe('video');
  });

  it('is honest about unrecognized shapes', () => {
    expect(normalizePostType({})).toBe('unknown');
  });
});

describe('normalizePost', () => {
  it('returns null when there is no shortcode', () => {
    expect(normalizePost({ caption: 'no id here' })).toBeNull();
  });

  it('extracts the first line as part of the caption and keeps the raw row', () => {
    const post = normalizePost({
      shortCode: 'ABC123',
      caption: 'Hook line\n\nBody text',
      likesCount: 100,
    });
    expect(post?.shortcode).toBe('ABC123');
    expect(post?.caption).toBe('Hook line\n\nBody text');
    expect(post?.likes).toBe(100);
    expect(post?.raw).toMatchObject({ shortCode: 'ABC123' });
  });

  it('deduplicates media urls from child posts and the top-level fields', () => {
    const post = normalizePost({
      shortCode: 'XYZ',
      displayUrl: 'https://x.com/a.jpg',
      childPosts: [{ displayUrl: 'https://x.com/a.jpg' }, { displayUrl: 'https://x.com/b.jpg' }],
    });
    expect(post?.mediaUrls.sort()).toEqual(['https://x.com/a.jpg', 'https://x.com/b.jpg']);
  });
});

describe('normalizeDataset against the recorded fixture', () => {
  it('normalizes every post and recovers the profile from owner fields', () => {
    const { profile, posts } = normalizeDataset(testFixture as unknown[], 'testaccount');
    expect(posts).toHaveLength(6);
    expect(profile?.handle).toBe('testaccount');
    expect(profile?.followers).toBe(42000);
  });

  it('classifies reels, carousels, and images correctly from the fixture', () => {
    const { posts } = normalizeDataset(testFixture as unknown[], 'testaccount');
    const byShortcode = Object.fromEntries(posts.map((p) => [p.shortcode, p]));
    expect(byShortcode.CTest0001?.type).toBe('reel');
    expect(byShortcode.CTest0002?.type).toBe('carousel');
    expect(byShortcode.CTest0002?.carouselCount).toBe(3);
    expect(byShortcode.CTest0003?.type).toBe('image');
  });

  it('every normalized post keeps its untouched raw payload', () => {
    const { posts } = normalizeDataset(testFixture as unknown[], 'testaccount');
    for (const post of posts) {
      expect(post.raw).toBeTruthy();
    }
  });
});
