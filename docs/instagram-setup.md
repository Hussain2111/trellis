# Instagram publishing setup

**You do not need this to use Trellis.** Drafts, the calendar, and scheduling
all work with `ENABLE_IG_PUBLISHING=false` (the default) — scheduled posts
just wait for you to post them by hand and mark them posted. This document
is only for letting the daily publish sweep post to Instagram on your behalf.

Everything here is free. The Graph API costs nothing to call.

## Why this doesn't need App Review

App Review is triggered when _other people's_ accounts connect to your app.
Standard Access — granted automatically when you create an app — already
covers accounts that hold a role on that app. Since the only account
involved is yours, you add yourself as an admin and stay in Development
mode indefinitely.

## Steps

### 1. Convert the Instagram account

Instagram app → Settings → Account type and tools → **Switch to professional
account**. Either Business or Creator works.

### 2. Link a Facebook Page

Meta requires a Page in the chain even though nothing is posted to it. Create
an empty one if you don't have one: <https://www.facebook.com/pages/create>.
Then link it from Instagram → Settings → Sharing to other apps → Facebook.

### 3. Create a Meta app

<https://developers.facebook.com/apps> → Create app → **Other** → **Business**.

Add the **Instagram** product. Leave the app in **Development** mode — do not
switch it to Live, and do not submit it for review.

### 4. Add yourself as a tester

App → App roles → Roles → add your own Facebook account as **Administrator**.
Accept the invitation from <https://developers.facebook.com/settings/developer/requests/>.

### 5. Get a long-lived token

Graph API Explorer (<https://developers.facebook.com/tools/explorer/>):

1. Select your app.
2. Permissions — all seven, not just the publishing ones:

   | Permission                  | What breaks without it                       |
   | --------------------------- | -------------------------------------------- |
   | `instagram_basic`           | Everything                                   |
   | `instagram_manage_insights` | Reach, saves, shares, views, follower counts |
   | `instagram_manage_comments` | Most Active Followers                        |
   | `instagram_content_publish` | Auto-publishing (optional — off by default)  |
   | `pages_show_list`           | Finding the linked Page                      |
   | `pages_read_engagement`     | Reading the Page → Instagram link            |
   | `business_management`       | The Page appearing in `/me/accounts` at all  |

   `business_management` is the one that costs a debugging session if it is
   missing. Verified against a live token: without it, `GET /me/accounts`
   returns `{"data": []}` while `GET /me?fields=id,name` returns the correct
   profile — so the token is valid, belongs to the right person, and simply
   reports that they administer no Pages. Nothing errors. Add it and the Page
   appears immediately.

   The two `manage_*` permissions are new in v2 and are the ones most likely
   to be missing on a token generated for v1. A token without them does not
   error — the insight and comment endpoints simply return nothing, which is
   why Settings checks the token's scopes explicitly and says which are
   missing rather than letting empty data pass as a quiet account.

   Ask for `instagram_content_publish` in the same breath even though
   auto-publishing is off by default. It is easy to regenerate a token for the
   two insight scopes, drop this one, and not find out until the day you
   enable publishing. Settings reports it separately: quietly while publishing
   is off, loudly once it is on.

3. Generate the token, then exchange it for a long-lived one:

```
https://graph.facebook.com/v21.0/oauth/access_token
  ?grant_type=fb_exchange_token
  &client_id=<APP_ID>
  &client_secret=<APP_SECRET>
  &fb_exchange_token=<SHORT_LIVED_TOKEN>
```

### 6. Find your Instagram user id

```
https://graph.facebook.com/v21.0/me/accounts?access_token=<TOKEN>
→ take the Page id, then:
https://graph.facebook.com/v21.0/<PAGE_ID>?fields=instagram_business_account&access_token=<TOKEN>
```

The `instagram_business_account.id` is your `IG_USER_ID`.

### 7. Configure

Set these as Vercel project environment variables (and in `.env.local` for
local testing):

```
IG_HANDLE=yourhandle
IG_USER_ID=17841400000000000
IG_ACCESS_TOKEN=EAA...
```

These three are **required** in v2, not optional: the managed account's own
posts, insights, comments and follower counts all come from the Graph API
now. Without them the daily sync fails and the analytics tabs stay empty.
Apify is only used for competitors and niche discovery.

`ENABLE_IG_PUBLISHING` is separate and still defaults to `false`. The
intended workflow is copy → paste → post by hand; set it to `true` only if
you want due calendar entries to go out on their own.

### 8. Check it worked

Open `/settings`. The Instagram panel shows the token's validity, days
remaining, and — importantly — any of the six permissions above that the
token is missing. Fix those before trusting a number anywhere else in the
app.

No tunnel is needed — unlike a local-first build, this app is already
deployed at a public HTTPS URL, so the rendered slide PNGs Meta fetches
(Supabase Storage, or the local dev fallback at `/api/assets/...`) are
already publicly reachable.

## What the publish sweep does

1. `POST /{ig-user-id}/media` → a container id.
2. Poll `/{container-id}?fields=status_code` until `FINISHED`. Images are
   near instant.
3. `POST /{ig-user-id}/media_publish`.

Carousels create one child container per slide, wait for each, then a parent
with `media_type=CAROUSEL` and the children listed. Single-`image` drafts
publish their rendered hook card directly.

Reels are not published by this build — there is no video-generation or
video-rendering pipeline in the free-tier stack, so a scheduled `reel` draft
fails permanently with "no rendered assets" rather than silently doing
nothing. Schedule `carousel` or `image` drafts instead, or post a reel by
hand and mark it posted.

## Things that will bite you

- **Tokens expire in ~60 days.** `refresh_ig_token` runs on the same daily
  cron as the publish sweep and records a `runs` row if the token is invalid
  or expiring soon — check Settings (or `select * from runs where operation
= 'token_check' order by id desc` in a pinch) rather than waiting for
  publishing to mysteriously stop.
- **There is a publishing cap per rolling 24 hours** (Meta's docs cite 25 or
  100 depending on API version). The sweep reads the real number from
  `content_publishing_limit` when it can and falls back to 25.
- **A failed publish retries up to 3 times** with exponential backoff, then
  the schedule row shows as `failed`. A 4xx that isn't a rate limit is
  treated as permanent — retrying a malformed request just burns the
  attempt budget.
- **The cron sweep runs once a day** (Vercel Hobby's cron minimum interval).
  Opening the calendar page also pokes the job queue, which publishes due
  posts immediately if the app is open around the scheduled time — but with
  nobody watching, worst case is same-day, not same-minute, delivery.
- **Development mode is fine forever** for a single self-owned account. If
  you ever want to publish for someone else, that is when review applies.

## Backing out

Set `ENABLE_IG_PUBLISHING=false`. Nothing else changes — drafts stay
scheduled, and you post them by hand and mark them posted instead.
