# Cutting over from v1 to v2

The order below is not arbitrary. Two things make it matter:

1. **The probes are free and local; the migration is neither.** `probe:graph`
   runs against your token from your machine and touches no database and no
   deployment. If it comes back showing Meta's metric names differ from the
   docs, or that reels and images serve different fields, the mappers change
   and possibly the schema does too. Probing after migrating means migrating
   twice.

2. **The migration and the deploy are one operation, not two.** `main` still
   runs v1, and v1 reads `drafts` and `schedule` in eight files. The moment
   migration `0002` drops those tables, the deployed app is querying tables
   that no longer exist. The same goes for the environment variables: v1's
   slide rendering reads `IMAGE_PROVIDER` and `SUPABASE_STORAGE_BUCKET`, so
   deleting them while v1 is live breaks it.

   It is a personal app, so a few minutes of downtime costs nothing — but it
   has to be a few minutes, in one sitting, not a Tuesday task and a Thursday
   task.

## Free and reversible — do these any time

### 1. Regenerate the Instagram token with all seven scopes

```
instagram_basic
instagram_manage_insights      ← new in v2
instagram_manage_comments      ← new in v2
instagram_content_publish      ← auto-publish; ask for it even though it's off
pages_read_engagement
pages_show_list
business_management            ← without it /me/accounts returns an empty list
```

That last one fails silently and is the reason this list is seven long. With
six scopes the Page simply does not appear, which reads as "you administer no
Pages" rather than "your token is short a permission".

Put it in your **local `.env`** first, not Vercel. Nothing reads it there but
the probes.

### 2. Probe the Graph API

```bash
npm run probe:graph -- --json graph-probe.json
```

Read-only, local, free. Keep the terminal reconciliation table; the JSON file
holds your account data and is gitignored for that reason.

### 3. Probe the Apify follower actor

Pick the actor in the Apify console first and confirm the input schema it
declares — `APIFY_FOLLOWERS_ACTOR` currently defaults to the _profile_
scraper, which is very likely wrong. Then:

```bash
npm run probe:apify-followers -- <yourhandle> 20
```

Costs a few cents. Reports the real per-1000 rate, which is what decides
whether named unfollows is affordable at all.

### 4. Fix the mappers against what came back

Both probes exist to be wrong about something. Adjust `lib/insights/graph.ts`,
the fixtures in `tests/graph-insights.test.ts`, and the actor input in
`lib/jobs/handlers/snapshot-followers.ts` together — a fixture that mirrors a
wrong assumption is worse than no fixture.

## The cutover window — one sitting

### 5. Back up Supabase

Export or snapshot. The `drafts` + `schedule` → `calendar_entries` backfill is
the one irreversible step in the project.

### 6. Dry-run the migration on a restored copy

```bash
npm run verify:migration -- --before snap.json
npm run db:migrate
npm run verify:migration -- --after snap.json     # must print RECONCILED
```

Run it through the script. The guard in `0002` that aborts the drop when the
backfill came up short only works inside drizzle's transaction — pasted into
the Supabase SQL editor, each statement autocommits and the drops proceed
anyway.

### 7. Merge, deploy, migrate, reconfigure — together

```
merge the branch to main
wait for the Vercel deploy to finish
npm run db:migrate                    # against production
```

Then in Vercel, in the same sitting:

| Action  | Variable                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------- |
| update  | `IG_ACCESS_TOKEN` (the seven-scope one)                                                                       |
| confirm | `IG_USER_ID`, `IG_HANDLE`, `LLM_PROVIDER=google`                                                              |
| add     | `CRON_SECRET`                                                                                                 |
| delete  | `IMAGE_PROVIDER`, `GOOGLE_MODEL_LITE`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` |

And in GitHub → Settings → Secrets and variables → Actions:

- variable `TRELLIS_URL` — the stable production domain
- secret `CRON_SECRET` — identical to Vercel's

### 8. Verify

```bash
npm run verify:cron-auth -- https://your-app.vercel.app     # expect 20/20
```

Then open `/settings` and confirm the token panel reports no missing scopes.

### 9. First run

Enter your handle on the dashboard, then run the **Scheduled jobs** workflow
manually with `daily`, wait for it, and run it again with `weekly`. The weekly
run does discovery, analysis, and then the Gemini generation that fills
Opportunities and This week.

## What to expect afterwards

Your existing scraped posts have no reach and never will — Graph insights do
not backfill. The dashboard will carry a coverage note ("N of 132 posts have
Instagram insights") for a long time. That is correct, not broken.

## Thresholds to revisit once real numbers exist

These were chosen against seeded data and are the first things to question
after a month of real history:

| Constant                 | Where                            | Currently                                             |
| ------------------------ | -------------------------------- | ----------------------------------------------------- |
| "climbing" threshold     | `lib/analytics/tracker.ts`       | +5% since the last checkpoint                         |
| viral-score floor        | `lib/analytics/ideas.ts`         | 1.5×, min 5 posts for a baseline                      |
| topic noise floor        | `lib/analytics/topics.ts`        | 3 posts in the recent window                          |
| opportunity sample floor | `lib/analytics/opportunities.ts` | 5 posts either side                                   |
| format-gap trigger       | `lib/analytics/opportunities.ts` | 1.25× median reach, under 30% of output               |
| comment window           | `lib/analytics/audience.ts`      | 90 days nominal — real coverage is your last 10 posts |

The dashboard consolidation is also worth revisiting: `/tracker`, `/audience`
and `/unfollows` were folded in as sections. If any of them turns out to need
more room than a section gives it, bringing it back as a tab is a small change.
