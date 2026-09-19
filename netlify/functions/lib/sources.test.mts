import {
  parseFeed, matches, extractProducts, stripHtml, grab, pollFeeds,
  extractLocs, extractUrlEntries, canadianOffer, slugWords, titleFromUrl, parseDisallowed, pollSitemap, regionalise, feedsForCycle,
} from "./sources.mts";
import {
  KEYWORDS_INCLUDE, KEYWORDS_EXCLUDE, CANADIAN_TERMS,
  STORE_SIGHTING_PRODUCTS, STORE_SIGHTING_STORES, STORE_SIGHTING_PLACES,
} from "./config.mts";

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
check("plural of a one-word term", matches("Two ETBs left", ["etb"], []), true);
check("plural of a phrase", matches("booster bundles are up", ["booster bundle"], []), true);
check("a longer word is still not a match", matches("Setbacks everywhere", ["etb"], []), false);
check("s does not run into the next word", matches("tinsel decorations", ["tin"], []), false);
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
  const { items } = await pollSitemap(
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

  console.log("regional links");
  check(
    "region prefix added",
    regionalise("https://www.pokemoncenter.com/product/10-1/x", "en-ca"),
    "https://www.pokemoncenter.com/en-ca/product/10-1/x",
  );
  check(
    "existing region left alone",
    regionalise("https://www.pokemoncenter.com/en-gb/product/10-1/x", "en-ca"),
    "https://www.pokemoncenter.com/en-gb/product/10-1/x",
  );
  check("no region is a no-op", regionalise("https://x/y", ""), "https://x/y");
  check("url kept intact", items[0].url, "https://www.pokemoncenter.com/en-ca/product/100-1/delta-reign-elite-trainer-box");

  // If robots ever forbids the product sitemap, we must stop by ourselves.
  const blockedNotes: string[] = [];
  const { items: blocked } = await pollSitemap(
    { indexUrl: "https://www.pokemoncenter.com/sitemap.xml", childPattern: "product", maxChildren: 2, disallowed: ["/sitemaps"] },
    ["booster box"],
    [],
    blockedNotes,
  );
  check("disallowed child sitemap is not fetched", blocked.length, 0);
  check("and it says why", blockedNotes.some((n) => n.includes("robots.txt disallows")), true);

  globalThis.fetch = realFetch;
}


// --- a challenged index stands down, an errored one falls back ------------
// Imperva answers 200 with a non-sitemap body when it challenges a request.
// Asking again straight away is what earns the challenge, so the cycle is
// abandoned instead. A genuine transport error is different: the host may
// still serve the child sitemaps we already know about.
{
  console.log("challenged sitemap index");
  const PRODUCTS = `<?xml version="1.0"?><urlset>
    <url><loc>https://www.pokemoncenter.com/en-ca/product/200-1/mega-charizard-booster-box</loc></url>
  </urlset>`;
  const CHALLENGE = "<html><head><title>Pardon Our Interruption</title></head><body>...</body></html>";
  const known = ["https://www.pokemoncenter.com/sitemaps/products-1.xml"];
  const realFetch = globalThis.fetch;

  const asked: string[] = [];
  globalThis.fetch = (async (u: any) => {
    asked.push(String(u));
    return { ok: true, status: 200, text: async () => CHALLENGE } as any;
  }) as any;

  const notes: string[] = [];
  const challenged = await pollSitemap(
    { indexUrl: "https://www.pokemoncenter.com/sitemap.xml", childPattern: "product", maxChildren: 1, knownChildren: known },
    ["booster box"],
    [],
    notes,
  );

  check("the index is read once, not hammered", asked.length, 1);
  check("nothing is returned from a challenged cycle", challenged.items.length, 0);
  check("and no children are remembered from it", challenged.children.length, 0);
  check("the note says it stood down", notes.some((n) => n.includes("standing down")), true);
  check("and says what came back", notes.some((n) => n.includes("Pardon Our Interruption")), true);

  // A transport error is not a challenge: the remembered children are worth a try.
  const errNotes: string[] = [];
  const errAsked: string[] = [];
  globalThis.fetch = (async (u: any) => {
    const url = String(u);
    errAsked.push(url);
    if (url.endsWith("/sitemap.xml")) return { ok: false, status: 503, text: async () => "" } as any;
    return { ok: true, status: 200, text: async () => PRODUCTS } as any;
  }) as any;

  const recovered = await pollSitemap(
    { indexUrl: "https://www.pokemoncenter.com/sitemap.xml", childPattern: "product", maxChildren: 1, knownChildren: known },
    ["booster box"],
    [],
    errNotes,
  );
  check("a failed index falls back to known children", recovered.items.length, 1);
  check("and keeps them for next time", recovered.children, known);
  check("the fallback is recorded", errNotes.some((n) => n.includes("from an earlier cycle")), true);

  // With nothing remembered there is nothing to fall back to, and it must
  // still say why it is empty.
  const coldNotes: string[] = [];
  globalThis.fetch = (async () => ({ ok: false, status: 503, text: async () => "" }) as any) as any;
  const cold = await pollSitemap(
    { indexUrl: "https://www.pokemoncenter.com/sitemap.xml", childPattern: "product", maxChildren: 1 },
    ["booster box"],
    [],
    coldNotes,
  );
  check("no items without a fallback", cold.items.length, 0);
  check("nothing to remember", cold.children.length, 0);
  check("but it says why", coldNotes.some((n) => n.includes("HTTP 503")), true);

  globalThis.fetch = realFetch;
}

// --- per-feed gates -------------------------------------------------------
// The shelf-sighting feed asks a different question than the news feeds, so a
// feed's own gates must apply to it alone and not leak onto its neighbours.
{
  console.log("per-feed gates");
  const realFetch = globalThis.fetch;
  const feedFor = (title: string) =>
    `<rss><item><title>${title}</title><link>L-${title}</link><guid>G-${title}</guid></item></rss>`;

  globalThis.fetch = (async (u: any) => {
    const url = String(u);
    const title = url.includes("sight")
      ? "Walmart in Stoney Creek had pokemon boxes on the shelf"
      : "Elite Trainer Box preorder live";
    return { ok: true, status: 200, text: async () => feedFor(title) } as any;
  }) as any;

  const notes: string[] = [];
  const items = await pollFeeds(
    [
      { name: "news", url: "https://news.example.com/a.rss" },
      {
        name: "sightings",
        url: "https://sight.example.com/b.rss",
        include: ["pokemon"],
        requireAny: ["walmart", "superstore"],
      },
    ],
    ["elite trainer box"],
    [],
    notes,
    ["preorder"],
  );

  check("both feeds produced an item", items.length, 2);
  check("the sighting came through its own gates", items.some((i) => i.source === "sightings"), true);
  check("the news feed kept the shared gates", items.some((i) => i.source === "news"), true);

  // A sighting that names no store must not pass, and the news gates must not
  // rescue it.
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, text: async () => feedFor("pokemon boxes at some shop") }) as any) as any;
  const storeless: string[] = [];
  const none = await pollFeeds(
    [{ name: "sightings", url: "https://sight.example.com/b.rss", include: ["pokemon"], requireAny: ["walmart", "superstore"] }],
    ["elite trainer box"],
    [],
    storeless,
    ["preorder"],
  );
  check("a sighting with no store is dropped", none.length, 0);

  globalThis.fetch = realFetch;
}


// --- rotation -------------------------------------------------------------
// Reddit answered 429 to two of three feeds even spaced four seconds apart, so
// they take turns instead. Nothing in a rotation group notifies, so a feed
// read every third cycle is fine; a feed never read is not.
{
  console.log("feed rotation");
  const feeds = [
    { name: "dexerto", url: "https://dexerto.example/f.rss" },
    { name: "r1", url: "https://reddit.example/1.rss", rotate: "reddit" },
    { name: "r2", url: "https://reddit.example/2.rss", rotate: "reddit" },
    { name: "r3", url: "https://reddit.example/3.rss", rotate: "reddit" },
  ];
  const namesAt = (c: number) => feedsForCycle(feeds, c).map((f) => f.name).sort();

  check("one reddit feed per cycle, plus the ungrouped one", feedsForCycle(feeds, 0).length, 2);
  check("ungrouped feed is read every cycle", namesAt(0).includes("dexerto"), true);
  check("cycle 0 takes the first", namesAt(0), ["dexerto", "r1"]);
  check("cycle 1 takes the second", namesAt(1), ["dexerto", "r2"]);
  check("cycle 2 takes the third", namesAt(2), ["dexerto", "r3"]);
  check("cycle 3 wraps around", namesAt(3), ["dexerto", "r1"]);

  // Every member must come up over a full turn, or a source is silently dead.
  const seen = new Set([0, 1, 2].flatMap((c) => feedsForCycle(feeds, c).map((f) => f.name)));
  check("every feed is read within one full rotation", [...seen].sort(), ["dexerto", "r1", "r2", "r3"]);

  // Stored state can come back odd; it must never index out of the group.
  check("a negative cursor still picks a real feed", namesAt(-1), ["dexerto", "r3"]);
  check("a huge cursor still picks a real feed", feedsForCycle(feeds, 2 ** 53).length, 2);
  check("no rotation groups is a no-op", feedsForCycle([feeds[0]], 5).length, 1);
}


// --- the real product list against real product names ---------------------
// Widening the keywords is the change most likely to go wrong quietly: too
// narrow and a drop is missed, too wide and Pokémon Center's merchandise
// starts sending notifications. These are real Pokémon Center product names.
{
  console.log("product keywords");
  const want = [
    "Pokemon Tcg 30th Celebration Pokemon Center Elite Trainer Box",
    "Pokemon Tcg Mega Evolution Pitch Black Booster Bundle 6 Packs",
    "Pokemon Tcg Terapagos Ex Ultra Premium Collection",
    "Pokemon Tcg Charizard Ex Super Premium Collection",
    "Pokemon Tcg Scarlet And Violet Black Bolt Binder Collection",
    "Pokemon Tcg Crown Zenith Booster Box",
    "Pokemon Tcg Zenith Box Set",
    "Pokemon Tcg Trainers Toolkit 2025",
    "Pokemon Tcg Mega Evolution Build And Battle Box",
    "Pokemon Tcg Charizard Ex Collector Chest",
    "Pokemon Tcg Paldea Adventure Collectors Tin",
    "Pokemon Tcg Mini Tin Scarlet Violet",
    "Pokemon Tcg Three Pack Blister Pikachu",
    "Pokemon Tcg Mewtwo Ex Box",
    "Pokemon Tcg Special Collection Greninja",
    // Real Pokémon Center names, from what the widened list actually matched.
    "Pokemon Tcg 30th Celebration Mini Tins 10 Pack",
    "Pokemon Tcg Mega Charizard Tin Mega Charizard X",
    "Pokemon Tcg Mega Evolution Perfect Order Build And Battle Box",
    "Pokemon Tcg Mega Evolution Ascended Heroes Mega Feraligatr Ex Box",
    "Pokemon Tcg Trainer S Toolkit 2025",
    "Pokemon Tcg Unova Mini Tin Display Box 8 Tins",
    "Pokemon Tcg Collector Chest Fall 2024",
    "Pokemon Tcg Scarlet And Violet Paradox Rift Build And Battle Stadium",
    "Pokemon Tcg Slashing Legends Tin Zacian Ex",
    "Pokemon Tcg Scarlet And Violet Prismatic Evolutions Accessory Pouch Special Collection",
  ];
  const dont = [
    "Pokemon Center Pikachu Plush 8 In",
    "Pokemon Tcg Card Sleeves Pikachu 65 Count",
    "Pokemon Tcg Deck Box Charizard",
    "Pokemon Center Storage Box Eevee",
    "Pokemon Center Lunch Tote Snorlax",
    "Pokemon Center Backpack Gengar",
    "Pokemon Center Keychain Mew",
    "Pokemon Tcg Playmat Mewtwo",
    "Pokemon Center T-Shirt Adult Charizard",
    "Pokemon Center Card File Box Eevee",
    "What Did I Pull From A Booster Box",
    "Deck Profile Gardevoir Elite Trainer Box",
    // Also real Pokémon Center names. Widening the net caught every one of
    // these, and each would have been a notification about socks.
    "Poke Ball Pattern Crew Socks Box Set 3 Pairs One Size Adult",
    "Pokemon Primers Box Set Collection Volume 2",
    "Pokemon Deluxe Pins Pikachu Pin Box Set 3 Pack",
    "Nature Is Timeless Pokemon Gardening Tin Sign",
    "Pokemon Holiday Pin Box Set",
    "Pokemon Deluxe Character Guide Limited Edition Box Set",
    "Pokemon Fossil Museum Skeletons Pin Box Set 4 Pack",
    "Pokemon Center Van Gogh Museum Pokemon Inspired By Paintings Pin Box Set 6 Pack",
    "Pokemon 30th Celebration Poster Collection",
    "Pokemon 30th Celebration Tech Sticker Collection",
  ];

  const missed = want.filter((t) => !matches(t, KEYWORDS_INCLUDE, KEYWORDS_EXCLUDE));
  const wrongly = dont.filter((t) => matches(t, KEYWORDS_INCLUDE, KEYWORDS_EXCLUDE));
  check("every sealed product is caught", missed, []);
  check("no merchandise gets through", wrongly, []);
}


// --- shelf sightings must be somewhere he can drive to --------------------
// These titles are real, taken from what the feed actually pulled in. Almost
// all of them are American online restock bots, which is exactly the "late and
// wrong" chatter he did not want. A sighting has to name a place.
{
  console.log("sighting location gate");
  const passes = (text: string) =>
    matches(text, STORE_SIGHTING_PRODUCTS, KEYWORDS_EXCLUDE) &&
    matches(text, STORE_SIGHTING_STORES, []) &&
    matches(text, STORE_SIGHTING_PLACES, []);

  const online = [
    "Pokemon Trainers Toolkit 2025 is in stock at Walmart for $32.99 (Less than MSRP)",
    "WALMART POKEMON RESTOCK ALERT: Pokemon Z-A NS2 + Trading Cards N - $93.97",
    "Pokemon First Partner Illustration Collection Series 3 is in stock at Walmart for $17.97",
    "Pokemon 30th Celebration Elite Trainer Box is in stock at Walmart for $69.97",
    "Walmart Pokémon Restock | Collectible POKEMON 30TH ANNIVERSARY ELITE TRAINER BOX",
  ];
  const local = [
    "Walmart Stoney Creek on Centennial just put out 30th Celebration ETBs",
    "Grimsby Superstore has booster bundles on the shelf right now",
    "Heads up Hamilton, Walmart restocked elite trainer boxes this morning",
    "Niagara Walmart had a pallet of booster boxes go out",
  ];

  check("American restock bots are dropped", online.filter(passes), []);
  check("local sightings get through", local.filter(passes).length, local.length);
  check("a local post naming no store is dropped", passes("Grimsby Costco had booster boxes"), false);
  check("a local post naming no product is dropped", passes("Walmart in Stoney Creek was busy today"), false);
}


// --- lastmod --------------------------------------------------------------
// A restock changes no URL, so a lastmod that moves is the only thing in a
// sitemap that could reveal one. Parse it without assuming it is there.
{
  console.log("lastmod parsing");
  const XML = `<?xml version="1.0"?><urlset>
    <url><loc>https://x/product/1/a-booster-box</loc><lastmod>2026-09-18T10:00:00Z</lastmod></url>
    <url><loc>https://x/product/2/an-elite-trainer-box</loc></url>
    <url><lastmod>2026-09-19</lastmod></url>
  </urlset>`;

  const entries = extractUrlEntries(XML);
  check("a url with no loc is skipped", entries.length, 2);
  check("lastmod is read when present", entries[0].lastmod, "2026-09-18T10:00:00Z");
  check("and is empty when absent", entries[1].lastmod, "");
  check("the loc still comes through", entries[1].loc, "https://x/product/2/an-elite-trainer-box");
  check("a sitemap with no lastmods at all parses", extractUrlEntries("<urlset><url><loc>https://x/y</loc></url></urlset>")[0].lastmod, "");
  check("garbage in", extractUrlEntries("not xml").length, 0);
}


// --- conditional requests -------------------------------------------------
// Checking often is only defensible if an unchanged list costs a 304 rather
// than thirty-four thousand URLs. A 304 must mean "nothing new", not "empty".
{
  console.log("conditional sitemap requests");
  const INDEX = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://www.pokemoncenter.com/sitemaps/products.xml</loc></sitemap></sitemapindex>`;
  const PRODUCTS = `<?xml version="1.0"?><urlset>
    <url><loc>https://www.pokemoncenter.com/en-ca/product/1/a-booster-box</loc></url>
  </urlset>`;
  const realFetch = globalThis.fetch;
  const sent: Record<string, string>[] = [];

  // First read: the server offers an ETag.
  globalThis.fetch = (async (u: any, init: any) => {
    const url = String(u);
    sent.push(init?.headers || {});
    const body = url.includes("products") ? PRODUCTS : INDEX;
    return {
      ok: true,
      status: 200,
      text: async () => body,
      headers: { get: (h: string) => (h.toLowerCase() === "etag" ? '"v1"' : "") },
    } as any;
  }) as any;

  const first = await pollSitemap(
    { indexUrl: "https://www.pokemoncenter.com/sitemap.xml", childPattern: "product", maxChildren: 1 },
    ["booster box"],
    [],
    [],
  );
  const child = "https://www.pokemoncenter.com/sitemaps/products.xml";
  check("the product was read", first.items.length, 1);
  check("the validator was kept", first.validators[child].etag, '"v1"');

  // Second read: the same ETag comes back, so the server answers 304.
  const conditional: Record<string, string>[] = [];
  globalThis.fetch = (async (u: any, init: any) => {
    const url = String(u);
    conditional.push(init?.headers || {});
    if (url.includes("products")) {
      return { ok: false, status: 304, text: async () => "", headers: { get: () => "" } } as any;
    }
    return { ok: true, status: 200, text: async () => INDEX, headers: { get: () => "" } } as any;
  }) as any;

  const notes: string[] = [];
  const second = await pollSitemap(
    {
      indexUrl: "https://www.pokemoncenter.com/sitemap.xml",
      childPattern: "product",
      maxChildren: 1,
      validators: first.validators,
    },
    ["booster box"],
    [],
    notes,
  );

  const asked = conditional.find((h) => h["If-None-Match"]);
  check("the stored validator was sent back", asked?.["If-None-Match"], '"v1"');
  check("a 304 yields nothing new", second.items.length, 0);
  check("and is reported as unchanged, not as a failure", second.allUnchanged, true);
  check("the note says so", notes.some((n) => n.includes("unchanged since the last check")), true);
  check("the validator survives a 304", second.validators[child]?.etag, '"v1"');

  globalThis.fetch = realFetch;
}


// --- Canadian only --------------------------------------------------------
// A US price on a US shelf is no use to him, and a US checkout means paying
// cross-border shipping on a box he could get here.
{
  console.log("Canadian gating");
  const passes = (text: string) =>
    matches(text, KEYWORDS_INCLUDE, KEYWORDS_EXCLUDE) && matches(text, CANADIAN_TERMS, []);

  check("a US post is dropped", passes("Target has elite trainer boxes in stock $49.99"), false);
  check("a Canadian post gets through", passes("EB Games Canada has elite trainer boxes in stock"), true);
  check("a province counts", passes("Booster box restock in Ontario today"), true);
  check("a city counts", passes("Elite trainer box at Indigo in Hamilton"), true);

  // The barcode is worth having even with no Canadian seller; the US
  // storefront link is not.
  check(
    "a Canadian offer is used",
    canadianOffer([{ link: "https://www.amazon.com/x" }, { link: "https://www.bestbuy.ca/y" }]),
    "https://www.bestbuy.ca/y",
  );
  check("US only offers give no link", canadianOffer([{ link: "https://www.walmart.com/x" }]), "");
  check("a named Canadian merchant counts", canadianOffer([{ link: "https://shop.example/x", merchant: "Toys R Us Canada" }]), "https://shop.example/x");
  check("no offers at all is safe", canadianOffer(undefined), "");
  check("a malformed offer is skipped", canadianOffer([{ link: "not a url" }, { link: "https://indigo.ca/z" }]), "https://indigo.ca/z");
}

console.log(fails ? `\n${fails} failed` : "\nall passed (parsers, news gate, retries, staggering, sitemap)");
process.exit(fails ? 1 : 0);
