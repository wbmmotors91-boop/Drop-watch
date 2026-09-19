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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Statuses worth one more try. A 403 or 404 will say the same thing twice. */
function worthRetrying(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Fetch a URL as text.
 *
 * Scheduled functions get 30 seconds in total, so every request is on a short
 * leash and gets at most one retry. Reddit in particular rate-limits hosted
 * IPs and then serves the same feed happily a second later.
 */
export async function grab(url: string, ms = 7000, retries = 1): Promise<string> {
  let lastError: Error = new Error("never attempted");

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1200);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: { "User-Agent": UA, Accept: "*/*", "Accept-Language": "en-CA,en;q=0.9" },
        redirect: "follow",
      });
      if (res.ok) return await res.text();
      lastError = new Error(`HTTP ${res.status}`);
      if (!worthRetrying(res.status)) break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
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
      // A trailing s, because people write "ETBs" and "tins" and a term that
      // only matches the singular quietly misses them.
    } else if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`).test(norm)) {
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

export type Feed = {
  name: string;
  url: string;
  /** Replaces the shared product keywords for this feed alone. */
  include?: string[];
  /** Replaces the shared "something is happening" gate for this feed alone. */
  requireAny?: string[];
  /**
   * A further gate this feed's items must also pass. Used to insist a shelf
   * sighting names somewhere near enough to drive to, which is what separates
   * a useful sighting from an American restock bot.
   */
  requireAlso?: string[];
  /**
   * Feeds sharing a rotation group are read one per cycle, round-robin,
   * rather than all of them every cycle. Reddit rate-limits by address and
   * answered 429 to two of three feeds even spaced four seconds apart, so the
   * fix is to stop asking it three times. None of these sources notifies, so
   * reading each one every third cycle costs nothing that matters.
   */
  rotate?: string;
};
export type Retailer = { name: string; url: string; pattern: string };

/**
 * Gap between two requests to the same host.
 *
 * Four seconds because Reddit still answered 429 at one second. Keep the
 * number of feeds per host low enough that this fits inside the budget.
 */
const SAME_HOST_GAP_MS = 4000;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

/**
 * Poll a list of feeds.
 *
 * Requests to different hosts run in parallel, but requests to the SAME host
 * run one at a time with a gap. Firing three Reddit feeds simultaneously is
 * what earned us 429s; spaced out, they answer.
 *
 * `budgetMs` stops a slow host eating the scheduled function's 30 seconds:
 * once it is spent, the remaining feeds for that host are skipped and say so
 * rather than the whole run timing out.
 */
/**
 * Pick this cycle's feeds: everything ungrouped, plus one member of each
 * rotation group, chosen by a cursor that advances every pass.
 */
export function feedsForCycle(feeds: Feed[], cursor: number): Feed[] {
  const groups = new Map<string, Feed[]>();
  const picked: Feed[] = [];

  for (const f of feeds) {
    if (!f.rotate) picked.push(f);
    else {
      const list = groups.get(f.rotate);
      if (list) list.push(f);
      else groups.set(f.rotate, [f]);
    }
  }

  for (const group of groups.values()) {
    // A non-negative index whatever the cursor does, including wrapping past
    // Number.MAX_SAFE_INTEGER or arriving negative from stored state.
    const i = ((Math.trunc(cursor) % group.length) + group.length) % group.length;
    picked.push(group[i]);
  }

  return picked;
}

export async function pollFeeds(
  feeds: Feed[],
  include: string[],
  exclude: string[],
  notes: string[],
  requireAny: string[] = [],
  budgetMs = 20000,
  cursor = 0,
): Promise<Item[]> {
  const deadline = Date.now() + budgetMs;
  const thisCycle = feedsForCycle(feeds, cursor);

  // Say so, rather than letting a feed silently vanish from the notes and
  // look like it broke.
  for (const f of feeds) {
    if (!thisCycle.includes(f)) notes.push(`${f.name}: not this cycle, these take turns`);
  }

  const byHost = new Map<string, Feed[]>();
  for (const f of thisCycle) {
    const host = hostOf(f.url);
    const list = byHost.get(host);
    if (list) list.push(f);
    else byHost.set(host, [f]);
  }

  const perHost = [...byHost.values()].map(async (group) => {
    const found: Item[] = [];
    for (let i = 0; i < group.length; i++) {
      const feed = group[i];
      if (Date.now() >= deadline) {
        notes.push(`${feed.name}: skipped, out of time this cycle`);
        continue;
      }
      if (i > 0) await sleep(SAME_HOST_GAP_MS);
      try {
        const xml = await grab(feed.url, 6000);
        // A feed may carry its own gates. The store-sighting feeds need a
        // different question asked of them than the news feeds do: not "is
        // this a product and is something happening to it" but "is this about
        // a product at one of the stores he can actually drive to".
        const feedInclude = feed.include ?? include;
        const feedRequire = feed.requireAny ?? requireAny;
        const feedAlso = feed.requireAlso;
        const hits = parseFeed(xml, feed.name).filter((item) => {
          const text = `${item.title} ${item.detail || ""}`;
          if (!matches(text, feedInclude, exclude)) return false;
          if (!matches(text, feedRequire, [])) return false;
          return !feedAlso || matches(text, feedAlso, []);
        });
        notes.push(`${feed.name}: ${hits.length} match`);
        found.push(...hits);
      } catch (err) {
        notes.push(`${feed.name}: ${String(err).slice(0, 60)}`);
      }
    }
    return found;
  });

  return (await Promise.all(perHost)).flat();
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

// --------------------------------------------------------------------------
// Pokemon Center's own sitemap
// --------------------------------------------------------------------------

/**
 * Pokemon Center refuses hosted requests for its HTML pages, but it serves
 * robots.txt and its sitemaps to anyone. The sitemap is their own published
 * list of what exists on the site, so a product URL appearing there is
 * Pokemon Center themselves saying a new SKU exists. That is first-party and
 * worth far more than someone's word for it on a forum.
 *
 * This reads the published index, nothing hidden and nothing evaded.
 */

/**
 * Pull <url> entries with their <lastmod>, when the sitemap carries one.
 *
 * A new product URL appearing is a drop. A restock of something already listed
 * changes no URL at all, so the only hope of noticing one from a sitemap is a
 * lastmod that moves. Whether Pokémon Center publishes usable ones is a
 * question about their data, not their code, so this measures before anything
 * is built on it.
 */
export function extractUrlEntries(xml: string): { loc: string; lastmod: string }[] {
  const out: { loc: string; lastmod: string }[] = [];
  for (const block of xml.match(/<url\b[\s\S]*?<\/url>/gi) || []) {
    const loc = block.match(/<loc>\s*([^<\s]+)\s*<\/loc>/i);
    if (!loc) continue;
    const mod = block.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i);
    out.push({ loc: loc[1].replace(/&amp;/g, "&").trim(), lastmod: mod ? mod[1].trim() : "" });
  }
  return out;
}

export function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) =>
    m[1].replace(/&amp;/g, "&").trim(),
  );
}

/** The slug carries the product name, which is what we match against. */
export function slugWords(url: string): string {
  const tail = url.split("?")[0].split("/").filter(Boolean).pop() || "";
  return decodeURIComponent(tail).replace(/-/g, " ");
}

export function titleFromUrl(url: string): string {
  const words = slugWords(url);
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Point a canonical product URL at a regional storefront.
 *
 * The sitemap lists the unprefixed path. Aaron shops the Canadian store, and
 * landing straight on /en-ca saves a redirect and a region prompt when every
 * second counts.
 */
export function regionalise(url: string, region: string): string {
  if (!region) return url;
  try {
    const u = new URL(url);
    if (/^\/[a-z]{2}-[a-z]{2}\//i.test(u.pathname)) return url;
    u.pathname = `/${region}${u.pathname}`;
    return u.toString();
  } catch {
    return url;
  }
}

export type SitemapOptions = {
  indexUrl: string;
  /** Storefront prefix to put on product links, e.g. "en-ca". */
  region?: string;
  /** Only follow child sitemaps whose URL matches this. */
  childPattern?: string;
  /** Hard cap on child sitemaps fetched per cycle. */
  maxChildren?: number;
  /** Paths robots.txt forbids; anything under one of these is skipped. */
  disallowed?: string[];
  /**
   * Child sitemaps that worked on an earlier cycle. Used only when the index
   * itself comes back unreadable, so a challenged index costs one cycle of
   * freshness rather than silently stopping the whole watch.
   */
  knownChildren?: string[];
};

export type SitemapResult = {
  items: Item[];
  /** The child sitemaps this cycle actually used, worth remembering. */
  children: string[];
  /** Item key to the lastmod the sitemap gave it, empty string when absent. */
  lastmods: Record<string, string>;
  /** How many of the scanned URLs carried a lastmod at all. */
  withLastmod: number;
};

function isDisallowed(url: string, disallowed: string[]): boolean {
  if (!disallowed.length) return false;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return true;
  }
  return disallowed.some((rule) => rule && path.startsWith(rule));
}

/** A short, safe description of a response body, for a note. */
function describeBody(body: string): string {
  const head = body.slice(0, 70).replace(/\s+/g, " ").trim();
  return `${body.length} bytes, starts "${head}"`;
}

/** Read a set of child sitemaps and turn the product URLs into items. */
async function scanChildren(
  children: string[],
  opts: SitemapOptions,
  include: string[],
  exclude: string[],
  notes: string[],
): Promise<Omit<SitemapResult, "children">> {
  const { maxChildren = 2, disallowed = [], region = "" } = opts;
  const out: Item[] = [];
  const lastmods: Record<string, string> = {};
  let scanned = 0;
  let withLastmod = 0;

  for (const child of children.slice(0, maxChildren)) {
    if (isDisallowed(child, disallowed)) {
      notes.push(`Pokemon Center sitemap: robots.txt disallows ${child}`);
      continue;
    }
    try {
      await sleep(SAME_HOST_GAP_MS);
      const xml = await grab(child, 9000);
      const entries = extractUrlEntries(xml);
      scanned += entries.length;
      for (const { loc, lastmod } of entries) {
        if (lastmod) withLastmod++;
        if (isDisallowed(loc, disallowed)) continue;
        const name = slugWords(loc);
        if (!matches(name, include, exclude)) continue;
        // Key on the canonical URL so changing region never re-alerts.
        const key = `pc:${loc}`;
        lastmods[key] = lastmod;
        out.push({
          key,
          title: titleFromUrl(loc),
          source: "Pokémon Center",
          url: regionalise(loc, region),
          detail: "listed on Pokémon Center's own sitemap",
        });
      }
    } catch (err) {
      notes.push(`Pokemon Center sitemap child: ${String(err).slice(0, 60)}`);
    }
  }

  notes.push(`Pokémon Center: ${scanned} URLs scanned, ${out.length} match`);
  return { items: out, lastmods, withLastmod };
}

export async function pollSitemap(
  opts: SitemapOptions,
  include: string[],
  exclude: string[],
  notes: string[],
): Promise<SitemapResult> {
  const { indexUrl, childPattern = "product", knownChildren = [] } = opts;

  // A 200 with no sitemap in it is what Imperva serves when it challenges a
  // request. Asking again straight away is what got us challenged in the
  // first place, so read the index once per cycle and stand down when it says
  // nothing. The next cycle is five minutes away and costs nothing to wait
  // for. The remembered children are only worth trying when the index itself
  // errored, because a challenge applies to the whole host.
  let indexXml = "";
  try {
    indexXml = await grab(indexUrl, 9000);
  } catch (err) {
    notes.push(`Pokemon Center sitemap: ${String(err).slice(0, 60)}`);
    if (!knownChildren.length) return { items: [], children: [], lastmods: {}, withLastmod: 0 };
    notes.push(`Pokémon Center: trying ${knownChildren.length} child sitemaps from an earlier cycle`);
    return {
      ...(await scanChildren(knownChildren, opts, include, exclude, notes)),
      children: knownChildren,
    };
  }

  const allChildren = extractLocs(indexXml);
  if (!allChildren.length) {
    notes.push(
      `Pokémon Center: challenged this cycle, standing down until the next one (${describeBody(indexXml)})`,
    );
    return { items: [], children: [], lastmods: {}, withLastmod: 0 };
  }

  // Prefer a child sitemap that names itself after products, but do not
  // depend on that naming: if nothing matches, scan the first few anyway and
  // let the keyword filter decide. The note records what was actually there,
  // so the real layout is visible from the app rather than guessed at.
  const preferred = allChildren.filter((u) => u.toLowerCase().includes(childPattern));
  const children = preferred.length ? preferred : allChildren;
  notes.push(
    `Pokémon Center index: ${allChildren.length} child sitemaps [${allChildren
      .map((u) => u.split("/").pop())
      .slice(0, 8)
      .join(", ")}]`,
  );

  return {
    ...(await scanChildren(children, opts, include, exclude, notes)),
    children,
  };
}

/** Parse the Disallow rules that apply to everyone from a robots.txt. */
export function parseDisallowed(robots: string): string[] {
  const rules: string[] = [];
  let appliesToUs = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") appliesToUs = value === "*";
    else if (key === "disallow" && appliesToUs && value) rules.push(value);
  }
  return rules;
}
