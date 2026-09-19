import { env, itemsAfterPrune } from "./store.mjs";
import { backoffFor, challengeBackoffFor, trimSeen } from "./pass.mjs";

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
  const keep = (i: any) => !String(i.title).toLowerCase().includes("socks");

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

  // The odd challenge is ordinary and must cost nothing, or the watch spends
  // its life backing off from normal behaviour.
  check("one challenge is free", challengeBackoffFor(1), 0);
  check("so are three", challengeBackoffFor(3), 0);
  check("the fourth eases off", challengeBackoffFor(4), 5 * 60 * 1000);
  check("the fifth doubles", challengeBackoffFor(5), 10 * 60 * 1000);
  check("it caps at half an hour", challengeBackoffFor(20), 30 * 60 * 1000);
  check("a challenge never waits as long as a refusal", challengeBackoffFor(20) < backoffFor(20), true);
}

{
  console.log("trimSeen");
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);

  // The bug that invented drops: a source with more live products than the
  // cap lost the overflow every pass and rediscovered it on the next one.
  const big = trimSeen({ pc: keys(1279) }, { pc: 1279 }, 800);
  check("a live count above the cap is kept whole", big.pc.length, 1279);
  check("and keeps the very first key", big.pc[0], "k0");

  // History beyond what is on the shelf is still allowed to fall off.
  const old = trimSeen({ pc: keys(1279) }, { pc: 100 }, 800);
  check("history past the cap is trimmed", old.pc.length, 800);
  check("the newest keys are the ones kept", old.pc[799], "k1278");

  check("under the cap is untouched", trimSeen({ pc: keys(5) }, { pc: 5 }, 800).pc.length, 5);
  check("a source absent from this pass still trims", trimSeen({ pc: keys(900) }, {}, 800).pc.length, 800);
  check("other sources are trimmed on their own count", Object.keys(trimSeen({ pc: keys(3) , news: keys(2) }, { pc: 3 }, 800)).length, 2);
}


console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
