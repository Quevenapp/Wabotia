// Cobrança e retornos pela rota pública real (Worker → erp-api → Coordinator
// → R2). O preparo cadastral usa o motor; todas as ações de cobrança usam HTTP.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storageDriver } from "../src/erp/engine/driver";
import { callRpc } from "../src/erp/engine/registry";
import "../src/erp/domains/index";
import { erpStub } from "../src/erp/hub";
import { bearer, fixture } from "./service-center-fixture";
import { enableErpParts, setModule } from "./erp-module-helper";
import { CNPJ, PROFILES, returnFile } from "./erp/cnab/cnab-core-fixtures.mjs";
import { v2Page, v2Profiles } from "../web/erp/app/lib/cnab-operational-v2-model";
import { operationalProfiles } from "../web/erp/app/lib/cnab-operational-model";
import { returnFiles } from "../web/erp/app/lib/cnab-returns-model";

const DAY = "2026-11-19";
const ENCODING = "itau109-no-charges-v1";
const OPEN = [
  "/v1/cobranca-operacional-v2/profiles",
  "/v1/cobranca-operacional-v2/remittances?limit=25",
  "/v1/cnab",
  "/v1/cobranca-operacional/profiles",
  "/v1/retornos-operacionais/files?limit=25",
];
const ROOTS = ["/v1/cobranca-operacional", "/v1/cobranca-operacional-v2", "/v1/retornos-operacionais"];

async function setup() {
  const f = await fixture();
  await enableErpParts(f.profile, f.admin.id);
  await setModule(f.profile, "erp-cobranca", true, f.admin.id);
  const token = await bearer(f.admin);
  const call = (path: string, body?: unknown, auth = token) => SELF.fetch(
    `https://test/api/v1/profiles/${f.profile}/erp${path}`,
    { method: body === undefined ? "GET" : "POST", headers: {
      Authorization: "Bearer " + auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    }, body: body === undefined ? undefined : JSON.stringify(body) },
  );
  const json = async (path: string, body?: unknown) => {
    const response = await call(path, body), value = await response.json<any>();
    expect(response.status, `${path}: ${JSON.stringify(value)}`).toBe(200);
    return value;
  };
  return { f, call, json };
}

async function seed(profile: string, actor: string) {
  return runInDurableObject(erpStub(env, profile), (_instance: unknown, state: DurableObjectState) => {
    const db = storageDriver(state.storage);
    const rpc = (name: string, args: Record<string, unknown>) => callRpc(db, name, { p_user_id: actor, ...args }) as any;
    const identity = rpc("erp_company_save_identity", {
      p_expected_version: 0, p_command_id: crypto.randomUUID(), p_data: {
        legal_name: "EMPRESA FICTICIA TESTE", trade_name: null, cnpj: CNPJ, ie: null, postal_code: "13400-000",
        street: "Rua fictícia", number: "100", complement: null, district: "Centro", city: "Piracicaba",
        municipality_code: "3538709", state: "sp", phone: "+55 (19) 99999-0000", email: "empresa@example.invalid",
      },
    }).record;
    const contact = rpc("erp_catalog_save", {
      p_entity: "contacts", p_id: null, p_expected_version: 0, p_command_id: crypto.randomUUID(), p_data: {
        name: "PAGADOR FICTICIO", person_type: "F", document: "12345678909", postal_code: "13400000",
        street: "RUA FICTICIA", number: "100", district: "CENTRO", city: "PIRACICABA", state: "SP",
      },
    }).record;
    const account = rpc("erp_finance_account_execute", { p_command_id: crypto.randomUUID(), p_action: "account_create", p_data: {
      account_type: "checking", institution_code: "341", institution_name: "Itaú Unibanco", name: "CONTA SINTÉTICA",
      agency: "1", account_number: "2", account_digit: "3", start_on: "2020-01-01", opening_cents: "0",
    } }).record;
    const { accountId: _unused, ...bank } = PROFILES.itau;
    const p = rpc("erp_cnab_profile_save", { p_id: null, p_expected_version: 0, p_command_id: crypto.randomUUID(), p_data: {
      ...bank, account_id: account.id, remittanceSequenceStart: "1", ourNumberStart: "00000001",
    } }).profile;
    const title = rpc("erp_finance_title_execute", { p_command_id: crypto.randomUUID(), p_action: "title_create", p_data: {
      kind: "receivable", contact_id: contact.id, description: "TÍTULO SINTÉTICO", issued_on: DAY, competence_on: DAY,
      total_cents: "12345", installments: [{ amount_cents: "12345", due_on: DAY }],
    } }).items[0];
    return { identity, profile: p, title };
  });
}

describe("cobrança operacional e retornos liberados no painel", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(`${DAY}T15:00:00Z`)); });
  afterEach(() => vi.useRealTimers());

  it("abre as duas telas como administrador, valida o corpo e mede as consultas de abertura", async () => {
    const { call } = await setup();
    const values = [];
    for (const path of OPEN) {
      const response = await call(path), body = await response.json<any>();
      expect(response.status, `${path}: ${JSON.stringify(body)}`).toBe(200);
      expect(response.headers.get("Server-Timing"), path).toContain('hops=1');
      values.push(body);
    }
    expect(v2Profiles(values[0])).toEqual([]);
    expect(v2Page(values[1]).items).toEqual([]);
    expect(values[2]).toMatchObject({ read: true, write: true, configure: true });
    expect(operationalProfiles(values[3])).toEqual([]);
    expect(returnFiles(values[4], 25, null).items).toEqual([]);
    // Cobrança: 2 GET / 2 RPC; Retornos: 3 GET / 3 RPC, além da barra comum.
    for (const path of ROOTS) {
      const response = await call(path), body = await response.json<any>();
      expect(response.status, `${path}: ${JSON.stringify(body)}`).toBe(200);
      expect(body).toMatchObject({ purpose: "operational", items: [], limit: 25, has_more: false, next_cursor: null });
    }
  }, 120_000);

  it("recusa ambas as telas sem papel e com Cobrança desligada", async () => {
    const { f, call } = await setup(), member = await bearer(f.member);
    for (const path of [...ROOTS, ...OPEN]) {
      const response = await call(path, undefined, member);
      expect(response.status, path).toBe(403);
      expect((await response.json<any>()).error.code, path).toBe("erp_role_required");
    }
    await setModule(f.profile, "erp-cobranca", false, f.admin.id);
    for (const path of [...ROOTS, ...OPEN]) {
      const response = await call(path);
      expect(response.status, path).toBe(409);
      expect((await response.json<any>()).error.code, path).toBe("module_disabled");
    }
  }, 120_000);

  it("aprova, pré-visualiza, gera, baixa, importa e confere retorno pela rota real", async () => {
    const { f, call, json } = await setup();
    await json("/v1/cnab"); // Inicializa o objeto e projeta a identidade.
    const data = await seed(f.profile, f.admin.id), p = data.profile;
    const approved = await json(`/v1/cobranca-operacional-v2/profiles/${p.id}/approval`, {
      command_id: crypto.randomUUID(), expected_approval_version: 0, expected_profile_version: p.version,
      expected_identity_version: data.identity.version, enabled: true, confirmed_on: DAY, reference: "TESTE SINTÉTICO",
      allowed_encoding_profiles: [ENCODING], compatibility_confirmed: false, permanent_instructions_acknowledged: false,
    });
    expect(approved.approval.effective_enabled).toBe(true);
    const command = {
      command_id: crypto.randomUUID(), profile_id: p.id, expected_version: p.version, expected_approval_version: 1,
      generated_on: DAY, titles: [{ title_id: data.title.id, expected_version: data.title.version, document_number: "TESTE001" }],
      confirm_operational: false, encoding_profile: ENCODING, confirm_encoding_profile: false, zero_daily_title_ids: [],
    };
    const preview = await json("/v1/cobranca-operacional-v2/remittances/preview", command);
    expect(preview).toMatchObject({ preview: true, persisted: false, titles: 1, total_cents: "12345", can_reserve: true });
    const ack = await json("/v1/cobranca-operacional-v2/remittances", {
      ...command, preview_hash: preview.preview_hash, confirm_operational: true, confirm_encoding_profile: true,
    });
    expect(ack).toMatchObject({ state: "ready", bankTransmissionPerformed: false, financialMutationPerformed: false });
    const remittance = await call(`/v1/cobranca-operacional-v2/files/remittance/${ack.id}`);
    expect(remittance.status).toBe(200);
    expect((await remittance.arrayBuffer()).byteLength).toBe(ack.byte_size);
    expect((await json(`/v1/cobranca-operacional-v2/commands/${command.command_id}`)).current.state).toBe("ready");
    const snapshot = await runInDurableObject(erpStub(env, f.profile), (_instance: unknown, state: DurableObjectState) => {
      const row = state.storage.sql.exec<{ snapshot: string }>('SELECT snapshot FROM "erp_cnab__remittance" WHERE id=?', ack.id).one();
      return JSON.parse(row.snapshot);
    });
    const title = snapshot.titles[0], bytes = returnFile({ bank: "341", profile: snapshot.profile, generatedDate: "191126", fileSequence: "00001", events: [{
      control: title.control, documentNumber: title.documentNumber, ourNumber: title.ourNumber,
      amount: "12345", paid: "12345", dueDate: "191126", occurrenceDate: "191126", creditDate: "191126",
    }] });
    const imported = await json("/v1/retornos-operacionais/files", {
      command_id: crypto.randomUUID(), profile_id: p.id, expected_approval_version: 1,
      file_base64: btoa(String.fromCharCode(...bytes)), obtained_from_bank: true, reference_id: "TESTE_SINTETICO",
    });
    expect(imported).toMatchObject({ new_events: 1, financialMutationPerformed: false });
    const events = await json(`/v1/retornos-operacionais/files/${imported.id}/events?limit=25`), event = events.items[0];
    const detail = await json(`/v1/retornos-operacionais/events/${event.event_id}?file_id=${imported.id}&line=${event.line}`);
    expect(detail.context.event.amount_cents).toBe("12345");
    const checked = await json(`/v1/retornos-operacionais/events/${event.event_id}/preview`, { file_id: imported.id, line: event.line });
    expect(checked).toMatchObject({ bytes_verified: true, financialMutationPerformed: false });
    expect(checked.context.settlement.allowed).toBe(true);
    const downloaded = await call(`/v1/retornos-operacionais/files/${imported.id}/download`);
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
  }, 120_000);
});
