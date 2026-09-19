/** One polling pass: fetch, diff against what we have seen, notify. */

import type { Item } from "./sources.mjs";
import { grab, parseDisallowed, pollFeeds, pollRetailers, pollSitemap, pollUpc } from "./sources.mjs";
import {
  FEEDS,
  KEYWORDS_EXCLUDE,
  KEYWORDS_INCLUDE,
  MAX_PUSH_PER_PASS,
  NEWS_REQUIRE_ANY,
  POKEMON_CENTER,
  PUSH_SOURCES,
  RETAILERS,
  UPC_QUERIES,
} from "./config.mjs";
import { addItems, pushAll, readJson, writeJson, type Meta } from "./store.mjs";

const MAX_KEYS_PER_SOURCE = 800;

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

  if (kind === "pc") {
    // Read their rules before their data, and obey whatever they say.
    let disallowed: string[] = [];
    try {
      disallowed = parseDisallowed(await grab(POKEMON_CENTER.robotsUrl, 8000));
    } catch (err) {
      notes.push(`Pokémon Center robots.txt: ${String(err).slice(0, 60)}`);
      notes.push("skipping the sitemap this cycle rather than guessing the rules");
      return { checked: ["Pokémon Center"], found: 0, notified: 0, seeded: false, notes };
    }
    const sitemap = await pollSitemap(
      {
        indexUrl: POKEMON_CENTER.indexUrl,
        childPattern: POKEMON_CENTER.childPattern,
        maxChildren: POKEMON_CENTER.maxChildren,
        region: POKEMON_CENTER.region,
        disallowed,
        knownChildren: (await readJson<Meta>("meta", {})).pcChildren || [],
      },
      KEYWORDS_INCLUDE,
      KEYWORDS_EXCLUDE,
      notes,
    );
    items = sitemap.items;
    // Remember the child sitemaps so a challenged index does not stop the watch.
    if (sitemap.children.length) pcChildren = sitemap.children;
  } else if (kind === "news") {
    const [feedItems, retailItems] = await Promise.all([
      pollFeeds(FEEDS, KEYWORDS_INCLUDE, KEYWORDS_EXCLUDE, notes, NEWS_REQUIRE_ANY),
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
    ...(pcChildren ? { pcChildren } : {}),
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
