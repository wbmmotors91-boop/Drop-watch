import { env } from "./store.mjs";

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

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
