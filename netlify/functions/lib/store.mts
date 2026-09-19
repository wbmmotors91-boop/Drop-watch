/** Blob storage and web push. */

import { getStore } from "@netlify/blobs";
import webpush from "web-push";
import type { Item } from "./sources.mjs";
import { MAX_ITEMS } from "./config.mjs";

export type Sub = { endpoint: string; keys: { p256dh: string; auth: string }; added: number };
export type Meta = {
  /** Child sitemaps that last worked, reused when the index is challenged. */
  pcChildren?: string[];
  /** Advances each news pass so the rate-limited feeds take turns. */
  newsCursor?: number;
  /**
   * The keyword version each kind of pass last ran with. Per kind, because
   * whichever pass runs first must not clear the flag for the others.
   */
  keywordsVersionByKind?: Record<string, number>;
  /** Cached robots.txt rules, so a one-minute cadence does not re-read them. */
  robots?: { rules: string[]; at: number };
  /** When a product page was last tested for a readable stock status. */
  lastStockProbe?: number;
  /** Consecutive refusals from Pokémon Center, and when to try them again. */
  pcFailures?: number;
  /** Consecutive challenge pages, eased off before they become refusals. */
  pcChallenges?: number;
  pcBlockedUntil?: number;
  seeded?: boolean;
  lastPoll?: number;
  lastUpcPoll?: number;
  lastPcPoll?: number;
  lastManualCheck?: number;
  lastNotes?: string[];
  notesByKind?: Record<string, string[]>;
};

/**
 * Read a site environment variable.
 *
 * Netlify exposes these two ways and they do not always agree: the `Netlify`
 * global came back empty on this site while `process.env` had the value, so
 * try both rather than trusting either.
 */
export function env(name: string): string {
  try {
    const viaGlobal = (globalThis as any).Netlify?.env?.get?.(name);
    if (viaGlobal) return String(viaGlobal);
  } catch {
    // The global is not there in every runtime. Fall through.
  }
  return process.env[name] || "";
}

export function store() {
  return getStore({ name: "pc-alert", consistency: "strong" });
}

export async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const v = await store().get(key, { type: "json" });
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(key: string, value: unknown): Promise<void> {
  await store().setJSON(key, value);
}

/** Newest first, capped, deduped by key. */
/**
 * Drop stored entries that the current rules would no longer accept.
 *
 * Tightening the keywords only stops new matches; whatever the looser rules
 * already let through stays in the feed until something removes it. Without
 * this, excluding socks leaves the socks on screen.
 */
export function itemsAfterPrune(
  items: Item[],
  source: string,
  keep: (title: string) => boolean,
): Item[] {
  // Only the named source is judged. Other sources passed different gates to
  // get here and must not be deleted by this one's rules.
  return items.filter((i) => i.source !== source || keep(i.title));
}

export async function pruneItems(
  source: string,
  keep: (title: string) => boolean,
): Promise<number> {
  const existing = await readJson<Item[]>("items", []);
  const kept = itemsAfterPrune(existing, source, keep);
  const dropped = existing.length - kept.length;
  if (dropped) await writeJson("items", kept);
  return dropped;
}

export async function addItems(fresh: Item[]): Promise<Item[]> {
  const now = Date.now();
  const existing = await readJson<Item[]>("items", []);
  const seen = new Set(existing.map((i) => i.key));
  const added = fresh.filter((i) => !seen.has(i.key)).map((i) => ({ ...i, found: now }));
  if (!added.length) return [];
  await writeJson("items", [...added, ...existing].slice(0, MAX_ITEMS));
  return added;
}

function vapidReady(): boolean {
  const pub = env("VAPID_PUBLIC_KEY");
  const priv = env("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return false;
  webpush.setVapidDetails(env("VAPID_SUBJECT") || "mailto:alerts@example.com", pub, priv);
  return true;
}

/**
 * Push to every subscribed device. A subscription the browser has thrown
 * away answers 404/410; drop those rather than retrying them forever.
 */
export async function pushAll(
  title: string,
  body: string,
  url: string,
): Promise<{ sent: number; dropped: number }> {
  if (!vapidReady()) return { sent: 0, dropped: 0 };

  const subs = await readJson<Sub[]>("subs", []);
  if (!subs.length) return { sent: 0, dropped: 0 };

  const payload = JSON.stringify({ title, body, url, at: Date.now() });
  const dead: string[] = [];
  let sent = 0;

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(s as any, payload, { TTL: 900, urgency: "high" });
        sent++;
      } catch (err: any) {
        // 404/410 mean the browser threw this subscription away. Anything else
        // is probably transient, so leave it alone and try again next time.
        if (err?.statusCode === 404 || err?.statusCode === 410) dead.push(s.endpoint);
        else console.warn("push failed", err?.statusCode, String(err).slice(0, 120));
      }
    }),
  );

  if (dead.length) {
    await writeJson(
      "subs",
      subs.filter((s) => !dead.includes(s.endpoint)),
    );
  }
  return { sent, dropped: dead.length };
}
