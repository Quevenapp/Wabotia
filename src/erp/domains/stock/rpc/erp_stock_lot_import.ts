// public.erp_stock_lot_import (277): cria o lote ou atualiza somente os
// campos preenchidos, sem movimentar estoque. Mesmo comando, mesmo recibo.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc } from "../../../engine/registry.ts";
import { pgBtrim, pgHasCntrl, pgLength, pgLower } from "../../../engine/text.ts";
import { commandTaken, requireAccess, sha256 } from "../internal.ts";
import { lotProductProblem } from "./document-stock.ts";
import { lotCheck, lotDto } from "./lots.ts";

registerRpc("erp_stock_lot_import", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, command = a.p_command_id as string | null,
    product = a.p_product_id as string | null, code = a.p_code as string | null,
    made = a.p_manufactured_on as string | null, expires = a.p_expires_on as string | null, note = a.p_note as string | null;
  requireAccess(db, user, true);
  if (command === null || product === null || code === null || pgLength(pgBtrim(code)) < 1 || pgLength(pgBtrim(code)) > 60 || pgHasCntrl.test(code)
    || note !== null && (pgLength(note) > 500 || pgHasCntrl.test(note))) raise("22023", "erp_stock_lot_invalid");
  const trimmedNote = note === null ? null : pgBtrim(note) || null;
  const hash = sha256(jsonbText({ profile: "stock-lot-import-277", actor: user, product_id: product, code,
    manufactured_on: made, expires_on: expires, note }));
  requireAccess(db, user, true);
  const receipt = one(db, "SELECT actor,action,request_hash,result FROM erp_stock__lot_command WHERE id=?", command);
  if (receipt) {
    if (receipt.actor !== user || receipt.action !== "save" || receipt.request_hash !== hash) raise("40001", "erp_stock_lot_conflict");
    return { ...JSON.parse(String(receipt.result)), replayed: true };
  }
  if (commandTaken(db, command!)) raise("40001", "erp_stock_lot_conflict");
  requireAccess(db, user, true);
  const problem = lotProductProblem(db, product!);
  if (problem === "not_found") raise("P0002", "erp_stock_product_not_found");
  const lot = one(db, "SELECT * FROM erp_stock__lot WHERE product_id=? AND code__fold=?", product, pgLower(pgBtrim(code!)));
  let id: string, outcome: "created" | "updated" | "unchanged";
  if (!lot) {
    if (problem !== null) raise("22023", "erp_stock_lot_control_off");
    lotCheck(db, code, made, expires, trimmedNote);
    id = crypto.randomUUID();
    db.exec(`INSERT INTO erp_stock__lot(id,product_id,code,code__fold,manufactured_on,expires_on,note,version,created_by,updated_by,command_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, product, pgBtrim(code!), pgLower(pgBtrim(code!)), made, expires, trimmedNote, 1, user, user, command,
      ctx.clock.next().toString(), ctx.clock.next().toString());
    outcome = "created";
  } else {
    id = String(lot.id);
    const nextMade = made ?? lot.manufactured_on ?? null, nextExpires = expires ?? lot.expires_on ?? null, nextNote = trimmedNote ?? lot.note ?? null;
    if ((lot.manufactured_on ?? null) === nextMade && (lot.expires_on ?? null) === nextExpires && (lot.note ?? null) === nextNote) outcome = "unchanged";
    else {
      lotCheck(db, String(lot.code), nextMade as string | null, nextExpires as string | null, nextNote as string | null);
      if (Number(lot.version) >= 2147483647) raise("22003", "integer out of range");
      // guard_lot, como no save: o código/produto/criador ficam, a versão avança.
      if (lot.command_id === command) raise("40001", "erp_stock_lot_immutable");
      db.exec("UPDATE erp_stock__lot SET manufactured_on=?,expires_on=?,note=?,version=version+1,updated_at=?,updated_by=?,command_id=? WHERE id=?",
        nextMade, nextExpires, nextNote, ctx.clock.next().toString(), user, command, id);
      outcome = "updated";
    }
  }
  const result = { scope: "stock_lot_import", data_mode: "erp_native", outcome, lot: lotDto(db, id) };
  db.exec("INSERT INTO erp_stock__lot_command(id,actor,action,product_id,lot_id,request_hash,result,created_at) VALUES(?,?,?,?,?,?,?,?)",
    command, user, "save", product, id, hash, JSON.stringify(result), ctx.clock.next().toString());
  return { ...result, replayed: false };
});
