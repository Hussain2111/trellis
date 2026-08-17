import { describe, expect, it } from 'vitest';
import { extractHashtags, rankAccountsByEngagement, topHashtags } from '../lib/analysis/hashtags';

describe('extractHashtags', () => {
  it('pulls hashtags out lowercased, without the #', () => {
    expect(extractHashtags('Great day! #Photography #TIPS #reels')).toEqual([
      'photography',
      'tips',
      'reels',
    ]);
  });

  it('returns empty for no caption', () => {
    expect(extractHashtags(null)).toEqual([]);
    expect(extractHashtags('no tags here')).toEqual([]);
  });
});

describe('topHashtags', () => {
  it('ranks by frequency, breaking ties alphabetically', () => {
    const posts = [
      { caption: '#reels #photography' },
      { caption: '#reels #tips' },
      { caption: '#reels' },
      { caption: '#photography' },
    ];
    expect(topHashtags(posts, 3)).toEqual(['reels', 'photography', 'tips']);
  });

  it('respects the limit', () => {
    const posts = [{ caption: '#a #b #c #d' }];
    expect(topHashtags(posts, 2)).toHaveLength(2);
  });

  it('is empty when no posts have hashtags', () => {
    expect(topHashtags([{ caption: 'no tags' }, { caption: null }])).toEqual([]);
  });
});

describe('rankAccountsByEngagement', () => {
  it('ranks accounts by aggregate engagement across hashtags, excluding the self handle', () => {
    const ranked = rankAccountsByEngagement(
      [
        {
          hashtag: 'niche1',
          posts: [
            { username: 'big', likes: 10000, comments: 500 },
            { username: 'me', likes: 5000, comments: 100 },
            { username: 'small', likes: 100, comments: 5 },
          ],
        },
        {
          hashtag: 'niche2',
          posts: [{ username: 'big', likes: 8000, comments: 400 }],
        },
      ],
      new Set(['me']),
      5,
    );

    expect(ranked.map((r) => r.handle)).toEqual(['big', 'small']);
    expect(ranked[0]?.postCount).toBe(2);
    expect(ranked[0]?.hashtags).toEqual(['niche1', 'niche2']);
  });

  it('respects the limit and normalizes @-prefixed handles', () => {
    const ranked = rankAccountsByEngagement(
      [
        {
          hashtag: 'x',
          posts: [
            { username: '@a', likes: 300, comments: 10 },
            { username: 'b', likes: 200, comments: 10 },
            { username: 'c', likes: 100, comments: 10 },
          ],
        },
      ],
      new Set(),
      2,
    );
    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.handle).toBe('a');
  });
});
