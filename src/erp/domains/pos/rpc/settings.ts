// PDV, bloco P1 (sessão L): public.erp_pos_settings_execute, as configurações da
// frente de caixa (consumidor final e chave Pix, só o administrador) e os
// favoritos, com recibo em erp_pos.command (escopo 'settings') e auditoria.
import { createHash } from "node:crypto";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { replay } from "../../../engine/receipt.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { rowJson, rowJsonSelect } from "../../../engine/row-json.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { pgLength } from "../../../engine/text.ts";
import { access, int, keys, num, txt, uid, type Json } from "../internal.ts";

const ACTIONS = ["settings_save", "favorite_add", "favorite_remove"];
const PIX_TYPES = ["cpf", "cnpj", "email", "phone", "random"];
const utf8 = new TextEncoder();

const settingsRow = (db: SqlDriver) => one(db, `SELECT ${rowJsonSelect("erp_pos__settings")} FROM "erp_pos__settings" WHERE singleton=1`);

function invalidPix(type: string | null, key: string | null) {
  return (
    (type === null) !== (key === null) ||
    (type !== null && !PIX_TYPES.includes(type)) ||
    (type === "cpf" && !/^[0-9]{11}$/.test(key!)) ||
    (type === "cnpj" && !/^[0-9]{14}$/.test(key!)) ||
    (type === "phone" && !/^\+[0-9]{12,13}$/.test(key!)) ||
    (type === "email" && (!/^[^@ ]+@[^@ ]+\.[^@ ]+$/.test(key!) || pgLength(key!) > 77)) ||
    (type === "random" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key!))
  );
}

/** public.erp_pos_settings_execute(p_user_id, p_command_id, p_action, p_data) */
function erpPosSettingsExecute(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id === null || a.p_user_id === undefined ? null : String(a.p_user_id);
  const acc = access(db, user, true);
  const command = a.p_command_id === null || a.p_command_id === undefined ? null : String(a.p_command_id);
  const action = a.p_action === null || a.p_action === undefined ? null : String(a.p_action);
  const data = a.p_data;
  if (
    command === null ||
    action === null ||
    !ACTIONS.includes(action) ||
    data === null ||
    data === undefined ||
    jsonType(data) !== "object" ||
    utf8.encode(jsonbText(data)).length > 8192
  )
    raise("22023", "erp_pos_invalid_action");
  const hash = createHash("sha256")
    .update(jsonbText({ actor: user, scope: "settings", action, data }), "utf8")
    .digest("hex");
  const previous = replay(db, "erp_pos__command", command!, user!, hash, "erp_pos_command_conflict");
  if (previous) return { ...previous, replayed: true };

  let result: Json;
  let before: Json | null = null;
  if (action === "settings_save") {
    // Cliente padrão (consumidor não identificado) e chave Pix do QR estático: só o administrador.
    if (acc.role !== "admin") raise("42501", "erp_pos_access_denied");
    const all = ["expected_version", "consumer_contact_id", "pix_key_type", "pix_key", "pix_merchant_name", "pix_merchant_city"];
    keys(data, all, all);
    const st = settingsRow(db);
    if (num(st?.version) !== int(data, "expected_version", 0, 2147483646)) raise("40001", "erp_pos_version_conflict");
    const contact = uid(data, "consumer_contact_id");
    if (
      contact !== null &&
      contact !== (st?.consumer_contact_id ?? null) &&
      !one(db, 'SELECT 1 x FROM "erp_catalog__record" r JOIN "erp_catalog__contact" x ON x.record_id=r.id WHERE r.id=? AND r.active=1', contact)
    )
      raise("22023", "erp_pos_invalid_contact");
    const type = txt(data, "pix_key_type", 10);
    const key = txt(data, "pix_key", 77);
    if (invalidPix(type, key)) raise("22023", "erp_pos_invalid_pix_key");
    if (st) {
      before = rowJson("erp_pos__settings", st);
      delete before.singleton;
    }
    const name = key === null ? null : txt(data, "pix_merchant_name", 25, true);
    const city = key === null ? null : txt(data, "pix_merchant_city", 15, true);
    db.exec(
      `UPDATE "erp_pos__settings" SET consumer_contact_id=?, pix_key_type=?, pix_key=?, pix_merchant_name=?, pix_merchant_city=?,
         version=version+1, updated_by=?, updated_at=? WHERE singleton=1`,
      contact,
      type,
      key,
      name,
      city,
      user,
      ctx.clock.next().toString(),
    );
    const after = settingsRow(db);
    result = {
      entity: "pos_settings",
      record: {
        version: num(after?.version),
        consumer_contact_id: after?.consumer_contact_id ?? null,
        pix_key_type: after?.pix_key_type ?? null,
        pix_key: after?.pix_key ?? null,
        pix_merchant_name: after?.pix_merchant_name ?? null,
        pix_merchant_city: after?.pix_merchant_city ?? null,
      },
    };
  } else {
    keys(data, ["product_id"], ["product_id"]);
    const product = uid(data, "product_id", true)!;
    if (action === "favorite_add") {
      if (!one(db, 'SELECT 1 x FROM "erp_catalog__record" r JOIN "erp_catalog__product" x ON x.record_id=r.id WHERE r.id=? AND r.active=1', product))
        raise("22023", "erp_pos_invalid_product");
      if (!one(db, 'SELECT 1 x FROM "erp_pos__favorite" WHERE product_id=?', product)) {
        if (Number(one(db, 'SELECT count(*) n FROM "erp_pos__favorite"')!.n) >= 200) raise("22023", "erp_pos_favorites_limit");
        db.exec('INSERT INTO "erp_pos__favorite"(product_id, created_by, created_at) VALUES(?, ?, ?)', product, user, ctx.clock.next().toString());
      }
    } else db.exec('DELETE FROM "erp_pos__favorite" WHERE product_id=?', product);
    result = { entity: "pos_favorites", record: { product_id: product, favorite: action === "favorite_add" } };
  }
  access(db, user, true);
  result = { ...result, action, data_mode: "erp_native", replayed: false };
  db.exec(
    'INSERT INTO "erp_pos__command"(id, actor, scope, request_hash, result, created_at) VALUES(?, ?, ?, ?, ?, ?)',
    command,
    user,
    "settings",
    hash,
    JSON.stringify(result),
    ctx.clock.next().toString(),
  );
  db.exec(
    'INSERT INTO "erp_pos__audit"(id, actor, command_id, sale_id, action, before_data, after_data, created_at) VALUES(?, ?, ?, NULL, ?, ?, ?, ?)',
    nextIdentity(ctx, "erp_pos__audit", "id"),
    user,
    command,
    action,
    before === null ? null : JSON.stringify(before),
    JSON.stringify(result),
    ctx.clock.next().toString(),
  );
  return result;
}

registerRpc("erp_pos_settings_execute", erpPosSettingsExecute);
