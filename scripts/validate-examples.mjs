import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const base = process.argv[2];
if (!base?.includes("staging")) throw Error("Use o ambiente staging.");
const credentials = JSON.parse(await readFile(".smoke.local.json", "utf8"));
const login = await fetch(base + "/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: base },
  body: JSON.stringify(credentials),
});
if (!login.ok) throw Error("Login de teste falhou.");
const cookie = login.headers.get("set-cookie").split(";")[0];
async function api(path, body, method = "POST") {
  const r = await fetch(base + "/api/v1" + path, {
    method,
    headers: {
      Cookie: cookie,
      Origin: base,
      "Idempotency-Key": randomUUID(),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw Error(path + " " + r.status);
  return r.json();
}
const profiles = await api("/profiles", undefined, "GET"),
  profile = profiles.at(-1).id;
const app = await api("/applications", {
  name: "Exemplos da documentação",
  profiles: [profile],
  bots: [],
  scopes: [
    "conversations:read",
    "conversations:write",
    "tickets:write",
    "tickets:read",
  ],
});
const key = await api("/applications/" + app.id + "/keys", { days: 1 });
const environment = {
  ...process.env,
  WABOTIA_URL: base,
  WABOTIA_KEY: key.token,
  WABOTIA_PROFILE: profile,
};
const results = [];
try {
  for (const [program, args] of [
    [process.execPath, ["examples/client.mjs"]],
    ["python3", ["examples/client.py"]],
    ["bash", ["examples/curl.sh"]],
  ]) {
    const r = spawnSync(program, args, { env: environment, encoding: "utf8" });
    results.push({ example: args[0], exit_code: r.status });
    if (r.status !== 0) throw Error("Exemplo falhou: " + args[0]);
    console.log("Validado: " + args[0]);
  }
} finally {
  await api("/keys/" + key.id, undefined, "DELETE");
}
await writeFile(
  "docs/reference/examples-validation.json",
  JSON.stringify(
    { date: new Date().toISOString(), environment: base, results },
    null,
    2,
  ),
);
