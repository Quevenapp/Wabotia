// public.erp_reference_search (tabelas oficiais: CNAE, municípios, países).
// LIKE com padrão de até 80 caracteres estoura o limite de 50 bytes do
// SQLite (prova 1): a busca usa instr() na coluna "key" já normalizada, e a
// chave da descrição do CNAE é calculada aqui (1.332 linhas).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { todaySaoPaulo } from "../../../engine/time.ts";
import { pgLower } from "../../../engine/text.ts";
import { memberRole } from "../../access/public.ts";

const CNTRL = /[\u0000-\u001f\u007f-\u009f]/;
const FROM = "áàâãäéèêëíìîïóòôõöúùûüçñ";
const TO = "aaaaaeeeeiiiiooooouuuucn";

/** erp_reference.key: minúsculas, sem acento (translate) e só [a-z0-9]. */
export function referenceKey(value: string | null) {
  let out = "";
  for (const ch of pgLower(value ?? "")) {
    const i = FROM.indexOf(ch);
    out += i >= 0 ? TO[i] : ch;
  }
  return out.replace(/[^a-z0-9]/g, "");
}

/** erp_reference.cnae_format: 4744001 → 4744-0/01 */
const cnaeFormat = (code: string) => `${code.slice(0, 4)}-${code.slice(4, 5)}/${code.slice(-2)}`;

function dataset(ctx: RpcContext, name: string) {
  const d = one(
    ctx.db,
    'SELECT name, source, source_url, version, fetched_on, rows FROM "erp_reference__dataset" WHERE name=?',
    name,
  );
  return d
    ? { name: d.name, source: d.source, source_url: d.source_url, version: d.version, fetched_on: d.fetched_on, rows: d.rows }
    : null;
}

export function erpReferenceSearch(ctx: RpcContext, a: RpcArgs) {
  memberRole(ctx.db, (a.p_user_id as string | null) ?? null);
  const table = (a.p_table as string | null) ?? null;
  const query = (a.p_query as string | null) ?? null;
  const uf = (a.p_uf as string | null) ?? null;
  const limit = a.p_limit as number | null;
  if (
    table === null ||
    !["cnae", "municipios", "paises"].includes(table) ||
    limit === null ||
    limit === undefined ||
    limit < 1 ||
    limit > 50 ||
    (query !== null && ([...query].length > 80 || CNTRL.test(query))) ||
    (uf !== null && (table !== "municipios" || !/^[A-Z]{2}$/.test(uf)))
  )
    raise("22023", "erp_reference_input_invalid");
  const key = referenceKey(query);
  const digits = (query ?? "").replace(/[^0-9]/g, "");
  let items: Record<string, unknown>[];
  if (table === "cnae") {
    // Ordem por código; filtro em TS sobre a descrição normalizada.
    const rows = ctx.db.exec('SELECT code, description, section FROM "erp_reference__cnae" ORDER BY code').rows;
    items = rows
      .filter(
        (c) =>
          key === "" ||
          (digits !== "" && String(c.code).startsWith(digits)) ||
          referenceKey(String(c.description)).includes(key),
      )
      .slice(0, limit)
      .map((c) => ({ code: cnaeFormat(String(c.code)), description: c.description, section: c.section }));
  } else if (table === "municipios") {
    items = ctx.db
      .exec(
        `SELECT code, name, uf FROM "erp_reference__municipality" m
         WHERE (? IS NULL OR m.uf=?) AND (?='' OR (?<>'' AND substr(m.code,1,length(?))=?) OR instr(m.key, ?)>0)
         ORDER BY (substr(m.key,1,length(?))=?) DESC, m.name, m.code LIMIT ?`,
        uf, uf, key, digits, digits, digits, key, key, key, limit,
      )
      .rows.map((m) => ({ code: m.code, name: m.name, uf: m.uf }));
  } else {
    const today = todaySaoPaulo();
    items = ctx.db
      .exec(
        `SELECT code, name FROM "erp_reference__country" c
         WHERE c.start_on<=? AND (c.end_on IS NULL OR c.end_on>=?)
         AND (?='' OR (?<>'' AND substr(c.code,1,length(?))=?) OR instr(c.key, ?)>0)
         ORDER BY (substr(c.key,1,length(?))=?) DESC, c.name LIMIT ?`,
        today, today, key, digits, digits, digits, key, key, key, limit,
      )
      .rows.map((c) => ({ code: c.code, name: c.name }));
  }
  return {
    scope: "reference_search",
    data_mode: "erp_native",
    table,
    dataset: dataset(ctx, table),
    items,
  };
}

registerRpc("erp_reference_search", erpReferenceSearch);
