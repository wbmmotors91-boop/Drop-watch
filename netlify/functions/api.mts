import type { Config, Context } from "@netlify/functions";
import { grab, type Item } from "./lib/sources.mjs";
import { env, readJson, writeJson, pushAll, type Meta, type Sub } from "./lib/store.mjs";
import { runPass } from "./lib/pass.mjs";
import { FEEDS, RETAILERS } from "./lib/config.mjs";

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
  const route = new URL(req.url).pathname.replace(/^\/api\/?/, "");

  if (route === "state") {
    const [items, meta] = await Promise.all([
      readJson<Item[]>("items", []),
      readJson<Meta>("meta", {}),
    ]);
    return json({
      publicKey: env("VAPID_PUBLIC_KEY"),
      pushConfigured: Boolean(env("VAPID_PRIVATE_KEY")),
      watching: [...FEEDS, ...RETAILERS].map((s) => s.name).concat("UPC database"),
      items: items.slice(0, 60),
      lastPoll: meta.lastPoll || null,
      lastUpcPoll: meta.lastUpcPoll || null,
      notes: meta.lastNotes || [],
    });
  }

  if (route === "probe") {
    // TEMPORARY. Does Pokemon Center answer a request from Netlify's network?
    // It refuses this session's own fetcher, but that is a different network
    // and the question is worth settling with evidence rather than assumption.
    // Reports status codes only, one request each, then gets deleted.
    const extra = new URL(req.url).searchParams.get("u");
    const targets = extra
      ? [extra]
      : ["https://www.pokemoncenter.com/robots.txt", "https://www.pokemoncenter.com/sitemap.xml"];
    const results = await Promise.all(
      targets.map(async (url) => {
        try {
          const text = await grab(url, 9000, 0);
          return {
            url,
            ok: true,
            length: text.length,
            body: text.length <= 4000 ? text : text.slice(0, 4000) + " …TRUNCATED",
          };
        } catch (err) {
          return { url, ok: false, error: String(err).slice(0, 80) };
        }
      }),
    );
    return json({ results });
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
    const result = await runPass("fast");
    return json({ ok: true, ...result });
  }

  return json({ error: "not found" }, 404);
};

export const config: Config = {
  path: "/api/*",
};
