// CNAB, bloco C3: a prévia de impressão do boleto Itaú 109 (migrações 066 e
// 067, versões finais no oráculo). public.erp_cnab_itau_boleto_context e
// _itau_boleto_items. Só leitura: nada paga, emite nem transmite.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { uuid } from "../args.ts";
import { CNAB_BUCKET, cnabObjectKey, storageCheck } from "../commands.ts";
import {
  access,
  coreProfile,
  encodingSnapshotCheck,
  get,
  operationalSnapshotCheck,
  parse,
  profileRow,
  REMITTANCE_COLUMNS,
  requireOperational,
  requireOperationalForEncoding,
  sha256,
  toRemittance,
  txt,
  type Json,
} from "../core.ts";

const ENCODINGS = ["itau109-no-charges-v1", "itau109-origin-observed-v1"];
const hasKey = (o: unknown, k: string) => jsonType(o) === "object" && Object.prototype.hasOwnProperty.call(o, k);
/** a IS DISTINCT FROM b entre jsonb (undefined: chave ausente, NULL). */
const distinct = (a: unknown, b: unknown) => (a === undefined || b === undefined ? a !== b : jsonbText(a) !== jsonbText(b));
const field = (o: unknown, k: string) => (hasKey(o, k) ? (o as Json)[k] : undefined);
const itau109 = (identity: unknown) =>
  txt(identity, "bank") === "341" && txt(identity, "wallet") === "109" && txt(identity, "layout") === "itau-cnab400-2017-01";

function remittanceRow(db: SqlDriver, where: string, ...args: unknown[]) {
  const row = one(db, `SELECT ${REMITTANCE_COLUMNS}, manifest FROM "erp_cnab__remittance" WHERE ${where}`, ...args);
  return row ? { r: toRemittance(row), manifest: parse(row.manifest) } : null;
}

export function erpCnabItauBoletoContext(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  access(db, uuid(a, "p_user_id"));
  const id = uuid(a, "p_billing_title_id");
  if (id === null) raise("22023", "erp_boleto_preview_id_required");
  const b = one(db, 'SELECT id, title_id, profile_id, remittance_id, control, document_number, our_number_base, our_number, snapshot FROM "erp_cnab__billing_title" WHERE id=?', id);
  if (!b) raise("P0002", "erp_boleto_preview_not_found");
  const bs = parse(b!.snapshot) as Json;
  const found = remittanceRow(db, "id=? AND profile_id=?", b!.remittance_id, b!.profile_id);
  const p = profileRow(db, b!.profile_id);
  if (!found || !p || found.r.state !== "ready") raise("40001", "erp_boleto_preview_remittance_not_ready");
  const { r, manifest } = found!;
  const v2 = hasKey(r.snapshot, "encoding_profile");
  const encoding = txt(r.snapshot, "encoding_profile");
  if (v2 && (r.purpose !== "operational" || encoding === null || !ENCODINGS.includes(encoding))) raise("0A000", "erp_boleto_preview_encoding_unsupported");
  if (!itau109(p!.identity)) raise("0A000", "erp_boleto_preview_profile_unsupported");
  if (
    !["homologation", "operational"].includes(r.purpose) ||
    txt(r.snapshot, "purpose") !== r.purpose ||
    distinct(field(r.snapshot, "profile"), coreProfile(db, p!.id)) ||
    txt(r.snapshot, "generatedOn") !== r.generated_on ||
    txt(r.snapshot, "remittanceSequence") !== r.sequence ||
    get(p!.settings, "contractVerified") !== true ||
    (!v2 && get(p!.settings, "simpleCollectionPolicyVerified") !== true) ||
    !one(db, `SELECT 1 x FROM "erp_finance__account" WHERE id=? AND active=1 AND kind='bank'`, p!.account_id)
  )
    raise("40001", "erp_boleto_preview_profile_changed");
  let approval: { approval_version: number } | null = null;
  if (r.purpose === "operational") {
    if (v2) {
      approval = requireOperationalForEncoding(db, p!.id, null, encoding);
      encodingSnapshotCheck(db, r.id);
    } else {
      approval = requireOperational(db, p!.id, null);
      operationalSnapshotCheck(db, r.id);
    }
  }
  storageCheck(ctx, r.profile_id, "remittances", r.file_hash, r.byte_size, r.object_path);
  const titles = get(r.snapshot, "titles");
  if (
    jsonType(titles) !== "array" ||
    (titles as unknown[]).length < 1 ||
    (titles as unknown[]).length > 30 ||
    jsonType(manifest) !== "array" ||
    (manifest as unknown[]).length !== (titles as unknown[]).length
  )
    raise("40001", "erp_boleto_preview_snapshot_invalid");
  const selectedTitles = (titles as unknown[]).filter((x) => txt(x, "id") === b!.id);
  if (selectedTitles.length !== 1) raise("40001", "erp_boleto_preview_title_binding_invalid");
  const selectedManifests = (manifest as unknown[]).filter((x) => txt(x, "titleId") === b!.id);
  if (selectedManifests.length !== 1) raise("40001", "erp_boleto_preview_manifest_invalid");
  const st = selectedTitles[0];
  const sm = selectedManifests[0];
  const base = b!.our_number_base as string | null;
  const our = b!.our_number as string | null;
  if (
    distinct(st, field(bs, "title")) ||
    txt(bs, "finance_title_id") !== b!.title_id ||
    txt(st, "control") !== b!.control ||
    txt(st, "documentNumber") !== b!.document_number ||
    txt(st, "ourNumber") !== base ||
    base === null ||
    !/^[0-9]{8}$/.test(base) ||
    base === "00000000" ||
    our === null ||
    !/^[0-9]{9}$/.test(our) ||
    our.slice(0, 8) !== base ||
    txt(sm, "control") !== b!.control ||
    txt(sm, "documentNumber") !== b!.document_number ||
    txt(sm, "ourNumber") !== our ||
    txt(sm, "amountCents") !== txt(st, "amountCents") ||
    txt(sm, "dueDate") !== txt(st, "dueOn") ||
    (v2 && distinct(field(sm, "encodingTerms"), field(st, "encodingTerms")))
  )
    raise("40001", "erp_boleto_preview_snapshot_binding_invalid");
  // O código de barras (44) tem dez posições de valor, embora o detalhe do CNAB tenha treze.
  if (
    jsonType(field(st, "amountCents")) !== "string" ||
    !/^[1-9][0-9]{0,9}$/.test(txt(st, "amountCents")!) ||
    !/^[A-Za-z0-9./-]{1,10}$/.test(String(b!.document_number)) ||
    (titles as unknown[]).some((x) => hasKey(x, "collectionTerms"))
  )
    raise("0A000", "erp_boleto_preview_print_profile_unsupported");
  const t = one(
    db,
    `SELECT id, version, kind, cancelled, CAST(settled_cents AS TEXT) settled, CAST(amount_cents AS TEXT) amount, issued_on, due_on, contact_id FROM "erp_finance__title" WHERE id=?`,
    b!.title_id,
  );
  const c = t ? one(db, 'SELECT id, version, active FROM "erp_catalog__record" WHERE id=?', t.contact_id) : undefined;
  if (
    !t ||
    !c ||
    Number(c.active) !== 1 ||
    t.kind !== "receivable" ||
    Number(t.cancelled) === 1 ||
    BigInt(String(t.settled)) !== 0n ||
    txt(bs, "finance_title_version") !== String(t.version) ||
    txt(bs, "contact_version") !== String(c.version) ||
    txt(st, "amountCents") !== String(t.amount) ||
    txt(st, "issuedOn") !== String(t.issued_on) ||
    txt(st, "dueOn") !== String(t.due_on)
  )
    raise("40001", "erp_boleto_preview_native_context_changed");
  const company = one(db, 'SELECT version, data FROM "erp_company__identity" WHERE singleton=1');
  const data = company ? parse(company.data) : null;
  if (!company || txt(data, "cnpj") !== txt(p!.identity, "cnpj")) raise("40001", "erp_boleto_preview_beneficiary_identity_mismatch");
  const nonEmpty = (v: string | null) => (v === null || v === "" ? null : v);
  // O endereço não foi capturado na remessa: vem da identidade atual da empresa, e a resposta diz isso.
  const result: Json = {
    profile: v2 ? "itau109-persisted-print-preview-v2" : "itau109-persisted-print-preview-v1",
    private_context: true,
    billing_title_id: b!.id,
    remittance_id: r.id,
    profile_id: p!.id,
    finance_title_id: t!.id,
    source_purpose: r.purpose,
    state: "ready",
    snapshot: r.snapshot,
    billing_snapshot: bs,
    manifest,
    our_number: our,
    snapshot_hash: sha256(r.snapshot),
    file: { bucket: CNAB_BUCKET, path: r.object_path, hash: r.file_hash, size: r.byte_size },
    beneficiary: {
      identity_version: Number(company!.version),
      cnpj: txt(data, "cnpj"),
      address_source: "company_identity_current",
      address: {
        address: [nonEmpty(txt(data, "street")), nonEmpty(txt(data, "number")), nonEmpty(txt(data, "complement"))].filter((x) => x !== null).join(" "),
        neighborhood: txt(data, "district"),
        city: txt(data, "city"),
        state: txt(data, "state"),
        postalCode: txt(data, "postal_code"),
      },
    },
    current: {
      title_version: Number(t!.version),
      contact_version: Number(c!.version),
      profile_version: p!.version,
      approval_version: approval ? approval.approval_version : null,
      company_identity_version: Number(company!.version),
      title_status: "open",
      title_cancelled: false,
      settled_cents: "0",
    },
    read_only: true,
    can_pay: false,
    can_issue: false,
    can_transmit: false,
    financial_mutation_performed: false,
  };
  return { ...result, context_hash: sha256(result) };
}

export function erpCnabItauBoletoItems(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  access(db, uuid(a, "p_user_id"));
  const id = uuid(a, "p_remittance_id");
  if (id === null) raise("22023", "erp_boleto_preview_id_required");
  const found = remittanceRow(db, "id=?", id);
  if (!found) raise("P0002", "erp_boleto_preview_not_found");
  const { r } = found!;
  const p = profileRow(db, r.profile_id);
  if (r.state !== "ready" || r.file_hash === null || !/^[a-f0-9]{64}$/.test(r.file_hash)) raise("40001", "erp_boleto_preview_remittance_not_ready");
  if (!itau109(p?.identity ?? null)) raise("0A000", "erp_boleto_preview_profile_unsupported");
  const rows = db
    .exec('SELECT id, title_id, profile_id, document_number, snapshot FROM "erp_cnab__billing_title" WHERE remittance_id=? ORDER BY id', r.id)
    .rows.map((b) => ({
      id: String(b.id),
      title_id: String(b.title_id),
      profile_id: String(b.profile_id),
      document_number: String(b.document_number),
      snapshot: parse(b.snapshot),
    }));
  const titles = get(r.snapshot, "titles");
  if (
    rows.length < 1 ||
    rows.length > 30 ||
    jsonType(titles) !== "array" ||
    rows.length !== (titles as unknown[]).length ||
    rows.some(
      (b) =>
        b.profile_id !== r.profile_id ||
        txt(b.snapshot, "title", "id") !== b.id ||
        txt(b.snapshot, "finance_title_id") !== b.title_id ||
        txt(b.snapshot, "title", "documentNumber") !== b.document_number ||
        jsonType(get(b.snapshot, "title", "amountCents")) !== "string" ||
        !/^[1-9][0-9]{0,12}$/.test(txt(b.snapshot, "title", "amountCents")!) ||
        jsonType(get(b.snapshot, "title", "dueOn")) !== "string",
    )
  )
    raise("40001", "erp_boleto_preview_snapshot_binding_invalid");
  return {
    data_mode: "itau_boleto_items_readonly",
    read_only: true,
    can_pay: false,
    remittance_id: r.id,
    profile_id: p!.id,
    source_purpose: r.purpose,
    state: "ready",
    remittance_hash: r.file_hash,
    items: rows.map((b) => ({
      billing_title_id: b.id,
      finance_title_id: b.title_id,
      document_number: b.document_number,
      amount_cents: txt(b.snapshot, "title", "amountCents"),
      due_on: txt(b.snapshot, "title", "dueOn"),
    })),
  };
}

/** O arquivo que a prévia confere: o caminho da remessa do título (lido antes da transação). */
const contextObjects = (a: RpcArgs, db?: SqlDriver) => {
  if (!db) return [];
  try {
    const r = one(
      db,
      'SELECT r.object_path FROM "erp_cnab__billing_title" b JOIN "erp_cnab__remittance" r ON r.id=b.remittance_id AND r.profile_id=b.profile_id WHERE b.id=?',
      uuid(a, "p_billing_title_id"),
    );
    return r?.object_path ? [cnabObjectKey(String(r.object_path))] : [];
  } catch {
    return [];
  }
};

registerRpc("erp_cnab_itau_boleto_context", erpCnabItauBoletoContext, { objects: contextObjects });
registerRpc("erp_cnab_itau_boleto_items", erpCnabItauBoletoItems);
