import { basename, join } from "node:path";
import { readdirSync } from "node:fs";
import { validatePlan } from "./plan-schema";

const paths = process.argv.slice(2);
if (!paths.length) {
  const dir = join(import.meta.dir, "../plans");
  paths.push(...readdirSync(dir).filter(name => name.endsWith(".json")).map(name => join(dir, name)));
}
if (!paths.length) { console.error("No training plans found"); process.exit(1); }
let failed = false;
for (const path of paths) {
  try {
    validatePlan(await Bun.file(path).json(), basename(path, ".json"));
    console.log(`Valid: ${path}`);
  } catch (error) {
    failed = true;
    console.error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failed) process.exitCode = 1;
