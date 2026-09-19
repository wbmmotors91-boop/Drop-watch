import { env, itemsAfterPrune } from "./store.mjs";
import { backoffFor } from "./pass.mjs";

let fails = 0;
const check = (n: string, got: any, want: any) => {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log("  pass ", n);
  else { console.log(`  FAIL  ${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fails++; }
};

console.log("env()");
delete (globalThis as any).Netlify;
process.env.PC_TEST = "from-process";
check("falls back to process.env", env("PC_TEST"), "from-process");
check("missing is empty string", env("PC_TEST_MISSING"), "");

(globalThis as any).Netlify = { env: { get: (k: string) => (k === "PC_TEST" ? "from-global" : undefined) } };
check("prefers the Netlify global", env("PC_TEST"), "from-global");
check("global miss falls through", env("PC_TEST_OTHER"), "");
process.env.PC_TEST_OTHER = "only-in-process";
check("global miss uses process.env", env("PC_TEST_OTHER"), "only-in-process");

(globalThis as any).Netlify = { env: { get: () => { throw new Error("boom"); } } };
check("throwing global does not break it", env("PC_TEST"), "from-process");


// --- pruning ---------------------------------------------------------------
// Tightening the keywords has to clear out what the looser rules let through,
// without touching sources that passed different gates entirely.
{
  console.log("itemsAfterPrune");
  const items = [
    { key: "a", title: "Pokemon Tcg 30th Celebration Elite Trainer Box", source: "Pokémon Center", url: "u" },
    { key: "b", title: "Poke Ball Pattern Crew Socks Box Set", source: "Pokémon Center", url: "u" },
    { key: "c", title: "Walmart Stoney Creek put out ETBs", source: "Walmart & Superstore sightings", url: "u" },
  ] as any[];
  const keep = (t: string) => !t.toLowerCase().includes("socks");

  const out = itemsAfterPrune(items, "Pokémon Center", keep);
  check("the socks are gone", out.map((i: any) => i.key), ["a", "c"]);
  check("another source is untouched", out.some((i: any) => i.source.includes("sightings")), true);
  check("nothing to drop leaves it alone", itemsAfterPrune(items, "Nobody", keep).length, 3);
}


// --- backoff ---------------------------------------------------------------
// Being refused means ask less, so each refusal has to wait longer than the
// last, and it has to stop growing before it stops checking altogether.
{
  console.log("backoffFor");
  check("no failures, no wait", backoffFor(0), 0);
  check("first refusal waits five minutes", backoffFor(1), 5 * 60 * 1000);
  check("second doubles", backoffFor(2), 10 * 60 * 1000);
  check("third doubles again", backoffFor(3), 20 * 60 * 1000);
  check("it caps at an hour", backoffFor(9), 60 * 60 * 1000);
  check("and stays capped", backoffFor(100), 60 * 60 * 1000);
  check("a negative count is treated as none", backoffFor(-1), 0);
}

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
