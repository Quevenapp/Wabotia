import { execFileSync } from "node:child_process";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (args) =>
  execFileSync(npx, ["wrangler", ...args], { stdio: "inherit" });
execFileSync(npm, ["run", "build"], { stdio: "inherit" });
// Uma instalação existente migra antes de ativar o código novo
// (`npm run deploy -- --update`). A primeira publicação cria as ligações antes.
const updating = process.argv.includes("--update");
if (updating) run(["d1", "migrations", "apply", "DB", "--remote"]);
run(["deploy"]);
if (!updating) run(["d1", "migrations", "apply", "DB", "--remote"]);
