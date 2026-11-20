// As duas telas de auditoria pela rota pública: Worker → erp-api → Coordinator.
// As mensagens das asserções incluem o corpo porque console não sai no runner.
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { exec } from "../src/db";
import { erpStub } from "../src/erp/hub";
import { bearer, fixture } from "./service-center-fixture";
import { enableErpParts, setModule } from "./erp-module-helper";
import { ENTRIES_SQL, entriesBindings } from "../src/erp/domains/access/activity";

const AT = "1795089600000000";
const PERIOD = "de=2026-11-01&ate=2026-11-19";
const screens = [
  ["Registro de atividades", ""],
  ["Consulta de exclusões", "&operacao=exclusao"],
] as const;

async function setup() {
  const f = await fixture();
  await enableErpParts(f.profile, f.admin.id);
  const token = await bearer(f.admin);
  const get = async (path: string, credential = token) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`https://test/api/v1/profiles/${f.profile}${path}`, {
      headers: { Authorization: "Bearer " + credential },
    }), env as any, ctx);
    await waitOnExecutionContext(ctx);
    return { status: response.status, body: await response.json<any>(), timing: response.headers.get("Server-Timing") ?? "" };
  };
  const seed = () => runInDurableObject(erpStub(env, f.profile), (_instance: any, state: DurableObjectState) => {
    const sql = state.storage.sql;
    for (const [index, name] of ["Ação arquivada A", "Ação arquivada B"].entries()) {
      const id = crypto.randomUUID();
      sql.exec(`INSERT INTO erp_catalog__record(id,entity,name,code,active,created_by,updated_by,created_at,updated_at)
        VALUES(?,'contacts',?,?,0,?,?,?,?)`, id, name, "ATV-" + index, f.admin.id, f.admin.id, AT, AT);
      for (const [n, action] of ["create", "archive"].entries()) {
        sql.exec(`INSERT INTO erp_catalog__audit(id,actor,command_id,entity,record_id,action,before_data,after_data,created_at)
          VALUES(?,?,?,'contacts',?,?,?,?,?)`, index * 2 + n + 1, f.admin.id, crypto.randomUUID(), id, action,
          n ? JSON.stringify({ name, active: true }) : null, JSON.stringify({ name, active: !n }), String(BigInt(AT) + BigInt(index * 2 + n)));
      }
    }
  });
  return { f, get, seed };
}

describe("Auditoria comercial: atividades e exclusões", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-19T12:00:00Z")); });
  afterEach(() => vi.useRealTimers());

  it("as 36 fontes compilam no SqlStorage real, com o erro SQL exposto na asserção", async () => {
    const { f, get } = await setup();
    const opened = await get("/erp/v1/me");
    expect(opened.status, JSON.stringify(opened)).toBe(200);
    const result = await runInDurableObject(erpStub(env, f.profile), (_instance: any, state: DurableObjectState) => {
      try {
        return { rows: state.storage.sql.exec(ENTRIES_SQL, ...entriesBindings(AT, String(BigInt(AT) + 86_400_000_000n))).toArray(), error: null };
      } catch (error) {
        return { rows: null, error: String(error) };
      }
    });
    expect(result, JSON.stringify(result)).toEqual({ rows: [], error: null });
  });

  for (const [screen, suffix] of screens) {
    it(`${screen}: administrador abre e recebe o contrato; uma ida ao motor`, async () => {
      const { get } = await setup();
      const result = await get("/erp/v1/registro-atividades?" + PERIOD + suffix);
      expect(result.status, JSON.stringify(result)).toBe(200);
      expect(result.body).toMatchObject({ scope: "activity", data_mode: "erp_native", from: "2026-11-01", to: "2026-11-19", operation: suffix ? "exclusao" : null, total: 0, has_more: false, items: [] });
      expect(result.timing).toContain('erp;desc="hops=1"');
      expect(result.timing).toContain('desc="erp_activity_list"');
      // Leitura secundária do filtro Usuário, usada apenas em Registro de atividades.
      if (!suffix) expect((await get("/people")).status).toBe(200);
    });

    it(`${screen}: pessoa sem papel e pessoa com Consulta são recusadas`, async () => {
      const { f, get } = await setup();
      const member = await bearer(f.member);
      const denied = await get("/erp/v1/registro-atividades?" + PERIOD + suffix, member);
      expect(denied.status, JSON.stringify(denied)).toBe(403);
      await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(["erp:consulta"]), f.member.id);
      for (const path of ["/erp/v1/registro-atividades?" + PERIOD + suffix, "/erp/v1/registro-atividades/detalhe?origem=catalog&id=1"]) {
        const response = await get(path, member);
        expect(response.status, JSON.stringify(response)).toBe(403);
      }
    });

    it(`${screen}: Base desligada recusa a lista e o detalhe com module_disabled`, async () => {
      const { f, get } = await setup();
      await setModule(f.profile, "erp", false, f.admin.id);
      for (const path of ["/erp/v1/registro-atividades?" + PERIOD + suffix, "/erp/v1/registro-atividades/detalhe?origem=catalog&id=1"]) {
        const response = await get(path);
        expect(response.status, JSON.stringify(response)).toBe(409);
        expect(response.body.error.code).toBe("module_disabled");
      }
    });

    it(`${screen}: filtra, pagina e abre o detalhe auditado`, async () => {
      const { f, get, seed } = await setup();
      const opened = await get("/erp/v1/registro-atividades?" + PERIOD + suffix);
      expect(opened.status, JSON.stringify(opened)).toBe(200);
      await seed();
      const query = "/erp/v1/registro-atividades?" + PERIOD + suffix + "&modulo=clientes_fornecedores&usuario=" + f.admin.id + "&q=a%C3%A7%C3%A3o&limit=1";
      const first = await get(query);
      expect(first.status, JSON.stringify(first)).toBe(200);
      expect(first.body).toMatchObject({ total: suffix ? 2 : 4, has_more: true, offset: 0 });
      expect(first.body.items[0]).toMatchObject({ id: "4", source: "catalog", module: "clientes_fornecedores", operation: "exclusao" });
      const next = await get(query + "&offset=1");
      expect(next.status, JSON.stringify(next)).toBe(200);
      expect(next.body.items[0].id).toBe(suffix ? "2" : "3");
      const detail = await get("/erp/v1/registro-atividades/detalhe?origem=catalog&id=4");
      expect(detail.status, JSON.stringify(detail)).toBe(200);
      expect(detail.body).toMatchObject({ scope: "activity_detail", available: true, truncated: false, before: { active: true }, after: { active: false } });
    });
  }
});
