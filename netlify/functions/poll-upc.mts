import type { Config } from "@netlify/functions";
import { runPass } from "./lib/pass.mjs";

export default async () => {
  const result = await runPass("upc");
  console.log("poll-upc", JSON.stringify(result));
};

export const config: Config = {
  // The free barcode tier allows about 100 lookups a day, so three queries
  // every three hours keeps it comfortably inside that.
  schedule: "17 */3 * * *",
};
