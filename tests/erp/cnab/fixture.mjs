// Fixture do CNAB na fixture dupla. As escritas do CNAB ainda nÃ£o portadas
// (perfil, aprovaÃ§Ã£o, reserva) rodam no Postgres e sÃ£o espelhadas no SQLite
// (f.rpc com RPC nÃ£o portado); as leituras portadas rodam nos dois motores.
// Dados sintÃ©ticos, como os do Fagoo (packages/cnab-core/test/fixtures.mjs).
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { executeCnabRoute, parseCnabRoute } from "../../../src/erp/fagoo/workers/erp-api/src/cnab.mjs";
import { PROFILES, returnFile } from "./cnab-core-fixtures.mjs";

const cnpjDigits = (base) => {
  const digit = (s) => {
    let w = s.length - 7;
    let sum = 0;
    for (const c of s) {
      sum += Number(c) * w--;
      if (w < 2) w = 9;
    }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = digit(base);
  return `${d1}${digit(base + d1)}`;
};
export const CNPJ = "990000000001" + cnpjDigits("990000000001");
const mod10 = (s) => {
  let sum = 0;
  [...s].reverse().forEach((c, i) => {
    const n = Number(c) * (i % 2 === 0 ? 2 : 1);
    sum += Math.floor(n / 10) + (n % 10);
  });
  return (10 - (sum % 10)) % 10;
};
export const OBSERVED = "itau109-origin-observed-v1";
export const LEGACY = "itau109-no-charges-v1";

export async function cnabFixture() {
  const f = await dualFixture();
  const today = await f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v");
  let ordinal = 0;
  // Identidade da empresa com o CNPJ do beneficiário (a aprovação operacional a confere).
  const identity = (
    await f.rpc("erp_company_save_identity", {
      p_user_id: f.users.admin,
      p_expected_version: 0,
      p_command_id: randomUUID(),
      p_data: {
        legal_name: "EMPRESA FICTICIA TESTE", trade_name: null, cnpj: CNPJ, ie: null, postal_code: "13400-000", street: "Rua fictícia", number: "S/N",
        complement: null, district: "Centro fictício", city: "Piracicaba", municipality_code: "3538709", state: "sp", phone: "+55 (19) 99999-0000",
        email: "empresa@example.invalid",
      },
      p_reason: null,
    })
  ).record;
  const contact = await f.catalog("contacts", {
    name: "PAGADOR FICTICIO TESTE",
    person_type: "F",
    document: "12345678909",
    postal_code: "13400000",
    street: "RUA FICTICIA",
    number: "100",
    district: "TESTE",
    city: "PIRACICABA",
    state: "SP",
  });
  async function account(name = `CONTA SINTETICA ${++ordinal}`) {
    return (
      await f.rpc("erp_finance_account_execute", {
        p_user_id: f.users.financeiro,
        p_command_id: randomUUID(),
        p_action: "account_create",
        p_data: { account_type: "checking", institution_code: "341", institution_name: "ItaÃº Unibanco", name, agency: "1", account_number: "2", account_digit: "3", start_on: "2020-01-01", opening_cents: "0" },
      })
    ).record;
  }
  /** erp_cnab_profile_save (homologaÃ§Ã£o; o perfil serve aos dois propÃ³sitos). */
  async function profile({ bank = "341", simple = true } = {}) {
    const a = await account();
    const n = ++ordinal;
    const data =
      bank === "341"
        ? { bank: "341", layout: "itau-cnab400-2017-01", agency: "0057", account: String(30000 + n), accountDigit: String(mod10("0057" + String(30000 + n))), wallet: "109", ourNumberStart: "00000001" }
        : { bank: "077", layout: "inter-cnab400-v2.2-2024-08-26", agency: "0001", account: String(200000 + n).padStart(9, "0"), accountDigit: "7", wallet: "112", ourNumberStart: null };
    const full = {
      ...data,
      cnpj: CNPJ,
      companyName: "EMPRESA FICTICIA TESTE",
      contractVerified: true,
      agreementReference: "SYNTHETIC-TEST-ONLY",
      simpleCollectionPolicyVerified: simple,
      account_id: a.id,
      remittanceSequenceStart: "1",
    };
    const saved = await f.rpc("erp_cnab_profile_save", { p_user_id: f.users.admin, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: full });
    return { ...saved.profile, data: full };
  }
  const profilesV2 = async () => (await f.rpc("erp_cnab_operational_profiles_v2", { p_user_id: f.users.admin })).items;
  async function approveV2(p, allowed = [OBSERVED], overrides = {}) {
    const s = (await profilesV2()).find((x) => x.profile.id === p.id);
    return f.rpc("erp_cnab_operational_approve_v2", {
      p_user_id: f.users.admin,
      p_profile_id: p.id,
      p_command_id: randomUUID(),
      p_expected_approval: s.approval.approval_version,
      p_expected_profile: s.profile.version,
      p_expected_identity: identity.version,
      p_enabled: allowed.length > 0,
      p_confirmed_on: today,
      p_reference: "SYNTHETIC HISTORICAL DECLARATION",
      p_allowed_encoding_profiles: allowed,
      p_compatibility_confirmed: allowed.includes(OBSERVED),
      p_permanent_instructions_acknowledged: allowed.includes(OBSERVED),
      ...overrides,
    });
  }
  async function title(amount = "12345", due = today) {
    return (
      await f.rpc("erp_finance_title_execute", {
        p_user_id: f.users.financeiro,
        p_command_id: randomUUID(),
        p_action: "title_create",
        p_data: { kind: "receivable", contact_id: contact.id, description: `TITULO SINTETICO ${++ordinal}`, issued_on: today, competence_on: today, total_cents: amount, installments: [{ amount_cents: amount, due_on: due }] },
      })
    ).items[0];
  }
  async function selection(p, titles, encoding = OBSERVED) {
    const s = (await profilesV2()).find((x) => x.profile.id === p.id);
    return {
      p_user_id: f.users.financeiro,
      p_command_id: randomUUID(),
      p_profile_id: p.id,
      p_expected_version: s.profile.version,
      p_expected_approval: s.approval.approval_version,
      p_generated_on: today,
      p_titles: titles.map((t) => ({ title_id: t.id, expected_version: t.version, document_number: "V" + String(++ordinal).padStart(8, "0") })),
      p_confirm_operational: false,
      p_preview: true,
      p_preview_hash: null,
      p_encoding_profile: encoding,
      p_confirm_encoding_profile: false,
      p_zero_daily_title_ids: [],
    };
  }
  /** Reserva operacional v2 (prÃ©via e reserva), no Postgres. */
  async function reserveV2(args) {
    const preview = await f.rpc("erp_cnab_operational_reserve_v2", args);
    return f.rpc("erp_cnab_operational_reserve_v2", { ...args, p_preview: false, p_preview_hash: preview.preview_hash, p_confirm_operational: true, p_confirm_encoding_profile: true });
  }
  // Rotas do Fagoo (workers/erp-api/src/cnab.mjs) com os RPCs da fixture dupla:
  // a homologação gera a remessa (cnab-core) e importa o retorno pelo app, como no Fagoo.
  // O bucket abaixo é o que o SQL do oráculo confere (erp_cnab.storage_check); no
  // Wabotia os arquivos vão para o MEDIA da instalação, com prefixo do ERP (C2).
  await f.db.query(
    "insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('brufap-cnab','brufap-cnab',false,4020000,$1) on conflict do nothing",
    [["application/octet-stream"]],
  );
  const files = new Map();
  const ports = (userId) => ({
    userId,
    rpc: (name, args) => f.rpc(name, { p_user_id: userId, ...args }),
    storeFile: async ({ bucket, path, bytes }) => {
      if (files.has(`${bucket}/${path}`)) return;
      files.set(`${bucket}/${path}`, bytes.slice());
      await f.putObject(bucket, path, bytes.length, "application/octet-stream");
    },
    getFile: async ({ bucket, path }) => files.get(`${bucket}/${path}`)?.slice() ?? new Response(null, { status: 404 }),
  });
  async function app(path, body, user = f.users.financeiro) {
    const request = new Request("https://test.invalid/v1/cnab" + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    return (await executeCnabRoute(await parseCnabRoute(request), ports(user))).body;
  }
  /** Remessa de homologação gerada e finalizada pelo app (estado ready). */
  async function homologationRemittance(p, titles) {
    const current = (await f.rpc("erp_cnab_profiles", { p_user_id: f.users.admin })).items.find((x) => x.id === p.id);
    return app("/remittances", {
      profile_id: p.id,
      expected_version: current.version,
      command_id: randomUUID(),
      generated_on: today,
      titles: titles.map((t) => ({ title_id: t.id, expected_version: t.version, document_number: "D" + String(++ordinal).padStart(8, "0") })),
    });
  }
  const ddmmyy = (d) => d.slice(8, 10) + d.slice(5, 7) + d.slice(2, 4);
  /** Retorno de homologação importado pelo app; events: os campos de returnFile (cnab-core). */
  async function homologationReturn(p, events, { sequence = "00001", obtained = true } = {}) {
    const bytes = returnFile({ bank: "341", profile: { ...PROFILES.itau, ...p.data }, generatedDate: ddmmyy(today), fileSequence: sequence, events });
    return app("/returns", {
      profile_id: p.id,
      command_id: randomUUID(),
      file_base64: Buffer.from(bytes).toString("base64"),
      ...(obtained ? { obtained_from_bank: true, reference_id: "SYNTHETIC_DOWNLOAD" } : {}),
    });
  }
  return { ...f, today, ddmmyy, contact, identity, account, profile, profilesV2, approveV2, title, selection, reserveV2, app, homologationRemittance, homologationReturn };
}
