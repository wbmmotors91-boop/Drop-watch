import type { Config } from "@netlify/functions";
import { runPass } from "./lib/pass.mjs";

/**
 * Pokemon Center's own sitemap, on its own schedule.
 *
 * It gets a function to itself because it is the source that matters most
 * and the one that needs the most time: robots.txt, then the index, then a
 * child sitemap, spaced out so we are never hammering them.
 *
 * Every minute, which is only reasonable because almost every check now costs
 * two conditional requests answered 304. The full list is downloaded only when
 * it has actually changed, their robots.txt is re-read hourly rather than
 * every cycle, and a blocked check stands down until the next one. Without those
 * three things a one-minute cadence would mean more blocking and fewer drops
 * caught, not more.
 */
export default async () => {
  const result = await runPass("pc");
  console.log("poll:pc", JSON.stringify(result));
};

export const config: Config = {
  schedule: "* * * * *",
};
