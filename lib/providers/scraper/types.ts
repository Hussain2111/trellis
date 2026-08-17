import { z } from 'zod';
import type { Provider } from '../types';

/**
 * Scraper interface. Actor schemas drift, so the normalised shape here is
 * deliberately small and every field is optional except the shortcode — the
 * untouched payload is kept in `posts.raw` and re-normalisation is free.
 */

export const scrapedPostSchema = z.object({
  shortcode: z.string().min(1),
  type: z.enum(['image', 'carousel', 'reel', 'video', 'unknown']).default('unknown'),
  caption: z.string().nullable().default(null),
  takenAt: z.number().int().nullable().default(null),
  likes: z.number().int().nullable().default(null),
  comments: z.number().int().nullable().default(null),
  views: z.number().int().nullable().default(null),
  plays: z.number().int().nullable().default(null),
  durationS: z.number().nullable().default(null),
  carouselCount: z.number().int().nullable().default(null),
  thumbnailUrl: z.string().nullable().default(null),
  mediaUrls: z.array(z.string()).default([]),
  isSponsored: z.boolean().default(false),
  raw: z.unknown(),
});

export type ScrapedPost = z.infer<typeof scrapedPostSchema>;

export const scrapedProfileSchema = z.object({
  handle: z.string(),
  igUserId: z.string().nullable().default(null),
  fullName: z.string().nullable().default(null),
  bio: z.string().nullable().default(null),
  followers: z.number().int().nullable().default(null),
  following: z.number().int().nullable().default(null),
  postsCount: z.number().int().nullable().default(null),
  isVerified: z.boolean().default(false),
});

export type ScrapedProfile = z.infer<typeof scrapedProfileSchema>;

export interface ScrapeRequest {
  handle: string;
  limit: number;
  /** Stop as soon as one of these is seen. Newest-first fetch makes this cheap. */
  stopAtShortcodes?: Set<string>;
  onProgress?: (seen: number, label: string) => void;
}

export interface ScrapeResult {
  profile: ScrapedProfile | null;
  posts: ScrapedPost[];
  /** False when the run was cut short — surfaced honestly in the UI. */
  complete: boolean;
  note: string;
  itemsCharged: number;
  costEstimateUsd: number;
  raw: unknown;
}

export interface CostEstimate {
  items: number;
  costUsd: number;
  /** Remaining monthly allowance after this run, if it went ahead. */
  remainingAfterUsd: number;
  affordable: boolean;
  note: string;
}

export interface ScraperProvider extends Provider {
  estimate(request: Pick<ScrapeRequest, 'handle' | 'limit'>): Promise<CostEstimate>;
  scrape(request: ScrapeRequest): Promise<ScrapeResult>;
}
