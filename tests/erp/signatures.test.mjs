// Argumentos dos RPCs no motor (engine/args.ts) contra o oráculo: as
// assinaturas geradas, a leitura de cada tipo e a chamada inteira (42883,
// 22P02, 22003, 22007, 22008 e DEFAULT) nos RPCs portados.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { readSignatures } from "../../scripts/erp/gen-signatures.mjs";
import { SIGNATURES } from "../../src/erp/engine/signatures.generated.ts";
import { boolIn, intIn, uuidIn } from "../../src/erp/engine/args.ts";
import { portedRpcs } from "../../src/erp/engine/registry.ts";
import "../../src/erp/domains/index.ts";

const f = await dualFixture();
test.after(() => f.close());

test("signatures.generated.ts é o do oráculo, e todo RPC registrado tem assinatura", async () => {
  assert.deepEqual(await readSignatures(f.db), SIGNATURES, "rode node --no-warnings scripts/erp/gen-signatures.mjs");
  assert.deepEqual(portedRpcs().filter((name) => !SIGNATURES[name]), []);
});

// Cada texto no tipo do Postgres (pg_input_is_valid/pg_input_error_info) e no motor.
async function pgInput(type, text) {
  const r = (
    await f.db.query(
      `select pg_input_is_valid($1::text,$2) ok, (pg_input_error_info($1::text,$2)).sql_error_code code, (pg_input_error_info($1::text,$2)).message message`,
      [text, type],
    )
  ).rows[0];
  if (!r.ok) return { error: { code: r.code, message: r.message } };
  return { value: (await f.db.query(`select ($1::text::${type})::text v`, [text])).rows[0].v };
}
function engineInput(fn) {
  try {
    return { value: String(fn()) };
  } catch (e) {
    return { error: { code: e.code, message: e.message } };
  }
}
const INTEGERS = ["0", "-0", "+5", "007", " 12 ", "\t7\n", "\v3\f", "1_000", "_1", "1__0", "1_", "0x1F", "0X1f", "0x_1F", "0x", "0o17", "0O_7", "0b101", "0b2",
  "-2147483648", "2147483647", "2147483648", "-2147483649", "0x7fffffff", "0x80000000", "-0x80000000", "1e3", "1.5", "١٢", " - 5", "+", "-", "", "abc", "12abc", "9007199254740993"];
const BIGINTS = ["9223372036854775807", "9223372036854775808", "-9223372036854775808", "-9223372036854775809", "-0x8000000000000000", "0x8000000000000000", "1_000_000", "9007199254740993"];
const BOOLEANS = ["t", "T", "tr", "TRUE ", " yes", "y", "Ye", "n", "no", "o", "on", "ON", "of", "off", "offf", "1", "0", "01", "10", "", " ", "f", "fa", "FALSE", "true1", "2", "\ttrue\n"];
const UUIDS = ["00000000-0000-4000-8000-000000000001", "0000000000004000800000000000000A", "{00000000-0000-4000-8000-000000000001}", "{00000000-0000-4000-8000-000000000001",
  "0000-0000-0000-4000-8000-0000-0000-0001", "00000000-0000-4000-8000-00000000000-1", "-00000000000040008000000000000001", "00000000000040008000000000000001-",
  " 00000000000040008000000000000001", "000000000000400080000000000000011", "0000000000004000800000000000000", "0000000g000040008000000000000001", "", "x", "{}"];

test("leitura de integer, bigint, boolean e uuid igual à do Postgres", async () => {
  const cases = [
    ...INTEGERS.map((t) => ["integer", t, () => intIn(t, "integer")]),
    ...BIGINTS.map((t) => ["bigint", t, () => intIn(t, "bigint")]),
    ...BOOLEANS.map((t) => ["boolean", t, () => boolIn(t)]),
    ...UUIDS.map((t) => ["uuid", t, () => uuidIn(t)]),
  ];
  for (const [type, text, fn] of cases) assert.deepEqual(engineInput(fn), await pgInput(type, text), `${type} ${JSON.stringify(text)}`);
});

test("chamada: resolução por nome, tipos na ordem dos argumentos e DEFAULT", async () => {
  const user = randomUUID();
  // Erro do RPC é aceito (os motores já concordaram); divergência não.
  const divergence = (e) => {
    if (e.code === "ERR_ASSERTION") throw e;
  };
  const list = (args) => f.rpc("erp_activity_list", args);
  const base = { p_user_id: user, p_from: null, p_to: null, p_module: null, p_operation: null, p_actor: null, p_query: null, p_limit: 10, p_offset: 0 };
  const expectError = async (args, code) => {
    // f.rpc compara os dois motores (código e mensagem) e relança o erro.
    await assert.rejects(() => list(args), (e) => e.code === code);
  };
  await expectError({ ...base, p_user_id: "x" }, "22P02");
  await expectError({ ...base, p_user_id: 5 }, "22P02");
  await expectError({ ...base, p_limit: "abc" }, "22P02");
  await expectError({ ...base, p_limit: 1.5 }, "22P02");
  await expectError({ ...base, p_limit: "" }, "22P02");
  await expectError({ ...base, p_limit: "99999999999" }, "22003");
  await expectError({ ...base, p_from: "2026-02-30" }, "22008");
  await expectError({ ...base, p_from: "ontem" }, "22007");
  await expectError({ ...base, p_actor: "nao-e-uuid" }, "22P02");
  // Dois argumentos ruins: vale o primeiro na ordem da chamada.
  const { p_limit, ...noLimit } = base;
  await expectError({ p_limit: "x", ...noLimit, p_from: "ontem" }, "22P02");
  await expectError({ ...noLimit, p_from: "ontem", p_limit: "x" }, "22007");
  // Desconhecido e obrigatório faltando: 42883 com os nomes na ordem dada.
  await expectError({ ...base, p_extra: 1 }, "42883");
  await expectError(noLimit, "42883");
  // Formas aceitas pelo Postgres chegam ao corpo já convertidas.
  for (const limit of [" 12 ", "0x10", "1_0", "+3"]) await list({ ...base, p_limit: limit }).catch(divergence);
  await list({ ...base, p_user_id: user.toUpperCase().replace(/-/g, "") }).catch(divergence);
  // DEFAULT: p_write omitido vale false; p_lease omitido vale null.
  await f.rpc("erp_company_logo_object", { p_user_id: user, p_id: randomUUID() }).catch(divergence);
  await f.rpc("erp_company_logo_stop", { p_user_id: user, p_id: randomUUID(), p_abort: true }).catch(divergence);
});
