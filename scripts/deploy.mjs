import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (args) =>
  execFileSync(npx, ["wrangler", ...args], { stdio: "inherit" });
execFileSync(npm, ["run", "build"], { stdio: "inherit" });
// Existing installations migrate before activating new code. First deploys provision bindings first.
const updating =
  !!process.env.WABOTIA_UPDATE_ORIGIN || existsSync(".wabotia-source-commit");
if (updating) run(["d1", "migrations", "apply", "DB", "--remote"]);
run(["deploy"]);
if (!updating) run(["d1", "migrations", "apply", "DB", "--remote"]);
