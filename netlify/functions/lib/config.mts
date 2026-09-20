/** What we watch, and what counts as interesting. */

import type { Feed, Retailer } from "./sources.mjs";

/**
 * A product has to be named. These are the things worth being woken up for.
 */
export const KEYWORDS_INCLUDE = [
  // Trainer boxes
  "elite trainer box",
  "etb",
  "trainer box",
  // Booster product
  "booster box",
  "booster bundle",
  "build & battle",
  "build and battle",
  // Collections
  "ultra premium collection",
  "super premium collection",
  "premium collection",
  "special collection",
  "collection box",
  "binder collection",
  "upc",
  // Boxes and sets sold under their own name
  "box set",
  "ex box",
  "v box",
  "vmax box",
  "vstar box",
  "surprise box",
  "mystery box",
  "collector chest",
  "collector's chest",
  "trainer's toolkit",
  "trainers toolkit",
  // Tins and blisters
  "tin",
  "mini tin",
  "blister",
];

/**
 * Bumped whenever KEYWORDS_INCLUDE or KEYWORDS_EXCLUDE changes.
 *
 * Widening the product list makes products that already exist match for the
 * first time, and they look exactly like new arrivals to the diff. Without
 * this, broadening the net once fires a notification for every one of them.
 * A pass that sees a new version takes the new matches in silently.
 */
// 7: not a keyword change. The seen-key list was truncated to 800 while the
// bug was live, so ~479 product keys are missing from it. The next cycle where
// Pokémon Center actually serves a changed sitemap would find them "new" and
// fire a notification for every one. Bumping this spends the existing quiet
// -rebuild path on that pass: everything is taken in, marked catalogue, and
// nothing buzzes. One pass is all it needs; the cap fix keeps it that way.
export const KEYWORDS_VERSION = 7;

/**
 * The moment the feed learned to tell an arrival from the back catalogue
 * (2026-09-19T21:05Z, moved forward once the seen-list cap was fixed: every
 * arrival recorded before that is suspect, because the watch was forgetting
 * products and rediscovering them).
 *
 * Everything found before this was taken in by a seed or a keyword widening,
 * so none of it is evidence that a product just appeared, and a lot of it was
 * sold out years ago. A fixed timestamp rather than a stored migration flag:
 * three pollers share one blob, and a one-shot rewrite of the item list is
 * exactly the kind of thing that loses a race with whichever pass writes next.
 * A constant cannot be lost.
 */
export const CATALOGUE_EPOCH = 1789851900000;

/** True when the entry is a genuine arrival rather than the standing catalogue. */
export function isArrival(item: { catalogue?: boolean; found?: number }): boolean {
  return !item.catalogue && (item.found || 0) >= CATALOGUE_EPOCH;
}

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
  // Chatter, not product
  "deck profile",
  "tournament report",
  "match analysis",
  "pull rates",
  "is it worth",
  "what did i pull",
  // Merchandise that shares a word with sealed product. Pokémon Center sells
  // a great deal of this, and widening the net above would otherwise drag it
  // all in.
  "deck box",
  "storage box",
  "card file",
  "lunch",
  "sleeves",
  "playmat",
  "play mat",
  "plush",
  "backpack",
  "tote",
  "keychain",
  "pin badge",
  "t-shirt",
  "hoodie",
  // Widening to box sets and tins pulled these in from Pokémon Center's own
  // catalogue: socks sold as a "box set", pin box sets, books, and metal
  // signs that happen to be called tin. Real product names, all of them.
  "socks",
  "pin box",
  "tin sign",
  "primers",
  "character guide",
  "poster collection",
  "sticker collection",
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

/**
 * Near enough to drive to.
 *
 * Without this gate the feed fills with American online restock bots posting
 * "in stock at Walmart for $32.99", which is neither in a store nor in this
 * country. A sighting is only worth reading if it says where it was.
 */
export const STORE_SIGHTING_PLACES = [
  "stoney creek",
  "stoneycreek",
  "centennial",
  "grimsby",
  "hamilton",
  "niagara",
  "burlington",
  "winona",
  "ancaster",
  "dundas",
  "waterdown",
  "beamsville",
  "smithville",
  "caledonia",
  "st catharines",
  "st. catharines",
  "ontario",
  "gta",
  "golden horseshoe",
];

export const STORE_SIGHTING_STORES = ["walmart"];

/**
 * EB Games, written the several ways people actually type it.
 *
 * Deliberately no bare "eb": it matches far too much ordinary text to be a
 * store name.
 */
export const EB_GAMES_TERMS = ["eb games", "ebgames", "eb game"];

/**
 * Near enough to buy from without a customs bill.
 *
 * The broad Reddit search is mostly American, and a US price on a US shelf is
 * no use to someone in Ontario who does not want to pay cross-border shipping.
 */
export const CANADIAN_TERMS = [
  "canada",
  "canadian",
  "cad",
  "ontario",
  "quebec",
  "alberta",
  "manitoba",
  "saskatchewan",
  "british columbia",
  "nova scotia",
  "new brunswick",
  "newfoundland",
  "toronto",
  "vancouver",
  "montreal",
  "calgary",
  "ottawa",
  "hamilton",
  "winnipeg",
  "edmonton",
  "mississauga",
  "eb games",
  "ebgames",
  "indigo",
  "chapters",
  "superstore",
  "shoppers",
  "canadian tire",
  "toys r us canada",
  "walmart canada",
  "best buy canada",
  "costco canada",
  "pokemoncenter.com/en-ca",
];

/**
 * Reddit and other chatter. Empty on purpose.
 *
 * Aaron asked on 2026-09-19 that Reddit be removed as a source. Everything
 * left is a store's own published product list, which is what he wanted all
 * along: no second-hand reports, no sightings, nothing he has to take
 * somebody's word for.
 */
export const FEEDS: Feed[] = [];


/**
 * Retailer pages read directly. Empty on purpose.
 *
 * Aaron asked on 2026-09-19 for Walmart, EB Games and Pokémon Center and
 * nothing else, so Indigo came out. The machinery stays because adding a
 * retailer back is one entry.
 */
export const RETAILERS: Retailer[] = [];

/**
 * EB Games Canada's own sitemap.
 *
 * Found on 2026-09-19 after Aaron asked me to look again. An earlier check
 * this session concluded their sitemap served a storefront page; that was
 * wrong, and the mistake was reading a summary of the response rather than
 * the response. It is a real urlset: roughly 950 URLs in one flat file, with
 * products under /shop/, so it can be diffed for new SKUs the same way
 * Pokémon Center's is.
 *
 * Whether a server is allowed to read it is a separate question from whether
 * it exists, and their storefront HTML has refused hosted requests before. The
 * pass records what came back either way, so the app shows the answer instead
 * of failing quietly.
 */
export const EB_GAMES = {
  name: "EB Games Canada",
  robotsUrl: "https://www.ebgames.ca/robots.txt",
  sitemapUrl: "https://www.ebgames.ca/sitemap.xml",
  productPattern: "/shop/",
};

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
/**
 * Walmart Canada's own product sitemap, first-party products only.
 *
 * The 1p in the filename is the whole point. Walmart splits what it sells
 * itself from what its marketplace sellers list, into separate sitemaps, and
 * the marketplace was Aaron's entire objection to walmart.ca. Reading only
 * sitemap-product-1p-en.xml means every result is Walmart's own listing.
 *
 * This is online stock, not shelf stock. Nothing Walmart publishes says what
 * is on a shelf in Stoney Creek, and that has not changed. What it does say
 * is when Walmart itself starts listing a product, which is a real drop.
 *
 * The children are gzipped and large, so the index's lastmod decides what
 * gets read and only one child is read per cycle.
 */
export const WALMART = {
  name: "Walmart Canada",
  robotsUrl: "https://www.walmart.ca/robots.txt",
  indexUrl: "https://www.walmart.ca/sitemap-product-1p-en.xml",
  productPattern: "/ip/",
};

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

/**
 * Every source name that may appear in the feed.
 *
 * Turning a source off has to take its old entries with it, or they sit there
 * forever looking current. Derived from the lists above rather than written
 * out, so it cannot drift from what is actually being read.
 */
export function activeSources(): string[] {
  return ["Pokémon Center", EB_GAMES.name, WALMART.name, ...FEEDS.map((f) => f.name), ...RETAILERS.map((r) => r.name)]
    .concat(UPC_QUERIES.length ? ["UPC database"] : []);
}

/**
 * Barcode lookups. Empty on purpose, same reason as RETAILERS: not one of the
 * three sources Aaron asked to keep. The scheduled pass that reads these now
 * does nothing, which costs nothing.
 */
export const UPC_QUERIES: string[] = [];

/** Keep the in-app feed to something a phone can render instantly. */
export const MAX_ITEMS = 120;
/** Never fire more than this many notifications in one pass. */
export const MAX_PUSH_PER_PASS = 4;
