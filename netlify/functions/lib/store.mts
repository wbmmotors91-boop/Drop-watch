/** Blob storage and web push. */

import { getStore } from "@netlify/blobs";
import webpush from "web-push";
import type { Item } from "./sources.mjs";
import { MAX_ITEMS } from "./config.mjs";

export type Sub = { endpoint: string; keys: { p256dh: string; auth: string }; added: number };
export type Meta = {
  seeded?: boolean;
  lastPoll?: number;
  lastUpcPoll?: number;
  lastManualCheck?: number;
  lastNotes?: string[];
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
