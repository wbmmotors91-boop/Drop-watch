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

export const FEEDS: Feed[] = [
  { name: "PokéBeach", url: "https://www.pokebeach.com/feed" },
  { name: "Dexerto", url: "https://www.dexerto.com/pokemon/feed/" },
  { name: "PokéGuardian", url: "https://www.pokeguardian.com/blog?format=rss" },
  { name: "r/PokeInvesting", url: "https://www.reddit.com/r/PokeInvesting/new/.rss" },
  { name: "r/pkmntcg", url: "https://www.reddit.com/r/pkmntcg/new/.rss" },
  {
    name: "Reddit drop chatter",
    url:
      "https://www.reddit.com/search.rss?q=" +
      encodeURIComponent('"pokemon center" (restock OR preorder OR drop OR live)') +
      "&sort=new&t=day",
  },
];

/**
 * Canadian retailers that often list a SKU before Pokémon Center posts it.
 * Some of these block datacenter traffic too. The poller records which ones
 * answered so the app can show it rather than failing silently.
 */
export const RETAILERS: Retailer[] = [
  {
    name: "EB Games CA",
    url: "https://www.ebgames.ca/search?q=pokemon%20elite%20trainer%20box",
    pattern: "/(product|Games|Toys)/",
  },
  {
    name: "Toys R Us CA",
    url: "https://www.toysrus.ca/en/search?q=pokemon+trading+card",
    pattern: "/product/|/en/.*-\\d{6,}",
  },
  {
    name: "Indigo",
    url: "https://www.indigo.ca/en-ca/search?q=pokemon+elite+trainer+box",
    pattern: "/en-ca/[a-z0-9-]+/\\d{6,}",
  },
];

export const UPC_QUERIES = [
  "pokemon elite trainer box",
  "pokemon booster box",
  "pokemon ultra premium collection",
];

/** Keep the in-app feed to something a phone can render instantly. */
export const MAX_ITEMS = 120;
/** Never fire more than this many notifications in one pass. */
export const MAX_PUSH_PER_PASS = 4;
