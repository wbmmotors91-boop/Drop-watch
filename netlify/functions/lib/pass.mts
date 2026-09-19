/** One polling pass: fetch, diff against what we have seen, notify. */

import type { Item } from "./sources.mjs";
import { grab, matches, parseDisallowed, pollFeeds, pollRetailers, pollSitemap, pollUpc } from "./sources.mjs";
import {
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

  if (kind === "pc") {
    // Read their rules before their data, and obey whatever they say. Their
    // rules do not change minute to minute, so re-reading them on every check
    // is just another request against their server; an hour is fresh enough
    // to notice a change long before it matters.
    const priorMeta = await readJson<Meta>("meta", {});
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

  await addItems(fresh);

  // Widening the product list makes existing products match for the first
  // time. They are new to the diff but not new to the world, so take them in
  // without notifying, exactly as the first run does.
  const ranWith = (meta.keywordsVersionByKind || {})[kind];
  const keywordsWidened = !firstEver && ranWith !== KEYWORDS_VERSION;

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
  if (keywordsWidened && kind === "pc") {
    const dropped = await pruneItems("Pokémon Center", (title) =>
      matches(title, KEYWORDS_INCLUDE, KEYWORDS_EXCLUDE),
    );
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
