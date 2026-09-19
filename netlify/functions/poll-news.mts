import type { Config } from "@netlify/functions";
import { runPass } from "./lib/pass.mjs";

export default async () => {
  const result = await runPass("news");
  console.log("poll:news", JSON.stringify(result));
};

export const config: Config = {
  // Offset from the Pokemon Center poll so the two never overlap.
  schedule: "2-59/5 * * * *",
};
