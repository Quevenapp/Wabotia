// Maquininha integrada ao caixa (src/erp/terminal/): o pagamento aprovado na
// maquininha entra na conciliação de cartões já casado com a venda do PDV.
// erp_reconciliation_card_terminal grava uma linha de venda da adquirente
// (erp_reconciliation__card_line, kind 'sale') com a bandeira, débito ou
// crédito, parcelas, valor, tarifa, NSU e autorização que o provedor
// informou, ligada às contas a receber das parcelas da venda na forma da
// maquininha (o mesmo grupo de contas). Sem as contas ainda lançadas (o
// lançamento ficou pendente), a linha entra pendente e o "Casar de novo" da
// conciliação acha a venda depois. Nenhuma tabela nova: a origem é uma
// importação de uma linha ("Maquininha … venda nº …") com o hash da
// referência do pagamento; repetir não duplica.
//
// Quem chama: a pessoa do caixa que finalizou a venda (operar o PDV com
// fechamento) ou o Financeiro (administrador e financeiro).
import { createHash } from "node:crypto";
import { one } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../engine/registry.ts";
import { todaySaoPaulo } from "../../engine/time.ts";
import { requireRpcParts } from "../../engine/parts-gate.ts";
import { access as posAccess } from "../pos/internal.ts";
import { ACQUIRERS, BRANDS } from "./model.ts";
import { AUDIT, CARD_LINE, COMMAND, IMPORT } from "./rpc.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CENTS = /^[0-9]{1,15}$/;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const invalid = (code = "erp_reconciliation_invalid"): never => raise("22023", code);
const short = (value: unknown, max: number) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.trim())) return invalid();
  return value.trim().slice(0, max);
};
const ARGS = ["sale_id", "payment_method_id", "acquirer", "product", "brand", "installments", "gross_cents", "fee_cents", "nsu", "authorization", "reference"];

function erpReconciliationCardTerminal(ctx: RpcContext, a: RpcArgs) {
  requireRpcParts(ctx, "erp_reconciliation_card_terminal", a);
  const db = ctx.db;
  const user = typeof a.p_user_id === "string" ? a.p_user_id : null;
  const command = typeof a.p_command_id === "string" && UUID.test(a.p_command_id) ? a.p_command_id.toLowerCase() : invalid("erp_reconciliation_command_invalid");
  const args = a.p_args && typeof a.p_args === "object" && !Array.isArray(a.p_args) ? a.p_args as Record<string, any> : invalid();
  if (Object.keys(args).some((key) => !ARGS.includes(key))) invalid();
  // Caixa que fecha a venda (PDV com fechamento) ou o Financeiro.
  const role = user === null ? null : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user)?.role as string | undefined;
  if (!(role === "admin" || role === "financeiro")) {
    const pos = posAccess(db, user, true);
    if (!pos.finish) raise("42501", "erp_pos_finish_denied");
  }
  const sale = typeof args.sale_id === "string" && UUID.test(args.sale_id) ? args.sale_id.toLowerCase() : invalid();
  const method = typeof args.payment_method_id === "string" && UUID.test(args.payment_method_id) ? args.payment_method_id.toLowerCase() : invalid();
  const acquirer = typeof args.acquirer === "string" && Object.hasOwn(ACQUIRERS, args.acquirer) && args.acquirer !== "outra" ? args.acquirer : invalid("erp_reconciliation_acquirer_invalid");
  const product = args.product === "debit" || args.product === "credit" ? args.product : invalid();
  const brand = typeof args.brand === "string" && (BRANDS as readonly string[]).includes(args.brand) ? args.brand : invalid();
  const installments = Number.isSafeInteger(args.installments) && args.installments >= 1 && args.installments <= 99 ? args.installments as number : invalid();
  if (product === "debit" && installments !== 1) invalid();
  const gross = typeof args.gross_cents === "string" && CENTS.test(args.gross_cents) && BigInt(args.gross_cents) > 0n ? BigInt(args.gross_cents) : invalid();
  const fee = typeof args.fee_cents === "string" && CENTS.test(args.fee_cents) ? BigInt(args.fee_cents) : invalid();
  if (fee > gross) invalid();
  const nsu = short(args.nsu, 40), authorization = short(args.authorization, 40);
  const reference = typeof args.reference === "string" && UUID.test(args.reference) ? args.reference.toLowerCase() : invalid();

  const dedup = sha256(`terminal:${reference}`);
  const existing = one(db, `SELECT id, state, title_id, group_id FROM "${CARD_LINE}" WHERE acquirer=? AND kind='sale' AND dedup_key=?`, acquirer, dedup);
  if (existing) return { line_id: existing.id, state: existing.state === "pending" ? "pending" : "matched", note: "Já estava na conciliação de cartões.", replayed: true };

  const s = one(db, `SELECT s.id, s.state, d.number FROM "erp_pos__sale" s JOIN "erp_documents__document" d ON d.id=s.document_id WHERE s.id=?`, sale);
  if (!s) raise("P0002", "erp_pos_not_found");
  if (s!.state !== "finished") raise("40001", "erp_pos_sale_state");
  const pays = db.exec(`SELECT p.position, CAST(p.amount_cents AS TEXT) amount_cents, p.title_id, t.group_id FROM "erp_pos__sale_payment" p
    LEFT JOIN "erp_finance__title" t ON t.id=p.title_id AND t.cancelled=0 AND t.deleted_at IS NULL WHERE p.sale_id=? AND p.payment_method_id=? ORDER BY p.position`, sale, method).rows;
  const sum = pays.reduce((total, p) => total + BigInt(String(p.amount_cents)), 0n);
  if (!pays.length || sum !== gross) raise("22023", "erp_reconciliation_terminal_amount");
  const groups = new Set(pays.map((p) => p.group_id).filter((g) => typeof g === "string"));
  const linked = pays.every((p) => typeof p.group_id === "string") && groups.size === 1;
  const group = linked ? String([...groups][0]) : null;
  const title = linked && pays.length === 1 ? String(pays[0].title_id) : null;
  // Uma conta com o valor da venda (a linha é de venda); com várias parcelas, o grupo delas.
  const at = ctx.clock.next().toString();
  const day = todaySaoPaulo();
  const importId = crypto.randomUUID();
  const label = `Maquininha ${ACQUIRERS[acquirer]} — venda do PDV nº ${s!.number}`;
  db.exec(`INSERT INTO "${IMPORT}"(id, acquirer, kind, file_name, file_hash, layout_id, lines, new_lines, actor, command_id, created_at) VALUES(?,?,'sales',?,?,NULL,1,1,?,?,?)`,
    importId, acquirer, label.slice(0, 200), dedup, user, command, at);
  const lineId = crypto.randomUUID();
  db.exec(`INSERT INTO "${CARD_LINE}"(id, import_id, kind, acquirer, dedup_key, sold_on, expected_on, brand, product, installment, installments, gross_cents, fee_cents, net_cents,
    nsu, "authorization", description, state, title_id, group_id, confidence, version, created_at, updated_at, updated_by) VALUES(?,?,'sale',?,?,?,NULL,?,?,1,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
  lineId, importId, acquirer, dedup, day, brand, product, installments, gross.toString(), fee.toString(), (gross - fee).toString(), nsu, authorization, label.slice(0, 200),
  linked ? "matched" : "pending", title, group, linked ? 100 : null, at, at, user);
  const result = { line_id: lineId, state: linked ? "matched" : "pending",
    note: linked ? "Na conciliação de cartões, já casado com a venda." : "Na conciliação de cartões, esperando o lançamento das contas da venda (use Casar de novo depois de lançar)." };
  const hash = sha256(JSON.stringify({ actor: user, action: "card_terminal", args }));
  db.exec(`INSERT INTO "${COMMAND}"(command_id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)`, command, user, hash, JSON.stringify(result), at);
  db.exec(`INSERT INTO "${AUDIT}"(command_id, actor, action, target, before_data, after_data, created_at) VALUES(?,?,?,?,NULL,?,?)`, command, user, "card_terminal", lineId, JSON.stringify(result), at);
  return { ...result, replayed: false };
}

registerRpc("erp_reconciliation_card_terminal", erpReconciliationCardTerminal);
