import type { Config } from "@netlify/functions";
import { runPass } from "./lib/pass.mjs";

/**
 * Pokemon Center's own sitemap, on its own schedule.
 *
 * It gets a function to itself because it is the source that matters most
 * and the one that needs the most time: robots.txt, then the index, then a
 * child sitemap, spaced out so we are never hammering them.
 */
export default async () => {
  const result = await runPass("pc");
  console.log("poll:pc", JSON.stringify(result));
};

export const config: Config = {
  schedule: "*/5 * * * *",
};
