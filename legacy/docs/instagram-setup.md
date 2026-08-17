# Instagram publishing setup (Mode B)

**You do not need this.** Manual mode — a notification, a copyable caption and a
zip of assets — works today with no Meta account, no app, and no review. This
document is only for letting the worker publish on your behalf.

Everything here is free. The Graph API costs nothing to call.

## Why this doesn't need App Review

App Review is triggered when *other people's* accounts connect to your app.
Standard Access — granted automatically when you create an app — already covers
accounts that hold a role on that app. Since the only account involved is yours,
you add yourself as an admin and stay in Development mode indefinitely.

## Steps

### 1. Convert the Instagram account

Instagram app → Settings → Account type and tools → **Switch to professional
account**. Either Business or Creator works.

### 2. Link a Facebook Page

Meta requires a Page in the chain even though nothing is posted to it. Create an
empty one if you don't have one: <https://www.facebook.com/pages/create>. Then
link it from Instagram → Settings → Sharing to other apps → Facebook.

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
2. Permissions: `instagram_basic`, `instagram_content_publish`,
   `pages_show_list`, `pages_read_engagement`.
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

### 7. Install cloudflared

Meta fetches media from a public HTTPS URL. It will not read `localhost`, and
this app is deliberately local-only, so a tunnel bridges the two at publish time.

```
winget install --id Cloudflare.cloudflared
```

No Cloudflare account is needed — quick tunnels are anonymous. The URL is
ephemeral and changes on every run, which is why it is resolved when a post goes
out rather than stored anywhere.

### 8. Configure and enable

```
ENABLE_IG_PUBLISHING=true
IG_USER_ID=17841400000000000
IG_ACCESS_TOKEN=EAA...
```

Then set publishing mode to `api` in Settings.

## What the worker does

1. `POST /{ig-user-id}/media` → a container id.
2. Poll `/{container-id}?fields=status_code` until `FINISHED`. Images are near
   instant; video transcoding takes a while.
3. `POST /{ig-user-id}/media_publish`.

Carousels create one child container per slide, wait for each, then a parent
with `media_type=CAROUSEL` and the children listed.

Reels need `media_type=REELS`, 9:16, H.264, and a public `video_url`.

## Things that will bite you

- **Tokens expire in ~60 days.** A daily job checks and warns at 7 days
  remaining. A silently expired token looks like "publishing broke" a week later,
  which is a miserable thing to debug.
- **There is a publishing cap per rolling 24 hours** — sources say 25 or 100
  depending on API version. The worker reads the real number from
  `content_publishing_limit` when it can and falls back to the configured
  `publishCapPer24h`.
- **A failed publish retries three times** with exponential backoff, then shows
  as failed in the calendar. A 4xx that isn't a rate limit is treated as
  permanent — retrying a malformed request just burns the attempt budget.
- **Development mode is fine forever** for a single self-owned account. If you
  ever want to publish for someone else, that is when review applies.

## Backing out

Set `ENABLE_IG_PUBLISHING=false` and switch Settings back to `manual`. Nothing
else changes — the same drafts, schedule and calendar work in both modes.
