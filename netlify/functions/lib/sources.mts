/**
 * Signal sources.
 *
 * Nothing here touches pokemoncenter.com or pokemon.com. Both sit behind
 * Imperva and return 403 to anything running in a datacenter, so a Netlify
 * function cannot read them however it asks. These are the public
 * third-party signals that do answer a server.
 */

export type Item = {
  key: string;
  title: string;
  source: string;
  url: string;
  upc?: string;
  detail?: string;
  found?: number;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** Scheduled functions get 30 seconds total, so every fetch is on a short leash. */
async function grab(url: string, ms = 7000): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { "User-Agent": UA, Accept: "*/*", "Accept-Language": "en-CA,en;q=0.9" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const m =
    block.match(new RegExp(`<${name}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, "i")) ||
    block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1].trim() : "";
}

/**
 * Tolerant RSS/Atom reader.
 *
 * Deliberately regex-based rather than a real XML parse: these feeds are
 * hand-rolled by a dozen different CMSes and a strict parser throws on the
 * first unescaped ampersand, losing the whole feed.
 */
export function parseFeed(xml: string, source: string): Item[] {
  const out: Item[] = [];

  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const block = m[0];
    const link = stripHtml(tag(block, "link"));
    const title = stripHtml(tag(block, "title"));
    if (!title && !link) continue;
    out.push({
      key: stripHtml(tag(block, "guid")) || link || title,
      title,
      source,
      url: link,
      detail: stripHtml(tag(block, "description")).slice(0, 300),
    });
  }

  for (const m of xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)) {
    const block = m[0];
    const hrefs = [...block.matchAll(/<link[^>]*href=["']([^"']+)["'][^>]*>/gi)].map((x) => x[1]);
    const link = hrefs[0] || "";
    const title = stripHtml(tag(block, "title"));
    if (!title && !link) continue;
    out.push({
      key: stripHtml(tag(block, "id")) || link || title,
      title,
      source,
      url: link,
      detail: stripHtml(tag(block, "summary") || tag(block, "content")).slice(0, 300),
    });
  }

  return out;
}

function normalise(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
}

/**
 * A multi-word term matches as a phrase, a single word as a whole word, so
 * "etb" does not fire on "setback". Empty include list matches everything.
 */
export function matches(text: string, include: string[], exclude: string[] = []): boolean {
  const norm = normalise(text);
  for (const term of exclude) {
    const needle = normalise(term).trim();
    if (needle && norm.includes(needle)) return false;
  }
  if (!include.length) return true;
  for (const term of include) {
    const needle = normalise(term).trim();
    if (!needle) continue;
    if (needle.includes(" ")) {
      if (norm.includes(needle)) return true;
    } else if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(norm)) {
      return true;
    }
  }
  return false;
}

/**
 * Pull (url, title) pairs out of a listing page. Regex over anchors rather
 * than CSS selectors: retailers reshuffle their markup constantly, but
 * product URLs keep their shape for years.
 */
export function extractProducts(html: string, pattern: string, base: string): [string, string][] {
  const seen = new Map<string, string>();
  const re = new RegExp(pattern, "i");
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1];
    if (!re.test(href)) continue;
    let title = stripHtml(m[2]);
    if (!title) {
      const alt = m[2].match(/alt=["']([^"']+)["']/i);
      title = alt ? alt[1].trim() : "";
    }
    let full: string;
    try {
      full = new URL(href, base).toString().split("?")[0];
    } catch {
      continue;
    }
    if (!seen.has(full) || (title && !seen.get(full))) seen.set(full, title);
  }
  return [...seen.entries()];
}

export type Feed = { name: string; url: string };
export type Retailer = { name: string; url: string; pattern: string };

export async function pollFeeds(
  feeds: Feed[],
  include: string[],
  exclude: string[],
  notes: string[],
  requireAny: string[] = [],
): Promise<Item[]> {
  const results = await Promise.allSettled(
    feeds.map(async (f) => {
      const xml = await grab(f.url);
      return parseFeed(xml, f.name).filter((i) => {
        const text = `${i.title} ${i.detail || ""}`;
        // Must name a product AND say something is happening to it.
        return matches(text, include, exclude) && matches(text, requireAny, []);
      });
    }),
  );
  const out: Item[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      notes.push(`${feeds[i].name}: ${r.value.length} match`);
      out.push(...r.value);
    } else {
      notes.push(`${feeds[i].name}: ${String(r.reason).slice(0, 60)}`);
    }
  });
  return out;
}

export async function pollRetailers(
  sites: Retailer[],
  include: string[],
  exclude: string[],
  notes: string[],
): Promise<Item[]> {
  const results = await Promise.allSettled(
    sites.map(async (s) => {
      const html = await grab(s.url);
      return extractProducts(html, s.pattern, s.url)
        .filter(([u, t]) => matches(`${t} ${u}`, include, exclude))
        .map(([u, t]) => ({
          key: `${s.name}:${u}`,
          title: t || decodeURIComponent(u.split("/").pop() || "").replace(/-/g, " "),
          source: s.name,
          url: u,
        }));
    }),
  );
  const out: Item[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      notes.push(`${sites[i].name}: ${r.value.length} match`);
      out.push(...r.value);
    } else {
      notes.push(`${sites[i].name}: ${String(r.reason).slice(0, 60)}`);
    }
  });
  return out;
}

/** upcitemdb's free tier is ~100 lookups a day, so this runs on its own slow clock. */
export async function pollUpc(
  queries: string[],
  include: string[],
  exclude: string[],
  notes: string[],
): Promise<Item[]> {
  const out: Item[] = [];
  for (const q of queries) {
    try {
      const url =
        "https://api.upcitemdb.com/prod/trial/search?" +
        new URLSearchParams({ s: q, match_mode: "0" }).toString();
      const data = JSON.parse(await grab(url, 8000));
      const found = (data.items || []) as any[];
      let hits = 0;
      for (const it of found) {
        const title = String(it.title || "");
        const upc = String(it.upc || it.ean || "");
        if (!upc || !matches(title, include, exclude)) continue;
        hits++;
        out.push({
          key: `upc:${upc}`,
          title,
          source: "UPC database",
          url: (it.offers && it.offers[0] && it.offers[0].link) || "",
          upc,
          detail: `brand ${it.brand || "unknown"}`,
        });
      }
      notes.push(`upc "${q}": ${hits} match`);
    } catch (err) {
      notes.push(`upc "${q}": ${String(err).slice(0, 60)}`);
    }
  }
  return out;
}
