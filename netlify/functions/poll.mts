import type { Config } from "@netlify/functions";
import { runPass } from "./lib/pass.mjs";

/**
 * Pokemon Center's own sitemap, on its own schedule.
 *
 * It gets a function to itself because it is the source that matters most
 * and the one that needs the most time: robots.txt, then the index, then a
 * child sitemap, spaced out so we are never hammering them.
 *
 * Every five minutes, not every minute.
 *
 * One minute was tried, with conditional requests making most checks nearly
 * free, and Pokemon Center answered 403 to everything within the hour. Cheap
 * requests are still requests, and their edge counts requests. When they
 * refuse, the pass now backs off for five minutes, then ten, then twenty, up
 * to an hour, because being refused is them saying we ask too often and the
 * only correct answer is to ask less.
 */
export default async () => {
  const result = await runPass("pc");
  console.log("poll:pc", JSON.stringify(result));
};

export const config: Config = {
  schedule: "*/5 * * * *",
};
