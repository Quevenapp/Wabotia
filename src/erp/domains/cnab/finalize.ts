// O corpo comum de erp_cnab_finalize (homologação), _operational_finalize
// (v1) e _operational_finalize_v2 (migrações 014, 042 e 067): perfil
// confirmado, conta bancária ativa, retrato dos títulos ainda válido e o
// manifesto do arquivo gerado (cnab-core) contra os títulos da remessa, que
// grava o nosso número com o dígito.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText, jsonType } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { keys, uuidValue } from "../finance/public.ts";
import { guardModuleBilling } from "./reserve.ts";
import { encodingTerms, get, parse, profileRow, txt, type Json, type Remittance } from "./core.ts";

const OBSERVED = "itau109-origin-observed-v1";
const NO_CHARGES = "itau109-no-charges-v1";

/** Confirmações do perfil para gerar o arquivo. `simple`: exige a política de cobrança simples. */
export function requireConfirmed(p: NonNullable<ReturnType<typeof profileRow>>, simple = true) {
  if (
    get(p.settings, "contractVerified") !== true ||
    (simple && get(p.settings, "simpleCollectionPolicyVerified") !== true) ||
    (txt(p.identity, "bank") === "077" && txt(p.identity, "wallet") === "110" && get(p.settings, "reservedRange", "verified") !== true)
  )
    raise("40001", "erp_cnab_profile_unconfirmed");
}

/** Títulos e contatos da remessa mudaram desde a reserva? (erp_cnab_snapshot_stale) */
export const snapshotStale = (db: SqlDriver, remittance: string) =>
  !!one(
    db,
    `SELECT 1 x FROM "erp_cnab__billing_title" bt JOIN "erp_finance__title" t ON t.id=bt.title_id JOIN "erp_catalog__record" c ON c.id=t.contact_id
     WHERE bt.remittance_id=? AND (t.version<>CAST(json_extract(bt.snapshot,'$.finance_title_version') AS INTEGER) OR t.cancelled=1 OR t.settled_cents<>0
       OR c.version<>CAST(json_extract(bt.snapshot,'$.contact_version') AS INTEGER) OR c.active=0)`,
    remittance,
  );

/** erp_cnab.itau_number(profile, base): o nosso número com o dígito (módulo 10 sobre agência, conta, carteira e base). */
export function itauNumber(profile: unknown, base: string | null): string | null {
  const parts = [txt(profile, "agency"), txt(profile, "account"), txt(profile, "wallet"), base];
  const value = parts.some((x) => x === null) ? null : parts.join("");
  if (value === null || !/^[0-9]{20}$/.test(value)) raise("22023", "erp_cnab_number_invalid");
  let total = 0;
  let factor = 2;
  for (let i = value!.length - 1; i >= 0; i--) {
    const n = Number(value![i]) * factor;
    total += Math.floor(n / 10) + (n % 10);
    factor = 3 - factor;
  }
  return base + String((10 - (total % 10)) % 10);
}

/** a IS DISTINCT FROM b entre jsonb (undefined: chave ausente, NULL). */
const distinct = (a: unknown, b: unknown) => (a === undefined || b === undefined ? a !== b : jsonbText(a) !== jsonbText(b));
const field = (o: unknown, k: string) => (jsonType(o) === "object" && Object.prototype.hasOwnProperty.call(o, k) ? (o as Json)[k] : undefined);

/**
 * O manifesto contra os títulos da remessa. `encoding`: o perfil de
 * codificação da remessa v2 (null na homologação e na v1), que acrescenta a
 * conferência dos termos e do dígito do nosso número.
 */
export function applyManifest(ctx: RpcContext, r: Remittance, manifest: unknown, encoding: string | null = null) {
  const db = ctx.db;
  const count = Number(one(db, 'SELECT count(*) n FROM "erp_cnab__billing_title" WHERE remittance_id=?', r.id)!.n);
  if (jsonType(manifest) !== "array" || (manifest as unknown[]).length !== count) raise("22023", "erp_cnab_manifest_invalid");
  const rows = manifest as unknown[];
  const ids = rows.map((row) => txt(row, "titleId")).filter((x) => x !== null);
  if (new Set(ids).size !== rows.length) raise("22023", "erp_cnab_manifest_duplicate");
  const allowed = ["titleId", "control", "documentNumber", "amountCents", "dueDate", "ourNumber"];
  for (const row of rows) {
    keys(row, encoding === OBSERVED ? [...allowed, "encodingTerms"] : allowed);
    const b = one(
      db,
      'SELECT id, control, document_number, our_number_base, snapshot FROM "erp_cnab__billing_title" WHERE id=? AND remittance_id=?',
      uuidValue(get(row, "titleId")),
      r.id,
    );
    const snap = b ? parse(b.snapshot) : null;
    if (
      !b ||
      txt(row, "control") !== b.control ||
      txt(row, "documentNumber") !== b.document_number ||
      txt(row, "amountCents") !== txt(snap, "title", "amountCents") ||
      txt(row, "dueDate") !== txt(snap, "title", "dueOn")
    )
      raise("40001", "erp_cnab_manifest_mismatch");
    const base = b!.our_number_base as string | null;
    if (encoding === OBSERVED) {
      const terms = field(row, "encodingTerms");
      const stored = field(field(snap, "title"), "encodingTerms");
      // (snapshot#>>'{title,encodingTerms,zeroDailyInterestConfirmed}')::boolean; só calculado se o primeiro teste não decidir.
      const expected = () => {
        const zero = get(snap, "title", "encodingTerms", "zeroDailyInterestConfirmed");
        const amount = txt(snap, "title", "amountCents");
        return encodingTerms(amount === null ? null : BigInt(amount), txt(snap, "title", "dueOn"), typeof zero === "boolean" ? zero : null);
      };
      if (
        distinct(terms, stored) ||
        distinct(terms, expected()) ||
        (txt(row, "encodingTerms", "dailyInterestCents") === "0" && get(row, "encodingTerms", "zeroDailyInterestConfirmed") !== true)
      )
        raise("40001", "erp_cnab_encoding_terms_mismatch");
    }
    if (encoding !== null) {
      const strings = ["titleId", "control", "documentNumber", "amountCents", "dueDate", "ourNumber"].every((k) => jsonType(field(row, k)) === "string");
      if (!strings || txt(row, "ourNumber") !== itauNumber(get(r.snapshot, "profile"), base)) raise("40001", "erp_cnab_manifest_mismatch");
    }
    const n = txt(row, "ourNumber");
    if (base === null) {
      if (n !== null) raise("40001", "erp_cnab_manifest_number");
    } else if (n === null || !/^[0-9]+$/.test(n) || n.length !== base.length + 1 || n.slice(0, base.length) !== base) raise("40001", "erp_cnab_manifest_number");
    db.exec('UPDATE "erp_cnab__billing_title" SET our_number=? WHERE id=?', n, b!.id);
  }
}

export interface FinalizeArgs {
  hash: string | null;
  size: number | null;
  path: string | null;
  manifest: unknown;
  /** Manifesto já gravado (para a remessa pronta). */
  stored: unknown;
  /** Exigir a política de cobrança simples (homologação e v1 sempre; v2 só sem encargos). */
  simple: boolean;
  encoding: string | null;
  /** Conferência extra entre a conta e o retrato (v2: erp_cnab.encoding_access). */
  beforeSnapshot?: () => void;
}

/** O ramo do finalize depois do storage_check: confere a remessa pronta ou grava o arquivo. */
export function finalizeRemittance(ctx: RpcContext, r: Remittance, f: FinalizeArgs) {
  const db = ctx.db;
  for (const row of db.exec("SELECT title_id FROM erp_cnab__billing_title WHERE remittance_id=?", r.id).rows)
    guardModuleBilling(ctx, String(row.title_id));
  if (r.state === "ready") {
    // file_hash<>hash or byte_size<>size or manifest<>p_manifest: manifesto nulo não recusa.
    const manifestDiffers = f.manifest === null || f.stored === null ? false : jsonbText(parse(f.stored)) !== jsonbText(f.manifest);
    if (r.file_hash !== f.hash || r.byte_size !== f.size || manifestDiffers) raise("40001", "erp_cnab_finalized_conflict");
    return;
  }
  const p = profileRow(db, r.profile_id)!;
  requireConfirmed(p, f.simple);
  if (!one(db, `SELECT 1 x FROM "erp_finance__account" WHERE id=? AND active=1 AND kind='bank'`, p.account_id)) raise("40001", "erp_cnab_bank_account_required");
  f.beforeSnapshot?.();
  if (snapshotStale(db, r.id)) raise("40001", "erp_cnab_snapshot_stale");
  applyManifest(ctx, r, f.manifest, f.encoding);
  db.exec(
    `UPDATE "erp_cnab__remittance" SET state='ready', object_path=?, file_hash=?, byte_size=?, manifest=?, finalized_at=? WHERE id=?`,
    f.path,
    f.hash,
    f.size,
    JSON.stringify(f.manifest),
    ctx.clock.next().toString(),
    r.id,
  );
}

export { NO_CHARGES, OBSERVED };
