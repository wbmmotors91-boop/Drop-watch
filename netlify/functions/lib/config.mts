/** What we watch, and what counts as interesting. */

import type { Feed, Retailer } from "./sources.mjs";

/**
 * A product has to be named. These are the things worth being woken up for.
 */
export const KEYWORDS_INCLUDE = [
  "elite trainer box",
  "etb",
  "booster box",
  "booster bundle",
  "ultra premium collection",
  "upc",
  "surprise box",
  "collection box",
  "binder collection",
  "premium collection",
  "booster bundle",
];

/**
 * News feeds additionally have to say something is actually happening.
 *
 * Without this a subreddit's ordinary chatter about elite trainer boxes fires
 * a notification every few minutes, which trains you to ignore the app. A
 * retailer listing needs no such word: the listing appearing IS the event.
 */
export const NEWS_REQUIRE_ANY = [
  "preorder",
  "pre-order",
  "restock",
  "drop",
  "drops",
  "dropping",
  "live",
  "in stock",
  "back in stock",
  "available",
  "launch",
  "release date",
  "pokemon center",
  "pokémon center",
  "sold out",
  "revealed",
  "announced",
];

export const KEYWORDS_EXCLUDE = [
  "deck profile",
  "tournament report",
  "match analysis",
  "pull rates",
  "is it worth",
  "what did i pull",
];

/**
 * Gates for the shelf-sighting feed.
 *
 * Looser on the product than the news feeds are, because someone who just saw
 * a pallet go out writes "Walmart had pokemon boxes", not the product's full
 * name. Tighter on the store, because a sighting is only useful to him if it
 * names somewhere he can drive to.
 */
export const STORE_SIGHTING_PRODUCTS = [
  "pokemon",
  "pokémon",
  "etb",
  "elite trainer box",
  "booster box",
  "booster bundle",
];

export const STORE_SIGHTING_STORES = [
  "walmart",
  "superstore",
  "real canadian superstore",
  "rcss",
];

export const FEEDS: Feed[] = [
  { name: "Dexerto", url: "https://www.dexerto.com/pokemon/feed/" },

  // Reddit throttles hard, so ask it as few times as possible: one broad
  // search covering every product word, and one scoped to the Canadian deals
  // subreddit. Three narrower searches earned a 429 on two of them every
  // cycle, even spaced out.
  {
    name: "Reddit drops",
    url:
      "https://www.reddit.com/search.rss?q=" +
      encodeURIComponent(
        '("pokemon center" OR "elite trainer box" OR "booster box" OR "ultra premium collection") ' +
          '(restock OR preorder OR drop OR live OR "in stock")',
      ) +
      "&sort=new&t=day",
  },
  {
    name: "Reddit Canada deals",
    url:
      "https://www.reddit.com/r/PokemonTCGDealsCanada/search.rss?restrict_sr=1&q=" +
      encodeURIComponent("booster box OR elite trainer box OR preorder") +
      "&sort=new&t=week",
  },

  // Walmart and Superstore shelf sightings.
  //
  // Neither chain publishes store-level stock anywhere a server can read, so
  // the only thing that knows a Stoney Creek shelf has boxes on it is a person
  // standing in front of it. This reads what those people post. Aaron's own
  // verdict is that it is late and wrong most of the time, so it stays in the
  // app to read and is never allowed to send a notification: PUSH_SOURCES is
  // what enforces that, and Pokémon Center is the only name on it.
  //
  // Asked site-wide rather than in one subreddit, because these sightings land
  // in local and provincial subs as often as in the Pokémon ones. The gates
  // below then insist a post name both a store and the product.
  {
    name: "Walmart & Superstore sightings",
    url:
      "https://www.reddit.com/search.rss?q=" +
      encodeURIComponent(
        "(walmart OR superstore) pokemon " +
          '(restock OR restocked OR "in stock" OR stocked OR found OR "on the shelf")',
      ) +
      "&sort=new&t=week",
    include: STORE_SIGHTING_PRODUCTS,
    requireAny: STORE_SIGHTING_STORES,
  },
];

/**
 * Canadian retailers that often list a SKU before Pokémon Center posts it.
 *
 * This list is short because most of them block hosted traffic the same way
 * Pokémon Center does: EB Games answers 403 and Toys R Us's search path 404s.
 * The poller records what each source returned, so the app shows which ones
 * answered rather than failing silently. Add candidates freely — a dead one
 * costs a logged line, not a missed drop.
 */
export const RETAILERS: Retailer[] = [
  {
    name: "Indigo",
    url: "https://www.indigo.ca/en-ca/search?q=pokemon+elite+trainer+box",
    pattern: "/en-ca/[a-z0-9-]+/\\d{6,}",
  },
];

/**
 * Pokémon Center's own sitemap.
 *
 * Their HTML pages refuse hosted requests with a 403, but robots.txt and the
 * sitemaps are served to anyone, and the sitemap is their own published list
 * of what exists. A product URL appearing there is Pokémon Center saying a
 * new SKU exists, which beats anyone's word for it.
 *
 * The poller reads robots.txt first and obeys it, so if they ever disallow
 * these paths it stops on its own.
 */
export const POKEMON_CENTER = {
  robotsUrl: "https://www.pokemoncenter.com/robots.txt",
  indexUrl: "https://www.pokemoncenter.com/sitemap.xml",
  childPattern: "product",
  maxChildren: 2,
  region: "en-ca",
};

/**
 * Only these sources are allowed to buzz a phone.
 *
 * Everything else still shows in the app, but Pokémon Center's own sitemap is
 * the one that is actually authoritative. A forum post saying a drop happened
 * is worth reading, not worth a notification.
 */
export const PUSH_SOURCES = ["Pokémon Center"];

export const UPC_QUERIES = [
  "pokemon elite trainer box",
  "pokemon booster box",
  "pokemon ultra premium collection",
];

/** Keep the in-app feed to something a phone can render instantly. */
export const MAX_ITEMS = 120;
/** Never fire more than this many notifications in one pass. */
export const MAX_PUSH_PER_PASS = 4;
