import { env } from '../../env';
import { getScraper } from '../../providers';
import { ApifyScraper } from '../../providers/scraper/apify';
import {
  scrapeHashtagFake,
  scrapeHashtagFixture,
  type HashtagPost,
} from '../../providers/scraper/hashtag';
import { markWaiting } from '../queue';
import { JobWaiting, type JobContext } from '../types';

/**
 * Scrapes one hashtag's top posts, purely to see who's posting under it and
 * how well they're doing — not full post normalization, since these accounts
 * aren't being tracked, just ranked. Same fire-and-webhook shape as
 * scanAccount: fixture/fake completes synchronously, live mode fires the
 * hashtag actor and waits for the webhook.
 */
export async function scanHashtag(ctx: JobContext<'scan_hashtag'>): Promise<void> {
  const { hashtag, limit } = ctx.payload;

  if (env().SCRAPE_MODE === 'live') {
    const scraper = getScraper() as ApifyScraper;
    const started = await scraper.startHashtag(hashtag, limit);
    await markWaiting(ctx.jobId, { runId: started.runId, hashtag });
    throw new JobWaiting();
  }

  const results: HashtagPost[] =
    env().SCRAPE_MODE === 'fake'
      ? scrapeHashtagFake(hashtag, limit)
      : scrapeHashtagFixture(hashtag, limit);

  await ctx.save({
    progress: 1,
    label: `#${hashtag}: ${results.length} posts`,
    checkpoint: { hashtag, results },
  });
}
