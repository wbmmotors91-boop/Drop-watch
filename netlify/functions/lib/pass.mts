/** One polling pass: fetch, diff against what we have seen, notify. */

import type { Item } from "./sources.mjs";
import { pollFeeds, pollRetailers, pollUpc } from "./sources.mjs";
import {
  FEEDS,
  KEYWORDS_EXCLUDE,
  KEYWORDS_INCLUDE,
  MAX_PUSH_PER_PASS,
  NEWS_REQUIRE_ANY,
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

export async function runPass(kind: "fast" | "upc"): Promise<PassResult> {
  const notes: string[] = [];
  let items: Item[] = [];

  if (kind === "fast") {
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
    const batch = fresh.slice(0, MAX_PUSH_PER_PASS);
    for (const item of batch) {
      const bits = [item.upc ? `UPC ${item.upc}` : "", `on ${item.source}`]
        .filter(Boolean)
        .join(" · ");
      const res = await pushAll(item.title.slice(0, 90), bits, item.url);
      notified += res.sent;
    }
    if (fresh.length > batch.length) {
      const extra = fresh.length - batch.length;
      await pushAll(`+${extra} more new listings`, "Open the app for the full list.", "/");
    }
  }

  await writeJson("meta", {
    ...meta,
    seeded: meta.seeded || seededNow,
    lastNotes: notes,
    ...(kind === "fast" ? { lastPoll: Date.now() } : { lastUpcPoll: Date.now() }),
  });

  return {
    checked: kind === "fast" ? [...FEEDS, ...RETAILERS].map((s) => s.name) : ["UPC database"],
    found: fresh.length,
    notified,
    seeded: seededNow,
    notes,
  };
}
