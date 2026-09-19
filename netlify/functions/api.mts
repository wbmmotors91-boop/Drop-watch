import type { Config, Context } from "@netlify/functions";
import type { Item } from "./lib/sources.mjs";
import { env, readJson, writeJson, pushAll, type Meta, type Sub } from "./lib/store.mjs";
import { runPass } from "./lib/pass.mjs";
import { PUSH_SOURCES, activeSources, isArrival } from "./lib/config.mjs";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * A manual check is a courtesy button, not a way to hammer other people's
 * sites. The cooldown is tracked separately from the scheduled poll: sharing
 * lastPoll would mean the button is almost always inside the 5 minute
 * schedule's shadow and refuses every time, which reads as broken.
 */
const MANUAL_COOLDOWN_MS = 60_000;

export default async (req: Request, _context: Context) => {
  // Tolerate a trailing slash: /api/state/ is the same request as /api/state,
  // and answering 404 to it only ever looks like the app is broken.
  const route = new URL(req.url).pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");

  if (route === "state") {
    const [items, meta] = await Promise.all([
      readJson<Item[]>("items", []),
      readJson<Meta>("meta", {}),
    ]);
    return json({
      publicKey: env("VAPID_PUBLIC_KEY"),
      pushConfigured: Boolean(env("VAPID_PRIVATE_KEY")),
      // How many phones are actually registered. Without this, "nothing sent"
      // is unreadable from outside the phone.
      devices: (await readJson<Sub[]>("subs", [])).length,
      // Pokémon Center leads because it is the only source allowed to
      // notify; the rest are there to read.
      watching: activeSources(),
      // So the app can show which sources are allowed to buzz him and which
      // are only there to read.
      pushSources: PUSH_SOURCES,
      // Only genuine arrivals. Everything else is the back catalogue: it is
      // what Pokémon Center already sells, with no stock status attached, and
      // showing it as a find is what put sold-out tins on his screen.
      items: items.filter(isArrival).slice(0, 60),
      watchedCount: items.length,
      lastPoll: meta.lastPoll || null,
      lastUpcPoll: meta.lastUpcPoll || null,
      lastPcPoll: meta.lastPcPoll || null,
      notes: meta.lastNotes || [],
      notesByKind: meta.notesByKind || {},
    });
  }

  if (req.method !== "POST") return json({ error: "not found" }, 404);

  if (route === "subscribe") {
    const sub = (await req.json().catch(() => null)) as Sub | null;
    if (!sub?.endpoint || !sub?.keys?.p256dh) return json({ error: "bad subscription" }, 400);
    const subs = await readJson<Sub[]>("subs", []);
    if (!subs.some((s) => s.endpoint === sub.endpoint)) {
      subs.push({ endpoint: sub.endpoint, keys: sub.keys, added: Date.now() });
      await writeJson("subs", subs);
    }
    return json({ ok: true, devices: subs.length });
  }

  if (route === "unsubscribe") {
    const body = (await req.json().catch(() => ({}))) as { endpoint?: string };
    const subs = await readJson<Sub[]>("subs", []);
    const left = subs.filter((s) => s.endpoint !== body.endpoint);
    await writeJson("subs", left);
    return json({ ok: true, devices: left.length });
  }

  if (route === "test") {
    const res = await pushAll(
      "Test alert",
      "Notifications are working. This is what a drop will look like.",
      "/",
    );
    return json({ ok: res.sent > 0, ...res });
  }

  if (route === "check") {
    const meta = await readJson<Meta>("meta", {});
    const since = Date.now() - (meta.lastManualCheck || 0);
    if (since < MANUAL_COOLDOWN_MS) {
      return json({ ok: false, wait: Math.ceil((MANUAL_COOLDOWN_MS - since) / 1000) }, 429);
    }
    await writeJson("meta", { ...meta, lastManualCheck: Date.now() });
    const result = await runPass("pc");
    return json({ ok: true, ...result });
  }

  return json({ error: "not found" }, 404);
};

export const config: Config = {
  path: "/api/*",
};
