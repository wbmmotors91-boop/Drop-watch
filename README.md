# Drop Watch

Early warning for new sealed Pokémon TCG product — preorders, restocks, booster
boxes, elite trainer boxes — delivered as a push notification to your phone.

Installable from the browser, so there is nothing to keep running at home.

## Why it watches what it watches

Pokémon Center's own site, and pokemon.com with it, sits behind Imperva and
returns **403 to anything that is not a real browser on a home connection**.
Verified against the US, Canadian and UK storefronts. Nothing hosted in a
datacenter can read their stock pages, and the ways around that are bot
evasion, which this deliberately does not do.

What it watches instead is everywhere a new product surfaces before or around
the drop:

- **TCG news feeds** — PokéBeach, Dexerto, PokéGuardian, and Reddit search and
  subreddit feeds, which are often the fastest of the lot.
- **Canadian retailer listings** — EB Games, Toys R Us, Indigo. A SKU going up
  at any of them is a strong signal the same product is about to appear at
  Pokémon Center.
- **Barcode databases** — new Pokémon UPCs, which confirm a product exists even
  before anyone lists it.

Announced preorders typically sit up for fifteen to sixty minutes, which is the
window this is built to catch. Surprise restocks get no advance warning from
anyone, including this.

## Layout

```
public/                 the app itself, no build step
  index.html            one screen: alerts, latest finds, what it watches
  app.js                push subscribe/unsubscribe, feed rendering
  sw.js                 service worker, receives pushes
netlify/functions/
  api.mts               /api/state, subscribe, unsubscribe, test, check
  poll.mts              every 5 minutes: news + retailers
  poll-upc.mts          every 3 hours: barcode lookups
  lib/sources.mts       feed parsing, keyword matching, listing extraction
  lib/config.mts        the watch list and keywords, all in one place
  lib/pass.mts          one polling pass: fetch, diff, notify
  lib/store.mts         Netlify Blobs and web push
```

State lives in a Netlify Blobs store called `pc-alert`: `seen` (keys already
alerted on), `items` (the in-app feed), `subs` (push subscriptions), `meta`.

## Deploying

Connect this repo to the Netlify project and it builds itself. There is no
build step; `netlify.toml` points at `public/`.

Three environment variables must be set on the Netlify project:

| variable | what it is |
| --- | --- |
| `VAPID_PUBLIC_KEY` | web push public key, also served to the browser |
| `VAPID_PRIVATE_KEY` | web push private key, mark it secret |
| `VAPID_SUBJECT` | a `mailto:` contact for the push services |

**Do not regenerate the VAPID pair** once devices have subscribed. Changing it
invalidates every existing subscription and every device has to turn alerts on
again.

## First run is quiet on purpose

The very first poll records everything it finds without notifying. Otherwise
switching this on would fire a notification for every product that already
exists, which is the fastest way to get an app uninstalled. If every source
happens to fail on that first run, it stays unseeded rather than treating an
empty result as "nothing exists".

## Notifications on iPhone

iOS only delivers web push to a page that has been added to the Home Screen.
Open the site in Safari, Share, Add to Home Screen, then open it from the icon
and turn alerts on there. The app says so itself when it detects this.

## Changing what it watches

Everything tunable is in `netlify/functions/lib/config.mts`: the feed list, the
retailer list with the URL pattern that identifies a product link, the barcode
queries, and the keyword lists. A term with a space matches as a phrase, a
single word matches as a whole word, so `etb` does not fire on `setback`.

News items have to pass two gates: name a product from `KEYWORDS_INCLUDE` **and**
say something is happening to it, from `NEWS_REQUIRE_ANY`. Without the second
gate a subreddit's ordinary chatter about elite trainer boxes notifies you every
few minutes and you learn to ignore the app. Retailer listings skip that gate,
because the listing appearing is itself the event.

## Tests

```bash
npm test
```

Covers the feed parsers, keyword matching, listing extraction and
environment-variable reading, all against fixtures, so it runs without
touching anyone's site.

The environment test exists because Netlify exposes site variables two ways
and they did not agree here: the `Netlify` global read empty on this site
while `process.env` held the value. `env()` in `lib/store.mts` tries both.
