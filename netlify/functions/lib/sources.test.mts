import {
  parseFeed, matches, extractProducts, stripHtml, grab, pollFeeds,
  extractLocs, slugWords, titleFromUrl, parseDisallowed, pollSitemap,
} from "./sources.mts";

let fails = 0;
const check = (name: string, got: any, want: any) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log("  pass ", name); }
  else { console.log(`  FAIL  ${name}\n        got:  ${g}\n        want: ${w}`); fails++; }
};

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>Delta Reign Elite Trainer Box Revealed</title>
<link>https://www.pokebeach.com/a</link><guid>pb-1</guid>
<description><![CDATA[<p>The <b>ETB</b> lands Nov 6 &amp; sells fast.</p>]]></description></item>
<item><title>Worlds Deck Profile: Gardevoir</title><link>https://www.pokebeach.com/b</link>
<guid>pb-2</guid><description>A deck profile.</description></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Pokemon Center booster box up early</title>
<link rel="alternate" href="https://reddit.com/r/x/1"/><id>t3_x1</id>
<summary>Booster box went live on the Canadian site.</summary></entry></feed>`;

console.log("parseFeed RSS");
const rss = parseFeed(RSS, "PokeBeach");
check("two items", rss.length, 2);
check("title", rss[0].title, "Delta Reign Elite Trainer Box Revealed");
check("guid key", rss[0].key, "pb-1");
check("cdata + entities", rss[0].detail, "The ETB lands Nov 6 & sells fast.");

console.log("parseFeed Atom");
const atom = parseFeed(ATOM, "reddit");
check("one entry", atom.length, 1);
check("href", atom[0].url, "https://reddit.com/r/x/1");
check("id key", atom[0].key, "t3_x1");

console.log("matches");
const inc = ["elite trainer box", "etb", "booster box"];
const exc = ["deck profile"];
check("phrase", matches(rss[0].title, inc, exc), true);
check("excluded", matches(rss[1].title, inc, exc), false);
check("whole word only", matches("Setback report", ["etb"], []), false);
check("bare word", matches("Grab the ETB", ["etb"], []), true);
check("empty include", matches("anything", [], []), true);
check("case", matches("BOOSTER BOX", inc, exc), true);
// Terms are normalised before matching, so punctuation is stripped rather
// than compiled into the pattern. The point of the check is that a term full
// of regex metacharacters cannot throw.
check("punctuation normalised away", matches("c++ stuff", ["c++"], []), true);
check("metachars do not throw", matches("plain text", ["(*.[bad"], []), false);
check("pre-order hyphen", matches("Pre-Order live now", ["pre-order"], []), true);

console.log("extractProducts");
const LISTING = `<a href="/en-ca/product/100-1/delta-etb?x=1"><img alt="Delta Reign Elite Trainer Box"/></a>
<a href="/en-ca/product/100-2/pikachu-plush">Pikachu Plush</a>
<a href="/en-ca/help/shipping">Shipping</a>`;
const prods = extractProducts(LISTING, "/product/", "https://example.com/en-ca/cat");
check("only products", prods.length, 2);
check("absolute, no query", prods[0][0], "https://example.com/en-ca/product/100-1/delta-etb");
check("alt fallback title", prods[0][1], "Delta Reign Elite Trainer Box");

console.log("robustness");
check("unescaped ampersand survives", parseFeed('<rss><item><title>Sword & Shield ETB</title><link>x</link></item></rss>', "s").length, 1);
check("empty feed", parseFeed("<rss><channel></channel></rss>", "s").length, 0);
check("garbage in", parseFeed("not xml at all", "s").length, 0);
check("strip nested html", stripHtml("<div><script>bad()</script>Hello <b>there</b></div>"), "Hello there");

// --- news two-gate filter -------------------------------------------------
// A feed item must both name a product and say something is happening to it.
{
  console.log("news two-gate filter");
  const PRODUCTS = ["elite trainer box", "etb", "booster box"];
  const EVENTS = ["preorder", "restock", "live", "revealed"];
  const both = (t: string) => matches(t, PRODUCTS, []) && matches(t, EVENTS, []);

  check("product + event fires", both("Delta Reign Elite Trainer Box preorder is live"), true);
  check("product without event stays quiet", both("Which elite trainer box has the best art"), false);
  check("event without product stays quiet", both("Restock happening at Walmart today"), false);
  check("neither stays quiet", both("Worlds recap thread"), false);
}

// --- grab retries ---------------------------------------------------------
{
  console.log("grab retry behaviour");
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const respond = (statuses: number[]) => {
    let i = 0;
    globalThis.fetch = (async (u: any) => {
      calls.push(String(u));
      const status = statuses[Math.min(i++, statuses.length - 1)];
      return { ok: status >= 200 && status < 300, status, text: async () => "<rss/>" } as any;
    }) as any;
  };

  calls.length = 0;
  respond([429, 200]);
  check("retries a 429 and succeeds", await grab("https://x/1", 100), "<rss/>");
  check("took two attempts", calls.length, 2);

  calls.length = 0;
  respond([403]);
  await grab("https://x/2", 100).then(
    () => check("403 should reject", true, false),
    (e) => check("403 rejects without retrying", e.message, "HTTP 403"),
  );
  check("403 tried once only", calls.length, 1);

  calls.length = 0;
  respond([500, 500]);
  await grab("https://x/3", 100).then(
    () => check("persistent 500 should reject", true, false),
    (e) => check("gives up after the retry", e.message, "HTTP 500"),
  );
  check("500 tried twice", calls.length, 2);

  globalThis.fetch = realFetch;
}

// --- pollFeeds host staggering -------------------------------------------
{
  console.log("pollFeeds staggering");
  const realFetch = globalThis.fetch;
  const hits: { url: string; at: number }[] = [];
  const FEED = '<rss><item><title>Elite Trainer Box preorder live</title><link>L</link><guid>G</guid></item></rss>';

  globalThis.fetch = (async (u: any) => {
    hits.push({ url: String(u), at: Date.now() });
    return { ok: true, status: 200, text: async () => FEED } as any;
  }) as any;

  const notes: string[] = [];
  const started = Date.now();
  const items = await pollFeeds(
    [
      { name: "reddit A", url: "https://www.reddit.com/a.rss" },
      { name: "reddit B", url: "https://www.reddit.com/b.rss" },
      { name: "other", url: "https://example.com/c.rss" },
    ],
    ["elite trainer box"],
    [],
    notes,
    ["preorder"],
  );
  const elapsed = Date.now() - started;

  check("every feed produced an item", items.length, 3);
  check("a note per feed", notes.length, 3);
  const reddit = hits.filter((h) => h.url.includes("reddit")).sort((a, b) => a.at - b.at);
  check("both reddit feeds were fetched", reddit.length, 2);
  check("same host requests are spaced", reddit[1].at - reddit[0].at >= 3800, true);
  check("different hosts are not serialised behind it", hits.some((h) => !h.url.includes("reddit") && h.at - started < 1000), true);

  // An exhausted budget must skip rather than blow the function's 30s limit.
  const lateNotes: string[] = [];
  await pollFeeds(
    [{ name: "too late", url: "https://www.reddit.com/z.rss" }],
    ["elite trainer box"],
    [],
    lateNotes,
    ["preorder"],
    -1,
  );
  check("out of budget skips with a note", lateNotes[0], "too late: skipped, out of time this cycle");

  globalThis.fetch = realFetch;
}

// --- sitemap reading ------------------------------------------------------
{
  console.log("sitemap parsing");
  const INDEX = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://www.pokemoncenter.com/sitemaps/pages.xml</loc></sitemap><sitemap><loc>https://www.pokemoncenter.com/sitemaps/products-1.xml</loc></sitemap></sitemapindex>`;
  const PRODUCTS = `<?xml version="1.0"?><urlset>
    <url><loc>https://www.pokemoncenter.com/en-ca/product/100-1/delta-reign-elite-trainer-box</loc></url>
    <url><loc>https://www.pokemoncenter.com/en-ca/product/100-2/pikachu-plush-keychain</loc></url>
    <url><loc>https://www.pokemoncenter.com/en-ca/product/100-3/mega-rayquaza-booster-box</loc></url>
    <url><loc>https://www.pokemoncenter.com/carts/secret</loc></url>
  </urlset>`;

  check("index locs", extractLocs(INDEX).length, 2);
  check("slug becomes words", slugWords("https://x/en-ca/product/100-1/delta-reign-elite-trainer-box"), "delta reign elite trainer box");
  check("title cased", titleFromUrl("https://x/p/mega-rayquaza-booster-box"), "Mega Rayquaza Booster Box");

  const ROBOTS = `# comment\nUser-agent: *\nDisallow: /carts\nDisallow: /cortex\n\nUser-agent: BadBot\nDisallow: /`;
  const rules = parseDisallowed(ROBOTS);
  check("only the wildcard block applies", rules, ["/carts", "/cortex"]);

  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (u: any) => {
    const url = String(u);
    asked.push(url);
    const body = url.includes("products-1") ? PRODUCTS : INDEX;
    return { ok: true, status: 200, text: async () => body } as any;
  }) as any;

  const notes: string[] = [];
  const items = await pollSitemap(
    { indexUrl: "https://www.pokemoncenter.com/sitemap.xml", childPattern: "product", maxChildren: 2, disallowed: rules },
    ["elite trainer box", "booster box"],
    [],
    notes,
  );

  check("only the product sitemap was followed", asked.filter((u) => u.includes("pages.xml")).length, 0);
  check("two sealed products matched", items.length, 2);
  check("plush was filtered out", items.some((i) => i.title.includes("Plush")), false);
  check("robots-disallowed path skipped", items.some((i) => i.url.includes("/carts")), false);
  check("source is named for the user", items[0].source, "Pokémon Center");
  check("url kept intact", items[0].url, "https://www.pokemoncenter.com/en-ca/product/100-1/delta-reign-elite-trainer-box");

  // If robots ever forbids the product sitemap, we must stop by ourselves.
  const blockedNotes: string[] = [];
  const blocked = await pollSitemap(
    { indexUrl: "https://www.pokemoncenter.com/sitemap.xml", childPattern: "product", maxChildren: 2, disallowed: ["/sitemaps"] },
    ["booster box"],
    [],
    blockedNotes,
  );
  check("disallowed child sitemap is not fetched", blocked.length, 0);
  check("and it says why", blockedNotes.some((n) => n.includes("robots.txt disallows")), true);

  globalThis.fetch = realFetch;
}

console.log(fails ? `\n${fails} failed` : "\nall passed (parsers, news gate, retries, staggering, sitemap)");
process.exit(fails ? 1 : 0);
