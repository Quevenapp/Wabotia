// Contas recorrentes: public.erp_finance_recurrence_execute (criar, gerar a
// próxima conta, ativar e inativar, alterar contas em aberto e as futuras),
// erp_finance_recurrence_get e erp_finance_recurrence_page.
import { one } from "../../../engine/driver.ts";
import { intIn } from "../../../engine/args.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import {
  bool,
  btrim,
  charLength,
  cents,
  cmpText,
  CNTRL,
  day,
  expected,
  field,
  flushDeferred,
  hasKey,
  insertAudit,
  insertCommand,
  jsonArg,
  jsonBytes,
  keys,
  pgLower,
  replayed,
  requestHash,
  requireAccess,
  txt,
  uuidArg,
  uuidValue,
  writeRow,
} from "../internal.ts";
import { activeAccount, activeCategory, bankNumber, bp, dto, updateTitle } from "../titles.ts";
import { daysBetween, recurrenceNext, recurrenceTitle, recurrenceView } from "../recurrence.ts";

const ACTIONS = ["recurrence_create", "recurrence_generate", "recurrence_set_active", "recurrence_update"];
const FREQUENCIES = ["weekly", "biweekly", "monthly", "bimonthly", "quarterly", "semiannual", "annual", "installments"];
/** p_data ? k and p_data->k <> 'null' */
const present = (data: unknown, key: string) => hasKey(data, key) && field(data, key) !== null;
/** p_data->>k: string crua; outro valor JSON pelo texto do jsonb */
const textOf = (v: unknown) => (v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v));
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

function recurrenceCreate(ctx: RpcContext, data: unknown, user: string, command: string) {
  const db = ctx.db;
  keys(data, [
    "kind", "contact_id", "category_id", "account_id", "description", "source_reference", "bank_number", "issued_on", "competence_on", "due_on", "amount_cents",
    "interest_month_bp", "penalty_bp", "frequency", "due_day", "second_day", "weekday", "end_on", "business_days", "installments", "payment_method_id",
  ]);
  const kind = txt(data, "kind", 20, true)!;
  if (!["receivable", "payable"].includes(kind)) raise("22023", "erp_finance_invalid_kind");
  // Forma de pagamento: ativa, não excluída e aplicável a recebimentos (receber) ou pagamentos (pagar) (175).
  const method = uuidValue(field(data, "payment_method_id"), false);
  if (
    method !== null &&
    !one(
      db,
      `SELECT 1 x FROM "erp_catalog__payment_method" f WHERE f.id=? AND f.active=1 AND f.deleted_at IS NULL AND f.applicable IN ('ambos', ?)`,
      method,
      kind === "receivable" ? "recebimentos" : "pagamentos",
    )
  )
    raise("22023", "erp_finance_invalid_payment_method");
  const frequency = txt(data, "frequency", 20, true)!;
  if (!FREQUENCIES.includes(frequency)) raise("22023", "erp_finance_invalid_data");
  // Parcelada (172): "Parcelas" de 2 a 120 e sem Data limite.
  const installmentsText = textOf(field(data, "installments"));
  if (
    (frequency === "installments") !== present(data, "installments") ||
    (frequency === "installments" &&
      (jsonType(field(data, "installments")) !== "number" ||
        !/^[0-9]{1,3}$/.test(installmentsText!) ||
        Number(installmentsText) < 2 ||
        Number(installmentsText) > 120 ||
        present(data, "end_on")))
  )
    raise("22023", "erp_finance_invalid_data");
  const issued = day(field(data, "issued_on"));
  const competence = day(field(data, "competence_on"));
  const due = day(field(data, "due_on"));
  if (due < issued) raise("22023", "erp_finance_invalid_due_date");
  const end = present(data, "end_on") ? day(field(data, "end_on")) : null;
  if (end !== null && end < due) raise("22023", "erp_finance_invalid_data");
  const dueDay = present(data, "due_day") ? expected(field(data, "due_day")) : null;
  const second = present(data, "second_day") ? expected(field(data, "second_day")) : null;
  // (p_data->>'weekday')::integer antes da conferência: o cast do Postgres recusa primeiro.
  const weekday = present(data, "weekday") ? Number(intIn(textOf(field(data, "weekday"))!, "integer")) : null;
  if (present(data, "weekday") && (jsonType(field(data, "weekday")) !== "number" || !/^[0-6]$/.test(textOf(field(data, "weekday"))!)))
    raise("22023", "erp_finance_invalid_data");
  const businessValue = field(data, "business_days");
  // coalesce(p_data->'business_days','false'): só a chave ausente vale false; o null do JSON é recusado.
  if (businessValue !== undefined && jsonType(businessValue) !== "boolean") raise("22023", "erp_finance_invalid_data");
  // Semanal: o dia da semana do vencimento; as outras: o dia de vencimento (e o 2º da Quinzenal).
  if (frequency === "weekly" && weekday !== dow(due)) raise("22023", "erp_finance_invalid_data");
  if (frequency !== "weekly" && (dueDay === null || dueDay > 31)) raise("22023", "erp_finance_invalid_data");
  if (frequency === "biweekly" && (second === null || second > 31 || second === dueDay)) raise("22023", "erp_finance_invalid_data");
  const contact = uuidValue(field(data, "contact_id"))!;
  if (!one(db, 'SELECT 1 x FROM "erp_catalog__contact" c JOIN "erp_catalog__record" r ON r.id=c.record_id WHERE c.record_id=? AND r.active=1', contact))
    raise("22023", "erp_finance_invalid_contact");
  // INSERT: valores na ordem das colunas da tabela (plano genérico; ERP-PORTE.md, ordem das recusas).
  const category = activeCategory(db, uuidValue(field(data, "category_id"), false), kind);
  const account = activeAccount(db, uuidValue(field(data, "account_id"), false));
  const description = txt(data, "description", 240, true);
  const reference = txt(data, "source_reference", 200);
  const bank = bankNumber(data);
  const amount = cents(field(data, "amount_cents"), false);
  const interest = bp(data, "interest_month_bp") ?? 0;
  const penalty = bp(data, "penalty_bp") ?? 0;
  const id = crypto.randomUUID();
  const now = ctx.clock.next().toString();
  db.exec(
    `INSERT INTO "erp_finance__recurrence"(id, kind, contact_id, category_id, account_id, description, source_reference, bank_number, amount_cents, interest_month_bp, penalty_bp,
       frequency, due_day, second_day, weekday, business_days, end_on, lead_days, next_on, generated, active, version, actor, command_id, created_at, updated_at, installments, payment_method_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,1,1,1,?,?,?,?,?,?)`,
    id, kind, contact, category, account, description, reference, bank, amount, interest, penalty,
    frequency, frequency !== "weekly" ? dueDay : null, frequency === "biweekly" ? second : null, frequency === "weekly" ? weekday : null,
    businessValue === true ? 1 : 0, end, daysBetween(issued, due), user, command, now, now,
    frequency === "installments" ? Number(installmentsText) : null, method,
  );
  // A primeira conta guarda a emissão e a competência informadas; as seguintes, a mesma distância do vencimento.
  const rec = one(db, 'SELECT * FROM "erp_finance__recurrence" WHERE id=?', id)!;
  const title = recurrenceTitle(ctx, rec, due);
  updateTitle(ctx, title, { issued_on: issued, competence_on: competence });
  writeRow(ctx, "erp_finance__recurrence", "id", id, { next_on: recurrenceNext(frequency, rec.due_day as number | null, rec.second_day as number | null, due) });
  return { entity: "recurrences", record: recurrenceView(db, id), title: dto(db, "titles", title) };
}

export function erpFinanceRecurrenceExecute(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const command = uuidArg(a.p_command_id);
  const action = (a.p_action as string | null) ?? null;
  const data = a.p_data === undefined || a.p_data === null ? null : jsonArg(a.p_data);

  requireAccess(db, user, true);
  if (command === null || action === null || !ACTIONS.includes(action)) raise("22023", "erp_finance_invalid_action");
  if (data === null || jsonType(data) !== "object" || jsonBytes(data) > 16384) raise("22023", "erp_finance_invalid_data");
  const hash = requestHash(user, action, data);
  requireAccess(db, user, true);
  const replay = replayed(db, command, user, hash);
  if (replay) return replay;

  let result: Record<string, unknown>;
  let before: unknown = null;
  if (action === "recurrence_create") result = recurrenceCreate(ctx, data, user, command);
  else {
    keys(
      data,
      action === "recurrence_set_active" ? ["id", "expected_version", "active"]
        : action === "recurrence_update" ? ["id", "expected_version", "from_title_id", "scope", "future", "changes"]
          : ["id", "expected_version"],
    );
    const rec = one(db, 'SELECT * FROM "erp_finance__recurrence" WHERE id=?', uuidValue(field(data, "id")));
    if (!rec) raise("P0002", "erp_finance_not_found");
    if (rec.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_version_conflict");
    const id = String(rec.id);
    before = recurrenceView(db, id);
    const bump = (set: Record<string, unknown> = {}) =>
      writeRow(ctx, "erp_finance__recurrence", "id", id, {
        ...set,
        version: Number(one(db, 'SELECT version FROM "erp_finance__recurrence" WHERE id=?', id)!.version) + 1,
        updated_at: ctx.clock.next().toString(),
      });
    if (action === "recurrence_generate") {
      // Gerar contas: a próxima conta de uma recorrência ativa, até a data limite; uma data nunca duas vezes (índice único).
      if (
        !bool(rec.active) || rec.next_on === null || (rec.end_on !== null && String(rec.next_on) > String(rec.end_on)) ||
        (rec.installments !== null && Number(rec.generated) >= Number(rec.installments))
      )
        raise("40001", "erp_finance_recurrence_finished");
      const title = recurrenceTitle(ctx, rec, String(rec.next_on));
      bump({ next_on: recurrenceNext(String(rec.frequency), rec.due_day as number | null, rec.second_day as number | null, String(rec.next_on)), generated: Number(rec.generated) + 1 });
      result = { entity: "recurrences", record: recurrenceView(db, id), title: dto(db, "titles", title) };
    } else if (action === "recurrence_set_active") {
      if (!hasKey(data, "active") || jsonType(field(data, "active")) !== "boolean") raise("22023", "erp_finance_invalid_active");
      const value = field(data, "active") as boolean;
      if (value === bool(rec.active)) raise("40001", "erp_finance_version_conflict");
      bump({ active: value });
      result = { entity: "recurrences", record: recurrenceView(db, id) };
    } else {
      // Alterar contas em aberto (as seguintes ou todas) e os lançamentos de contas futuras.
      const scope = txt(data, "scope", 20, true)!;
      if (!["none", "following", "all"].includes(scope)) raise("22023", "erp_finance_invalid_data");
      if (jsonType(field(data, "future") ?? null) !== "boolean" || jsonType(field(data, "changes") ?? null) !== "object") raise("22023", "erp_finance_invalid_data");
      const changes = field(data, "changes") as Record<string, unknown>;
      keys(changes, ["description", "amount_cents", "category_id", "account_id", "interest_month_bp", "penalty_bp"]);
      if (Object.keys(changes).length === 0) raise("22023", "erp_finance_invalid_data");
      if (hasKey(changes, "description")) txt(changes, "description", 240, true);
      if (hasKey(changes, "amount_cents")) cents(field(changes, "amount_cents"), false);
      if (hasKey(changes, "category_id")) activeCategory(db, uuidValue(field(changes, "category_id"), false), String(rec.kind));
      if (hasKey(changes, "account_id")) activeAccount(db, uuidValue(field(changes, "account_id"), false));
      const fromId = uuidValue(field(data, "from_title_id"))!;
      const from = one(db, 'SELECT recurrence_on FROM "erp_finance__title" WHERE id=? AND recurrence_id=?', fromId, id);
      if (!from) raise("22023", "erp_finance_invalid_data");
      const apply = (current: Record<string, unknown>) => ({
        description: txt(changes, "description", 240) ?? current.description,
        amount_cents: hasKey(changes, "amount_cents") ? cents(field(changes, "amount_cents"), false) : Number(current.amount_cents),
        category_id: hasKey(changes, "category_id") ? uuidValue(field(changes, "category_id"), false) : current.category_id,
        account_id: hasKey(changes, "account_id") ? uuidValue(field(changes, "account_id"), false) : current.account_id,
        interest_month_bp: bp(changes, "interest_month_bp") ?? Number(current.interest_month_bp),
        penalty_bp: bp(changes, "penalty_bp") ?? Number(current.penalty_bp),
      });
      let count = 0;
      if (scope !== "none") {
        const rows = db
          .exec(
            `SELECT t.* FROM "erp_finance__title" t WHERE t.recurrence_id=? AND t.id<>? AND (?='all' OR t.recurrence_on>?)
               AND t.cancelled=0 AND t.deleted_at IS NULL AND t.settled_cents=0
               AND NOT EXISTS(SELECT 1 FROM "erp_finance__settlement" s WHERE s.title_id=t.id)
               AND NOT EXISTS(SELECT 1 FROM "erp_cnab__billing_title" b WHERE b.title_id=t.id)
               AND NOT EXISTS(SELECT 1 FROM "erp_finance__document_title" d WHERE d.title_id=t.id)
               AND NOT EXISTS(SELECT 1 FROM "erp_finance__origin_import_origin" o WHERE o.title_id=t.id)`,
            id, fromId, scope, from.recurrence_on,
          )
          .rows.sort((x, y) => cmpText(String(x.id), String(y.id)));
        for (const t of rows) {
          const fresh = one(db, 'SELECT * FROM "erp_finance__title" WHERE id=?', t.id)!;
          updateTitle(ctx, String(t.id), { ...apply(fresh), version: Number(fresh.version) + 1, updated_at: ctx.clock.next().toString() });
          count++;
        }
      }
      if (field(data, "future") === true) writeRow(ctx, "erp_finance__recurrence", "id", id, apply(rec));
      bump();
      result = { entity: "recurrences", record: recurrenceView(db, id), updated_titles: count };
    }
  }

  requireAccess(db, user, true);
  result = { ...result, action, data_mode: "erp_native", replayed: false };
  insertCommand(ctx, command, user, hash, result);
  insertAudit(ctx, user, command, action, before, result);
  flushDeferred(ctx);
  return result;
}

export function erpFinanceRecurrenceGet(ctx: RpcContext, a: RpcArgs) {
  requireAccess(ctx.db, uuidArg(a.p_user_id)!, false);
  const id = uuidArg(a.p_id);
  const v = id === null ? null : recurrenceView(ctx.db, id);
  if (v === null) raise("P0002", "erp_finance_not_found");
  return { entity: "recurrences", record: v, data_mode: "erp_native" };
}

export function erpFinanceRecurrencePage(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const kind = (a.p_kind as string | null) ?? null;
  const active = (a.p_active as boolean | null) ?? null;
  const query = (a.p_query as string | null) ?? null;
  const page = (a.p_page as number | null) ?? null;
  const limit = (a.p_limit as number | null) ?? null;
  const needle = query === null || btrim(query) === "" ? null : pgLower(btrim(query));
  requireAccess(db, user, false);
  if (
    kind === null || !["receivable", "payable"].includes(kind) || page === null || page < 1 || page > 100000 || limit === null || limit < 1 || limit > 100 ||
    (query !== null && (charLength(query) > 120 || CNTRL.test(query)))
  )
    raise("22023", "erp_finance_invalid_query");
  const rows = db
    .exec(
      `SELECT r.id, r.created_at, r.active, r.description, c.name FROM "erp_finance__recurrence" r JOIN "erp_catalog__record" c ON c.id=r.contact_id WHERE r.kind=?`,
      kind,
    )
    .rows.filter(
      (r) =>
        (active === null || bool(r.active) === active) &&
        (needle === null || pgLower([r.name, r.description].filter((x) => x !== null).join(" ")).includes(needle)),
    )
    .sort((x, y) => Number(y.created_at) - Number(x.created_at) || cmpText(String(x.id), String(y.id)));
  return {
    entity: "recurrences", kind, active, page, limit, total: rows.length,
    items: rows.slice((page - 1) * limit, (page - 1) * limit + limit).map((r) => recurrenceView(db, String(r.id))),
    data_mode: "erp_native",
  };
}

registerRpc("erp_finance_recurrence_execute", erpFinanceRecurrenceExecute);
registerRpc("erp_finance_recurrence_get", erpFinanceRecurrenceGet);
registerRpc("erp_finance_recurrence_page", erpFinanceRecurrencePage);
