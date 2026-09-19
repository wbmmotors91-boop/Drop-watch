import type { Config } from "@netlify/functions";
import { runPass } from "./lib/pass.mjs";

export default async () => {
  const result = await runPass("fast");
  console.log("poll", JSON.stringify(result));
};

export const config: Config = {
  schedule: "*/5 * * * *",
};
