import { readFile } from "node:fs/promises";
const [file, ...flags] = process.argv.slice(2);
const { WABOTIA_URL, WABOTIA_KEY, WABOTIA_PROFILE, WABOTIA_REQUEST_ID } =
  process.env;
if (
  !file ||
  !WABOTIA_URL ||
  !WABOTIA_KEY ||
  !WABOTIA_PROFILE ||
  !WABOTIA_REQUEST_ID
)
  throw new Error(
    "Informe arquivo.json e as variáveis WABOTIA_URL, WABOTIA_KEY, WABOTIA_PROFILE e WABOTIA_REQUEST_ID.",
  );
const body = JSON.parse(await readFile(file, "utf8"));
if (
  body.template &&
  (!flags.includes("--allow-paid") || body.allow_paid !== true)
)
  throw new Error(
    "Modelo pago: confirme allow_paid: true no JSON e --allow-paid para autorizar este envio.",
  );
const base = `${WABOTIA_URL.replace(/\/$/, "")}/api/v1/profiles/${encodeURIComponent(WABOTIA_PROFILE)}/router/messages`;
const headers = {
  Authorization: `Bearer ${WABOTIA_KEY}`,
  "Content-Type": "application/json",
  "Idempotency-Key": WABOTIA_REQUEST_ID,
};
// No automatic retry: reuse this request ID and identical body after an ambiguous failure.
const response = await fetch(base, {
  method: "POST",
  headers,
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(60000),
});
const result = await response.json();
if (!response.ok) throw new Error(JSON.stringify(result));
console.log(JSON.stringify(result, null, 2));
const status = await fetch(
  `${base}/${encodeURIComponent(result.delivery_id)}`,
  {
    headers: { Authorization: headers.Authorization },
    signal: AbortSignal.timeout(15000),
  },
);
if (!status.ok)
  throw new Error(
    "Envio aceito; não repita com outro ID. Falhou a consulta: " +
      status.status,
  );
console.log(JSON.stringify(await status.json(), null, 2));
