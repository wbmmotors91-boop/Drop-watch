/** One polling pass: fetch, diff against what we have seen, notify. */

import type { Item } from "./sources.mjs";
import { canadianOffer, grab, matches, parseDisallowed, pollFeeds, pollRetailers, pollSitemap, pollUpc, probeProductPage } from "./sources.mjs";
import {
  CANADIAN_TERMS,
  FEEDS,
  KEYWORDS_EXCLUDE,
  KEYWORDS_INCLUDE,
  KEYWORDS_VERSION,
  MAX_PUSH_PER_PASS,
  NEWS_REQUIRE_ANY,
  POKEMON_CENTER,
  PUSH_SOURCES,
  RETAILERS,
  UPC_QUERIES,
} from "./config.mjs";
import { addItems, pruneItems, pushAll, readJson, writeJson, type Meta } from "./store.mjs";

const MAX_KEYS_PER_SOURCE = 800;

/** How long Pokémon Center's robots.txt is trusted before re-reading it. */
const ROBOTS_MAX_AGE_MS = 60 * 60 * 1000;

/** How often to re-test whether a product page answers a hosted request. */
const STOCK_PROBE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * How long to leave Pokémon Center alone after they refuse us.
 *
 * Doubling from five minutes to an hour. Being refused is them saying we are
 * asking too often, and the only correct answer to that is to ask less, not to
 * keep knocking on the same schedule.
 */
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;

export function backoffFor(failures: number): number {
  if (failures < 1) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

/**
 * Challenges are milder than refusals, and the odd one is ordinary, so the
 * first few cost nothing. A run of them is the warning that came before the
 * outright block, and it is cheaper to ease off then than to recover after.
 */
const CHALLENGE_GRACE = 3;
const CHALLENGE_MAX_MS = 30 * 60 * 1000;

export function challengeBackoffFor(challenges: number): number {
  if (challenges <= CHALLENGE_GRACE) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (challenges - CHALLENGE_GRACE - 1), CHALLENGE_MAX_MS);
}

export type PassResult = {
  checked: string[];
  found: number;
  notified: number;
  seeded: boolean;
  notes: string[];
};

export type PassKind = "pc" | "news" | "upc";

export async function runPass(kind: PassKind): Promise<PassResult> {
  const notes: string[] = [];
  let items: Item[] = [];
  let pcChildren: string[] | undefined;
  let newsCursor: number | undefined;
  let robots: { rules: string[]; at: number } | undefined;
  let stockProbedAt: number | undefined;
  let stockProbe: { at: number; result: string } | undefined;
  let pcFailures: number | undefined;
  let pcChallenges: number | undefined;
  let pcBlockedUntil: number | undefined;

  if (kind === "pc") {
    // Read their rules before their data, and obey whatever they say. Their
    // rules do not change minute to minute, so re-reading them on every check
    // is just another request against their server; an hour is fresh enough
    // to notice a change long before it matters.
    const priorMeta = await readJson<Meta>("meta", {});

    // They refused us recently, so stay away until the backoff expires.
    // Knocking again on schedule is what turns an intermittent refusal into a
    // standing one.
    if (priorMeta.pcBlockedUntil && Date.now() < priorMeta.pcBlockedUntil) {
      const mins = Math.ceil((priorMeta.pcBlockedUntil - Date.now()) / 60000);
      notes.push(`Pokémon Center refused us, backing off for another ${mins} min`);
      return { checked: ["Pokémon Center"], found: 0, notified: 0, seeded: false, notes };
    }

    const cached = priorMeta.robots;
    let disallowed: string[] = [];
    if (cached && Date.now() - cached.at < ROBOTS_MAX_AGE_MS) {
      disallowed = cached.rules;
    } else {
      try {
        disallowed = parseDisallowed(await grab(POKEMON_CENTER.robotsUrl, 8000));
        robots = { rules: disallowed, at: Date.now() };
      } catch (err) {
        notes.push(`Pokémon Center robots.txt: ${String(err).slice(0, 60)}`);
        notes.push("skipping the sitemap this cycle rather than guessing the rules");
        return { checked: ["Pokémon Center"], found: 0, notified: 0, seeded: false, notes };
      }
    }
    const sitemap = await pollSitemap(
      {
        indexUrl: POKEMON_CENTER.indexUrl,
        childPattern: POKEMON_CENTER.childPattern,
        maxChildren: POKEMON_CENTER.maxChildren,
        region: POKEMON_CENTER.region,
        disallowed,
        knownChildren: priorMeta.pcChildren || [],
        validators: await readJson<Record<string, { etag: string; lastModified: string }>>(
          "pcValidators",
          {},
        ),
      },
      KEYWORDS_INCLUDE,
      KEYWORDS_EXCLUDE,
      notes,
    );
    items = sitemap.items;

    if (sitemap.blocked) {
      // A flat refusal. Stay away, and for longer each time.
      pcFailures = (priorMeta.pcFailures || 0) + 1;
      pcBlockedUntil = Date.now() + backoffFor(pcFailures);
      notes.push(`backing off ${Math.round(backoffFor(pcFailures) / 60000)} min before asking again`);
    } else if (sitemap.challenged) {
      // A challenge is milder than a refusal and one is normal, but a run of
      // them is what came immediately before they shut us out altogether.
      // Ease off before that happens rather than after.
      pcChallenges = (priorMeta.pcChallenges || 0) + 1;
      const wait = challengeBackoffFor(pcChallenges);
      if (wait) {
        pcBlockedUntil = Date.now() + wait;
        notes.push(
          `challenged ${pcChallenges} times in a row, easing off for ${Math.round(wait / 60000)} min`,
        );
      }
    } else if (sitemap.items.length || sitemap.allUnchanged) {
      pcFailures = 0;
      pcChallenges = 0;
      pcBlockedUntil = 0;
    }
    // Remember the child sitemaps so a challenged index does not stop the watch.
    if (sitemap.children.length) pcChildren = sitemap.children;

    // Remember what the server said identifies the list, so the next check can
    // ask "changed?" instead of downloading it again.
    if (Object.keys(sitemap.validators).length) {
      await writeJson("pcValidators", sitemap.validators);
    }

    // Does their list track stock at all?
    //
    // A restock is invisible if the product URL simply stays put. But some
    // stores drop sold-out products from their sitemap and re-add them when
    // stock returns, and if Pokémon Center does that, a restock already looks
    // like a new arrival and is already caught. Watching what leaves the list
    // is the only way to tell which world we are in, and it costs nothing.
    if (!sitemap.allUnchanged && sitemap.items.length) {
      const previous = await readJson<Record<string, string>>("pcLastmod", {});
      const before = Object.keys(previous);
      const now = sitemap.lastmods;
      const added = Object.keys(now).filter((k) => !(k in previous));
      const removed = before.filter((k) => !(k in now));
      if (before.length) {
        notes.push(
          `list changed: ${added.length} added, ${removed.length} removed, ${Object.keys(now).length} total`,
        );
        if (removed.length) {
          notes.push(`left the list: ${removed.slice(0, 3).map((k) => k.split("/").pop()).join(", ")}`);
        }
      }
      await writeJson("pcLastmod", now);
    }

    // Once an hour, ask whether a product page will talk to us at all. If it
    // will, a watchlist of the products he actually wants becomes possible and
    // restocks stop being invisible. One request an hour is the cheapest way
    // to keep testing an answer that could change.
    if (!priorMeta.stockProbe || Date.now() - priorMeta.stockProbe.at > STOCK_PROBE_MAX_AGE_MS) {
      const sample = sitemap.items[0] || (await readJson<Item[]>("items", []))[0];
      if (sample) {
        stockProbe = { at: Date.now(), result: await probeProductPage(sample.url, disallowed) };
        stockProbedAt = stockProbe.at;
      }
    }

    // Carry the last answer into every cycle's notes. It is a standing fact
    // about what can be read, not something that happened this minute, and
    // writing it only on the cycle that tested it means it is invisible for
    // the other eleven.
    const probe = stockProbe || priorMeta.stockProbe;
    if (probe) notes.push(probe.result);

  } else if (kind === "news") {
    // Advance the rotation so the Reddit feeds take turns instead of all
    // three asking at once and two of them earning a 429.
    newsCursor = ((await readJson<Meta>("meta", {})).newsCursor || 0) + 1;
    const [feedItems, retailItems] = await Promise.all([
      pollFeeds(FEEDS, KEYWORDS_INCLUDE, KEYWORDS_EXCLUDE, notes, NEWS_REQUIRE_ANY, 20000, newsCursor),
      pollRetailers(RETAILERS, KEYWORDS_INCLUDE, KEYWORDS_EXCLUDE, notes),
    ]);
    items = [...feedItems, ...retailItems];
  } else {
    items = await pollUpc(UPC_QUERIES, KEYWORDS_INCLUDE, KEYWORDS_EXCLUDE, notes);
  }

  const seen = await readJson<Record<string, string[]>>("seen", {});
  const fresh: Item[] = [];
  for (const item of items) {
    const bucket = (seen[item.source] ||= []);
    if (bucket.includes(item.key)) continue;
    bucket.push(item.key);
    fresh.push(item);
  }
  for (const src of Object.keys(seen)) {
    if (seen[src].length > MAX_KEYS_PER_SOURCE) {
      seen[src] = seen[src].slice(-MAX_KEYS_PER_SOURCE);
    }
  }
  await writeJson("seen", seen);

  const meta = await readJson<Meta>("meta", {});
  // Only count as seeded once something actually came back. If every source
  // times out on the very first run, seeding on an empty result would mean the
  // next successful run notifies about the entire existing catalogue at once.
  const firstEver = !meta.seeded;
  const seededNow = firstEver && items.length > 0;

  // Widening the product list makes existing products match for the first
  // time. They are new to the diff but not new to the world, so take them in
  // without notifying, exactly as the first run does.
  const ranWith = (meta.keywordsVersionByKind || {})[kind];
  const keywordsWidened = !firstEver && ranWith !== KEYWORDS_VERSION;


  // A quiet add is a product we had simply never looked for before. It goes in
  // the known list so the next diff is right, but it is not a new arrival and
  // must not show up as one.
  await addItems(fresh, firstEver || keywordsWidened);

  let notified = 0;
  if (firstEver) {
    // Seed quietly. Otherwise the first run fires a notification for every
    // product that already exists, which is the fastest way to get an app
    // uninstalled.
    notes.push(
      items.length
        ? `seeded ${fresh.length} existing entries without notifying`
        : "no source answered, staying unseeded so the next run does not flood you",
    );
  } else if (keywordsWidened) {
    notes.push(
      `the product list changed, so ${fresh.length} newly matching entries were added without notifying`,
    );
  }

  // The rules changed, so anything the old ones let through has to go, or a
  // tightened list leaves its mistakes sitting in the feed forever.
  if (keywordsWidened) {
    let dropped = 0;
    if (kind === "pc") {
      dropped = await pruneItems("Pokémon Center", (i) =>
        matches(i.title, KEYWORDS_INCLUDE, KEYWORDS_EXCLUDE),
      );
    } else if (kind === "news") {
      // The broad Reddit search used to be worldwide, so American posts are
      // sitting in the feed from before it was told to stay in Canada.
      dropped = await pruneItems("Reddit drops", (i) =>
        matches(`${i.title} ${i.detail || ""}`, CANADIAN_TERMS, []),
      );
    } else if (kind === "upc") {
      // Barcodes are worth keeping; the US storefront links attached to them
      // are not, and those entries were saved with the link baked in.
      dropped = await pruneItems("UPC database", (i) => !i.url || canadianOffer([{ link: i.url }]) !== "");
    }
    if (dropped) notes.push(`${dropped} entries no longer match and were removed from the feed`);
  } else if (fresh.length) {
    // Everything lands in the app; only the authoritative sources buzz.
    const worthPushing = fresh.filter((i) => PUSH_SOURCES.includes(i.source));
    const batch = worthPushing.slice(0, MAX_PUSH_PER_PASS);
    for (const item of batch) {
      const bits = [item.upc ? `UPC ${item.upc}` : "", `on ${item.source}`]
        .filter(Boolean)
        .join(" · ");
      const res = await pushAll(item.title.slice(0, 90), bits, item.url);
      notified += res.sent;
    }
    if (worthPushing.length > batch.length) {
      const extra = worthPushing.length - batch.length;
      await pushAll(`+${extra} more new listings`, "Open the app for the full list.", "/");
    }
  }

  await writeJson("meta", {
    ...meta,
    seeded: meta.seeded || seededNow,
    lastNotes: notes,
    notesByKind: { ...(meta.notesByKind || {}), [kind]: notes },
    keywordsVersionByKind: { ...(meta.keywordsVersionByKind || {}), [kind]: KEYWORDS_VERSION },
    ...(pcChildren ? { pcChildren } : {}),
    ...(newsCursor === undefined ? {} : { newsCursor }),
    ...(robots ? { robots } : {}),
    ...(stockProbedAt ? { lastStockProbe: stockProbedAt } : {}),
    ...(stockProbe ? { stockProbe } : {}),
    ...(pcFailures === undefined && pcChallenges === undefined
      ? {}
      : {
          ...(pcFailures === undefined ? {} : { pcFailures }),
          ...(pcChallenges === undefined ? {} : { pcChallenges }),
          ...(pcBlockedUntil === undefined ? {} : { pcBlockedUntil }),
        }),
    ...(kind === "upc" ? { lastUpcPoll: Date.now() } : { lastPoll: Date.now() }),
    ...(kind === "pc" ? { lastPcPoll: Date.now() } : {}),
  });

  return {
    checked:
      kind === "pc"
        ? ["Pokémon Center"]
        : kind === "news"
          ? [...FEEDS, ...RETAILERS].map((s) => s.name)
          : ["UPC database"],
    found: fresh.length,
    notified,
    seeded: seededNow,
    notes,
  };
}
