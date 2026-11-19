// public.erp_catalog_seller_save: o formulário de vendedor grava o contato
// (núcleo contact_apply da P, com os campos obrigatórios do formulário de
// vendedor) e as configurações num só comando. O tipo Vendedor fica sempre no
// contato. A resposta diz, para a pessoa vinculada antes e agora, se o portão
// de acesso vale (horário do vendedor), relido também na repetição.
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { jsonArg } from "../args.ts";
import { auxiliaryAudit, requestHash, storeCommand } from "../command.ts";
import { acknowledgedValid, contactApply, contactDto } from "../contact-core.ts";
import { compareText } from "../fields.ts";
import { preserveCatalogFields } from "../cost.ts";
import {
  SELLER_CONTACT_FIELDS, sellerAccess, sellerAccessGates, sellerDto, sellerSettings, sellerValues, sellerWrite,
} from "../seller.ts";

const MAX_VERSION = 2147483647;
type Json = Record<string, unknown>;

/** jsonb ? 'chave': elemento texto de array, chave de objeto ou o próprio texto. */
export function jsonbHas(value: unknown, key: string) {
  if (Array.isArray(value)) return value.includes(key);
  if (value !== null && typeof value === "object") return Object.hasOwn(value, key);
  return value === key;
}

export function erpCatalogSellerSave(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  const expected = (a.p_expected_version ?? null) as number | null;
  const contactExpected = (a.p_contact_expected_version ?? null) as number | null;
  const command = (a.p_command_id ?? null) as string | null;
  let contact = jsonArg(a, "p_contact");
  const settings = jsonArg(a, "p_settings");
  const acknowledged = jsonArg(a, "p_acknowledged");
  const db = ctx.db;
  sellerAccess(db, user, true);
  requireAccess(db, user, "contacts", true);
  const range = (v: number) => v >= 1 && v <= MAX_VERSION;
  if (
    command === null ||
    expected === null ||
    contactExpected === null ||
    (id === null && (expected !== 0 || contactExpected !== 0)) ||
    (id !== null && (!range(expected) || !range(contactExpected))) ||
    contact === null ||
    jsonType(contact) !== "object" ||
    Object.keys(contact as object).length === 0 ||
    !acknowledgedValid(acknowledged)
  )
    raise("22023", "erp_catalog_invalid_command");
  const hash = requestHash({
    profile: "erp-seller-save-v1", actor: user, id, version: expected, contact_version: contactExpected, contact, settings, acknowledged,
  });
  const stored = one(db, 'SELECT actor, request_hash, result FROM "erp_catalog__command" WHERE command_id=?', command);
  if (stored) {
    if (stored.actor !== user || stored.request_hash !== hash) raise("40001", "erp_catalog_command_conflict");
    const result = JSON.parse(String(stored.result)) as Json;
    // 241: os portões de acesso são relidos em cada resposta.
    return { ...result, replayed: true, access_gates: sellerAccessGates(db, result.access_users) };
  }
  const previous = id === null ? {} : sellerValues(db, id) ?? {};
  const defaults = { commission_rule: "parcial", commission_mode: "fixa", commission_rate: null, commission_bands: [] };
  const input = !ctx.parts.finance && settings !== null && typeof settings === "object" && !Array.isArray(settings)
    ? { ...preserveCatalogFields(false, {}, previous, defaults), ...settings } : settings;
  const v = sellerSettings(input);
  preserveCatalogFields(ctx.parts.finance, v, previous, defaults);
  let seller: { contact_id: string; user_id: string | null } | null = null;
  if (id !== null) {
    const row = one(db, 'SELECT contact_id, user_id, CAST(version AS TEXT) version FROM "erp_catalog__seller" WHERE id=?', id);
    if (!row) raise("P0002", "erp_catalog_not_found");
    if (Number(row.version) !== expected) raise("40001", "erp_catalog_version_conflict");
    if (Number(row.version) === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
    seller = { contact_id: String(row.contact_id), user_id: (row.user_id as string | null) ?? null };
  }
  // O tipo Vendedor fica sempre no contato de um vendedor.
  const c = contact as Json;
  if (Object.hasOwn(c, "types") && !jsonbHas(c.types, "seller")) {
    if (!Array.isArray(c.types)) raise("22023", "erp_catalog_contact_invalid:types");
    contact = { ...c, types: [...(c.types as unknown[]), "seller"] };
  }
  if (id === null && !Object.hasOwn(contact as Json, "types")) contact = { ...(contact as Json), types: ["seller"] };
  const saved = contactApply(ctx, user!, seller?.contact_id ?? null, contactExpected!, command!, contact, acknowledged, "update", SELLER_CONTACT_FIELDS)!;
  const contactId = String(saved.id);
  let sellerId: string;
  if (id === null) {
    sellerId = sellerWrite(ctx, user!, null, contactId, v);
    auxiliaryAudit(ctx, { actor: user!, command, subject: "seller", subjectId: sellerId, action: "create", after: sellerDto(db, sellerId) });
  } else {
    sellerId = id;
    const before = sellerDto(db, id);
    if (jsonbText(sellerValues(db, id)) !== jsonbText(v)) {
      sellerWrite(ctx, user!, id, seller!.contact_id, v);
      auxiliaryAudit(ctx, { actor: user!, command, subject: "seller", subjectId: id, action: "update", before, after: sellerDto(db, id) });
    }
  }
  // 241: quem pode ter mudado de portão: a pessoa vinculada antes e a de agora.
  const now = one(db, 'SELECT user_id FROM "erp_catalog__seller" WHERE id=?', sellerId)?.user_id as string | null | undefined;
  const users = [...new Set([seller?.user_id ?? null, now ?? null].filter((u): u is string => u !== null))].sort(compareText);
  const result = {
    entity: "sellers", data_mode: "erp_native", replayed: false, seller: sellerDto(db, sellerId), contact: contactDto(db, contactId),
    access_users: users,
  };
  storeCommand(ctx, command!, user!, hash, result);
  return { ...result, access_gates: sellerAccessGates(db, users) };
}

registerRpc("erp_catalog_seller_save", erpCatalogSellerSave);
