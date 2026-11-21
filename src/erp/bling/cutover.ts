/** Fatia C, o corte: a pessoa escolhe a data a partir da qual o ERP passa a
 * valer e fecha a passagem do Bling, etapa por etapa.
 *
 * Mesmo mecanismo da adoção (B1 e B2): vínculo por (entidade, id no Bling),
 * pendências com as duas versões, recibo de comando, e toda escrita no ERP
 * pelas RPCs das telas (erp_finance_title_execute, erp_finance_cash_execute,
 * erp_stock_post). Esta camada só grava as próprias tabelas (versão 15) e os
 * vínculos da adoção. Nada é escrito no Bling. */
import { createHash } from "node:crypto";
import { formatScaled, fromColumn, toScaled } from "../engine/dec.ts";
import type { Row, SqlDriver } from "../engine/driver.ts";
import { invokeRpc, type RpcContext } from "../engine/registry.ts";
import { todaySaoPaulo } from "../engine/time.ts";
import { projectPeople } from "../domains/access/identity.ts";
import { negativeAllowed } from "../domains/stock/internal.ts";
import { ERP_PART_MODULES, ERP_PART_NAMES, type ErpPartKey, type ErpParts } from "../parts.ts";
import {
  BLING_ADOPTION_LABELS, BLING_ADOPTION_REASONS, BLING_ADOPTION_SINGULAR, BLING_ADOPTION_UPDATABLE, BlingAdoptionError, isAdoptionB2,
  type BlingAdoptionAccountEntity, type BlingAdoptionEntity, type BlingAdoptionOperationMap, type BlingAdoptionReason, type BlingAdoptionRecordEntity,
} from "./adoption-contracts.ts";
import {
  BLING_CUTOVER_TEXTS,
  type BlingCutoverBalance, type BlingCutoverConflict, type BlingCutoverDifference, type BlingCutoverInvoice, type BlingCutoverPartial,
  type BlingCutoverState, type BlingCutoverStatus, type BlingCutoverStockLine, type BlingCutoverWarehouse,
} from "./cutover-contracts.ts";
import { adoptionStatus, applyBlingUpdate, blingSummary, command, domainFailure, erpSummary, transaction, type AdoptionCall } from "./adoption.ts";
import { centsOf, classifyB2, dateOf, effectsOf, mapAccount, money } from "./adoption-documents.ts";
import { adoptionTables, archiveAvailable, at, clip, commandUuid, linkOf, object, readRaw, sourceOf, text, writeLink, type AdoptionRaw, type Json } from "./adoption-store.ts";
import { parseHistoricalPayload } from "./projection.ts";
import { verifiedXmlOf } from "./xml.ts";

type Map_<K extends keyof BlingAdoptionOperationMap> = BlingAdoptionOperationMap[K];
const ACCOUNTS: readonly BlingAdoptionAccountEntity[] = ["receivables", "payables"];
const iso = (v: unknown) => v === null || v === undefined ? null : new Date(Number(v)).toISOString();
const br = (day: string) => day.split("-").reverse().join("/");
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Data de corte e registro das etapas

interface CutoverRow { state: "confirmed" | "concluded"; cutover_on: string; confirmed_by: string; confirmed_at: number; concluded_at: number | null; revision: number }
function readCutover(db: SqlDriver): CutoverRow | null {
  const r = db.exec("SELECT state, cutover_on, confirmed_by, confirmed_at, concluded_at, revision FROM wb_bling_cutover WHERE id=1").rows[0];
  return r ? { state: r.state as CutoverRow["state"], cutover_on: String(r.cutover_on), confirmed_by: String(r.confirmed_by), confirmed_at: Number(r.confirmed_at),
    concluded_at: r.concluded_at == null ? null : Number(r.concluded_at), revision: Number(r.revision) } : null;
}
/** Alguma etapa já gravou no ERP: a data não muda mais. */
function anyPosted(db: SqlDriver): boolean {
  return db.exec(`SELECT 1 AS x FROM wb_bling_cutover_item WHERE (kind='partial' AND state='adopted') OR (kind='balance' AND state='posted') OR (kind='stock' AND state IN ('partial','posted')) LIMIT 1`).rows.length > 0;
}
export function publicCutover(db: SqlDriver): BlingCutoverState {
  const c = readCutover(db);
  if (!c) return { state: "none", cutover_on: null, confirmed_at: null, concluded_at: null, revision: "0", can_change_date: true };
  return { state: c.state, cutover_on: c.cutover_on, confirmed_at: iso(c.confirmed_at), concluded_at: iso(c.concluded_at), revision: String(c.revision),
    can_change_date: c.state === "confirmed" && !anyPosted(db) };
}
const NOT_CONFIRMED = "Confirme primeiro a data de corte em Receber dados do Bling → Passar a operar aqui. Sem ela nenhuma etapa do corte roda.";
/** Toda etapa exige a data confirmada; as que gravam no ERP, o corte ainda aberto. */
function requireCutover(db: SqlDriver, open = false): CutoverRow {
  const c = readCutover(db);
  if (!c) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", NOT_CONFIRMED);
  if (open && c.state === "concluded") throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "O corte já foi concluído. Ajustes daqui para a frente são feitos direto nas telas do ERP.");
  return c;
}
/** Frase da parte desligada: diz o que ligar. */
function partOff(parts: Readonly<ErpParts>, keys: ErpPartKey[], what: string): string | null {
  const off = keys.filter(key => !parts[key]);
  if (parts.customers && !off.length) return null;
  const names = (off.length ? off : ["customers" as ErpPartKey]).map(key => ERP_PART_NAMES[ERP_PART_MODULES[key]]);
  const spoken = names.length > 1 ? `${names.slice(0, -1).join(", ")} e ${names.at(-1)}` : names[0];
  return `Para ${what}, ligue ${names.length > 1 ? "os módulos" : "o módulo"} ${spoken} em Gestão → Módulos.`;
}
const STEP_PARTS: Record<string, { keys: ErpPartKey[]; what: string; label: string }> = {
  adoption: { keys: ["customers"], what: "adotar o que falta", label: "Adotar o que falta (cadastros, documentos e contas em aberto)" },
  partials: { keys: ["finance"], what: "levar as contas parciais e o resumo das pagas e canceladas", label: "Contas parciais, pagas e canceladas" },
  balances: { keys: ["finance"], what: "gravar os saldos de abertura das contas financeiras", label: "Saldos de abertura das contas financeiras" },
  stock: { keys: ["products", "stock"], what: "gravar o estoque de abertura", label: "Estoque de abertura" },
  invoices: { keys: ["fiscal"], what: "consultar as notas emitidas no Bling", label: "Notas emitidas no Bling (consulta no Fiscal)" },
  package: { keys: ["fiscal"], what: "gerar o pacote do contador", label: "Pacote do contador (XML por mês)" },
  report: { keys: ["customers"], what: "conferir e concluir o corte", label: "Conferência final e conclusão" },
};
function requireStep(call: Pick<AdoptionCall, "parts">, step: keyof typeof STEP_PARTS): void {
  const message = partOff(call.parts, STEP_PARTS[step].keys, STEP_PARTS[step].what);
  if (message) throw new BlingAdoptionError("BLING_ADOPTION_PART_DISABLED", message);
}

interface Item { state: string; data: Json; record_id: string | null; actor_id: string; updated_at: number }
function readItem(db: SqlDriver, kind: string, key: string): Item | null {
  const r = db.exec("SELECT state, data, record_id, actor_id, updated_at FROM wb_bling_cutover_item WHERE kind=? AND key=?", kind, key).rows[0];
  return r ? { state: String(r.state), data: JSON.parse(String(r.data)) as Json, record_id: r.record_id == null ? null : String(r.record_id), actor_id: String(r.actor_id), updated_at: Number(r.updated_at) } : null;
}
export function saveItem(db: SqlDriver, kind: string, key: string, state: string, data: Json, record: string | null, actor: string, now: number) {
  db.exec(`INSERT INTO wb_bling_cutover_item(kind,key,state,data,record_id,actor_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(kind,key) DO UPDATE SET state=excluded.state, data=excluded.data, record_id=excluded.record_id, actor_id=excluded.actor_id, updated_at=excluded.updated_at`,
    kind, key, state, JSON.stringify(data), record, actor, now, now);
}

/** Recibo de um comando feito em várias transações pequenas (um registro por
 * transação, como o lote da adoção): o trabalho é idempotente pela chave de
 * cada item; o recibo só guarda o resultado para repetir sem refazer. */
function chunkedCommand<T extends Json>(call: AdoptionCall, operation: string, commandId: string, run: () => T) {
  const actor = call.identity.actor!.user_id;
  const previous = call.db.exec("SELECT operation, actor_id, request_hash, result FROM wb_bling_adoption_command WHERE command_id=?", commandId).rows[0];
  if (previous) {
    if (previous.operation !== operation || previous.actor_id !== actor || previous.request_hash !== call.request_hash) throw new BlingAdoptionError("BLING_ADOPTION_COMMAND_CONFLICT");
    return { ...JSON.parse(String(previous.result)) as T, receipt: { command_id: commandId, operation, replayed: true } };
  }
  transaction(call.db, call.profile, ctx => projectPeople(ctx), { identity: call.identity, parts: call.parts });
  const result = run();
  call.db.transaction(() => call.db.exec("INSERT INTO wb_bling_adoption_command(command_id,operation,actor_id,request_hash,result,created_at) VALUES(?,?,?,?,?,?)",
    commandId, operation, actor, call.request_hash, JSON.stringify(result), call.now()));
  return { ...result, receipt: { command_id: commandId, operation, replayed: false } };
}

// ---------------------------------------------------------------------------
// Andamento e confirmação

export function cutoverStatus(call: AdoptionCall, input: Map_<"erp_bling_cutover_status">["input"]): BlingCutoverStatus {
  const db = call.db, parts = call.parts, today = todaySaoPaulo(call.now());
  const cutover = publicCutover(db);
  const proposed = input.cutover_on ?? cutover.cutover_on;
  const adoption = adoptionStatus(call);
  const missing = adoption.entities.filter(e => e.waiting || e.pending || e.ignored)
    .map(e => ({ entity: e.entity, label: e.label, enabled: e.enabled, part_off_message: e.part_off_message, waiting: e.waiting, pending: e.pending, ignored: e.ignored }));
  const waiting = adoption.entities.filter(e => e.enabled).reduce((s, e) => s + e.waiting, 0);
  const pendingReviews = adoption.entities.filter(e => e.enabled).reduce((s, e) => s + e.pending, 0);
  const confirmed = cutover.state !== "none";
  const partials = confirmed && parts.finance ? partialCounts(db) : null;
  const balances = confirmed && parts.finance ? balanceRows(db, cutover.cutover_on!) : null;
  // Andamento barato: depósitos observados × depósitos gravados (a prévia completa fica na etapa).
  const stock = confirmed && parts.stock && parts.products ? db.exec(`SELECT DISTINCT CAST(json_extract(d.value,'$.id') AS TEXT) AS w FROM origin_sync__raw_record r, json_each(r.payload,'$.depositos') d
      WHERE r.entity='stock_balances' AND json_valid(r.payload)`).rows.map(r => ({ state: readItem(db, "stock", String(r.w))?.state === "posted" ? "posted" : "waiting" })) : null;
  const packages = db.exec("SELECT count(*) AS n FROM wb_bling_cutover_item WHERE kind='package' AND state='done'").rows[0]?.n ?? 0;
  const invoices = Number(db.exec("SELECT count(*) AS n FROM origin_sync__raw_record WHERE entity IN ('nfe','nfce')").rows[0]?.n ?? 0);
  const summaries: Record<string, { done: boolean; summary: string }> = {
    adoption: { done: waiting === 0 && pendingReviews === 0, summary: waiting || pendingReviews ? `${waiting} registro(s) aguardando a adoção e ${pendingReviews} pendência(s) de revisão.` : "Nada aguardando nem pendente na adoção." },
    partials: partials ? { done: partials.every(p => !p.waiting && !p.pending), summary: partials.map(p => `${BLING_ADOPTION_LABELS[p.entity]}: ${p.adopted} parcial(is) adotada(s), ${p.waiting} aguardando, ${p.pending} pendente(s)`).join("; ") + "." }
      : { done: false, summary: confirmed ? "Ligue o Financeiro para esta etapa." : "Depois da confirmação da data." },
    balances: balances ? { done: balances.length > 0 && balances.every(b => b.state === "posted"), summary: balances.length ? `${balances.filter(b => b.state === "posted").length} de ${balances.length} conta(s) com saldo de abertura gravado.` : "Nenhuma conta financeira adotada do Bling." }
      : { done: false, summary: confirmed ? "Ligue o Financeiro para esta etapa." : "Depois da confirmação da data." },
    stock: stock ? { done: stock.length > 0 && stock.every(w => w.state === "posted"), summary: stock.length ? `${stock.filter(w => w.state === "posted").length} de ${stock.length} depósito(s) com estoque de abertura gravado.` : "Nenhum saldo de estoque coletado do Bling." }
      : { done: false, summary: confirmed ? "Ligue Produtos e serviços e Estoque para esta etapa." : "Depois da confirmação da data." },
    invoices: { done: confirmed, summary: `${invoices} nota(s) emitida(s) no Bling no acervo, para consulta no Fiscal.` },
    package: { done: Number(packages) > 0, summary: `${packages} pacote(s) mensal(is) pronto(s) para o contador.` },
    report: { done: cutover.state === "concluded", summary: cutover.state === "concluded" ? "Corte concluído." : "Confira as diferenças e conclua quando estiver tudo resolvido ou justificado." },
  };
  const steps = (Object.keys(STEP_PARTS) as (keyof typeof STEP_PARTS)[]).map(key => {
    const off = partOff(parts, STEP_PARTS[key].keys, STEP_PARTS[key].what);
    const lastKey = STEP_PARTS[key].keys.at(-1)!;
    return { key: key as BlingCutoverStatus["steps"][number]["key"], label: STEP_PARTS[key].label, module_name: ERP_PART_NAMES[ERP_PART_MODULES[lastKey]],
      enabled: !off, part_off_message: off, done: summaries[key].done, summary: clip(summaries[key].summary, 300)! };
  });
  const running = db.exec("SELECT 1 AS x FROM wb_bling_adoption_job WHERE id=1 AND state='running'").rows.length > 0;
  const checks = [
    { key: "archive", label: "Acervo do Bling disponível", ok: adoption.available, message: adoption.available ? "Conta vinculada e acervo disponível." : adoption.unavailable_message ?? "Acervo indisponível." },
    { key: "date", label: "Data de corte escolhida", ok: !!proposed && proposed <= today,
      message: !proposed ? "Escolha a data de corte." : proposed > today ? "A data de corte não pode estar no futuro: escolha hoje ou um dia que já passou." : `A partir de ${br(proposed)} o ERP passa a valer.` },
    { key: "job", label: "Lote de adoção parado", ok: !running, message: running ? "O lote de adoção ainda está rodando. Espere terminar ou pause antes de confirmar." : "Nenhum lote de adoção rodando." },
    { key: "waiting", label: "Tudo coletado já passou pela adoção", ok: waiting === 0, message: waiting ? `${waiting} registro(s) ainda não passaram pela adoção. Rode a adoção em Adotar cadastros (pode ser depois de confirmar).` : "Nada aguardando a adoção." },
    { key: "pending", label: "Pendências de revisão decididas", ok: pendingReviews === 0, message: pendingReviews ? `${pendingReviews} pendência(s) de revisão. Decida em Adotar cadastros; o que ficar sem decisão aparece na conferência final.` : "Nenhuma pendência de revisão." },
    { key: "account", label: "Conta do Bling continua viva", ok: true, message: "A coleta continua depois do corte. Nada é escrito no Bling." },
  ];
  return { cutover, proposed_on: proposed ?? null, today, missing: missing.slice(0, 20), steps, checks, conflicts: conflictCount(db), texts: { ...BLING_CUTOVER_TEXTS } };
}

export function cutoverConfirm(call: AdoptionCall, input: Map_<"erp_bling_cutover_confirm">["input"]) {
  return command(call, "erp_bling_cutover_confirm", input.command_id, ctx => {
    const db = ctx.db, now = call.now(), today = todaySaoPaulo(now), actor = call.identity.actor!.user_id;
    if (!archiveAvailable(db)) throw new BlingAdoptionError("BLING_ADOPTION_UNAVAILABLE");
    if (input.cutover_on > today) throw new BlingAdoptionError("BLING_ADOPTION_INVALID", "A data de corte não pode estar no futuro: escolha hoje ou um dia que já passou.");
    if (db.exec("SELECT 1 AS x FROM wb_bling_adoption_job WHERE id=1 AND state='running'").rows.length) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "O lote de adoção ainda está rodando. Espere terminar ou pause antes de confirmar a data de corte.");
    const current = readCutover(db);
    if (current?.state === "concluded") throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "O corte já foi concluído; a data não muda mais.");
    if (current && current.cutover_on !== input.cutover_on && anyPosted(db))
      throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", `A data de corte ${br(current.cutover_on)} já foi usada para gravar contas, saldos ou estoque. Ela não muda mais.`);
    if (current?.cutover_on === input.cutover_on) return { cutover: publicCutover(db) };
    db.exec(`INSERT INTO wb_bling_cutover(id,state,cutover_on,confirmed_by,confirmed_at,revision,updated_at) VALUES(1,'confirmed',?,?,?,1,?)
      ON CONFLICT(id) DO UPDATE SET cutover_on=excluded.cutover_on, confirmed_by=excluded.confirmed_by, confirmed_at=excluded.confirmed_at, revision=wb_bling_cutover.revision+1, updated_at=excluded.updated_at`,
      input.cutover_on, actor, now, now);
    return { cutover: publicCutover(db) };
  });
}

// ---------------------------------------------------------------------------
// Contas: parciais pelo saldo; pagas e canceladas no resumo

const partialKey = (entity: string, source: string) => `${entity}:${source}`;
function partialCounts(db: SqlDriver) {
  return ACCOUNTS.map(entity => {
    const rows = db.exec(`SELECT h.source_id, r.version, h.total_cents, c.state AS item_state, json_extract(c.data,'$.version') AS item_version
      FROM wb_bling_adoption_history h JOIN origin_sync__raw_record r ON r.entity=h.entity AND r.source_id=h.source_id
      LEFT JOIN wb_bling_cutover_item c ON c.kind='partial' AND c.key=h.entity||':'||h.source_id
      WHERE h.entity=? AND h.scope='partial'`, entity).rows;
    const adopted = Number(db.exec("SELECT count(*) AS n FROM wb_bling_cutover_item WHERE kind='partial' AND state='adopted' AND key LIKE ?", entity + ":%").rows[0]?.n ?? 0);
    let pending = 0, waiting = 0, balance = 0n;
    for (const r of rows) {
      if (r.item_state === "pending" && Number(r.item_version) === Number(r.version)) pending++; else waiting++;
      const raw = readRaw(db, entity, String(r.source_id));
      const b = raw ? centsOf(raw.payload.saldo) : null;
      if (typeof b === "bigint" && b > 0n) balance += b;
    }
    return { entity, count: rows.length + adopted, balance_cents: balance.toString(), adopted, pending, waiting };
  });
}

/** Uma conta parcial: título do ERP pelo saldo que falta, sem recriar baixas. */
function adoptPartial(ctx: RpcContext, entity: BlingAdoptionAccountEntity, raw: AdoptionRaw, actor: string, now: number, cutoverOn: string): { outcome: "adopted" | "pending" | "skipped"; detail?: string; record?: string } {
  const db = ctx.db;
  if (linkOf(db, entity, raw.source_id)) return { outcome: "skipped" };
  const situation = classifyB2(entity, raw);
  if (situation.history !== "partial") return { outcome: "skipped" };
  const amount = centsOf(raw.payload.valor), balance = centsOf(raw.payload.saldo);
  if (typeof amount !== "bigint" || typeof balance !== "bigint" || balance <= 0n || balance > amount)
    return { outcome: "pending", detail: `O saldo no Bling não fecha com o valor (valor ${typeof amount === "bigint" ? money(amount) : "inválido"}, saldo ${typeof balance === "bigint" ? money(balance) : "inválido"}). Ajuste no Bling ou crie a conta à mão no ERP e justifique na conferência.` };
  const m = mapAccount(db, entity, raw);
  if (m.missing.length) return { outcome: "pending", detail: clip(`${BLING_ADOPTION_REASONS.missing_records} Falta: ${m.missing.map(x => `${BLING_ADOPTION_SINGULAR[x.entity]} ${x.label ?? ""} (id ${x.source_id})`.replace(/\s+/g, " ")).join("; ")}.`, 300)! };
  if (m.blocked) return { outcome: "pending", detail: m.blocked.detail };
  const paid = amount - balance;
  const due = (m.data.installments as Json[])[0]?.due_on ?? null;
  const description = clip(`${String(m.data.description)} | Saldo na data de corte ${br(cutoverOn)}: valor original ${money(amount)}, já pago no Bling ${money(paid)} (Bling id ${raw.source_id}).`, 2000);
  const data: Json = { ...m.data, description, total_cents: balance.toString(), installments: [{ amount_cents: balance.toString(), due_on: due }] };
  const result = invokeRpc(ctx, "erp_finance_title_execute", { p_user_id: actor, p_command_id: commandUuid("bling-cutover-partial", entity, raw.source_id, String(raw.version)), p_action: "title_create", p_data: data });
  const created = at(result, "items"), id = Array.isArray(created) ? text(at(created[0], "id")) : null;
  if (!id) throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", "O ERP não devolveu a conta criada.");
  const effect = effectsOf(db, entity, id);
  if (effect) throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", `Adotar agora geraria efeitos no ERP; nada foi criado. Motivo: ${effect}.`);
  writeLink(db, entity, raw, id, "created", actor, now);
  db.exec("DELETE FROM wb_bling_adoption_history WHERE entity=? AND source_id=?", entity, raw.source_id);
  saveItem(db, "partial", partialKey(entity, raw.source_id), "adopted", { version: raw.version, amount_cents: amount.toString(), paid_cents: paid.toString(), balance_cents: balance.toString() }, id, actor, now);
  return { outcome: "adopted", record: id };
}

export const CUTOVER_UNIT = Object.freeze({ records: 40, wall_ms: 1500 });
export function cutoverPartialsAdopt(call: AdoptionCall, input: Map_<"erp_bling_cutover_partials_adopt">["input"]) {
  const db = call.db, actor = call.identity.actor!.user_id;
  requireStep(call, "partials");
  const cut = requireCutover(db, true);
  if (!archiveAvailable(db)) throw new BlingAdoptionError("BLING_ADOPTION_UNAVAILABLE");
  return chunkedCommand(call, "erp_bling_cutover_partials_adopt", input.command_id, () => {
    const started = call.now();
    let processed = 0, adopted = 0, pending = 0;
    const candidates = () => db.exec(`SELECT h.entity, h.source_id FROM wb_bling_adoption_history h JOIN origin_sync__raw_record r ON r.entity=h.entity AND r.source_id=h.source_id
      WHERE h.entity IN ('receivables','payables') AND h.scope='partial'
        AND NOT EXISTS(SELECT 1 FROM wb_bling_cutover_item c WHERE c.kind='partial' AND c.key=h.entity||':'||h.source_id AND c.state='pending' AND json_extract(c.data,'$.version')=r.version)
      ORDER BY h.entity, length(h.source_id), h.source_id LIMIT ?`, CUTOVER_UNIT.records + 1).rows;
    for (const row of candidates().slice(0, CUTOVER_UNIT.records)) {
      if (call.now() - started > CUTOVER_UNIT.wall_ms) break;
      const entity = String(row.entity) as BlingAdoptionAccountEntity, source = String(row.source_id), now = call.now();
      processed++;
      try {
        const outcome = transaction(db, call.profile, ctx => {
          const raw = readRaw(db, entity, source);
          if (!raw) return { outcome: "skipped" as const };
          const result = adoptPartial(ctx, entity, raw, actor, now, cut.cutover_on);
          if (result.outcome === "pending") saveItem(db, "partial", partialKey(entity, source), "pending", { version: raw.version, detail: result.detail ?? null }, null, actor, now);
          return result;
        }, { identity: call.identity, parts: call.parts });
        if (outcome.outcome === "adopted") adopted++;
        else if (outcome.outcome === "pending") pending++;
      } catch (error) {
        const failure = domainFailure(error);
        if (failure.stop === "permission") throw new BlingAdoptionError("BLING_ADOPTION_ADMIN_REQUIRED");
        db.transaction(() => {
          const raw = readRaw(db, entity, source);
          if (raw) saveItem(db, "partial", partialKey(entity, source), "pending", { version: raw.version, detail: clip([BLING_ADOPTION_REASONS[failure.reason as BlingAdoptionReason], failure.detail].filter(Boolean).join(" "), 300) }, null, actor, now);
        });
        pending++;
      }
    }
    const remaining = candidates().length;
    return { processed, adopted, pending, remaining };
  });
}

export function cutoverPartials(call: AdoptionCall, input: Map_<"erp_bling_cutover_partials">["input"]): Map_<"erp_bling_cutover_partials">["output"] {
  requireStep(call, "partials"); requireCutover(call.db);
  const db = call.db, limit = input.limit ?? 20, entity = input.entity;
  // Parciais ainda no histórico mais as já adotadas (que saíram dele).
  const rows = db.exec(`SELECT source_id, item_state, item_data, record_id FROM (
      SELECT h.source_id, c.state AS item_state, c.data AS item_data, c.record_id FROM wb_bling_adoption_history h
        JOIN origin_sync__raw_record r ON r.entity=h.entity AND r.source_id=h.source_id
        LEFT JOIN wb_bling_cutover_item c ON c.kind='partial' AND c.key=h.entity||':'||h.source_id
        WHERE h.entity=? AND h.scope='partial'
      UNION ALL
      SELECT substr(c.key, length(?)+2) AS source_id, c.state, c.data, c.record_id FROM wb_bling_cutover_item c WHERE c.kind='partial' AND c.state='adopted' AND c.key LIKE ?)
    WHERE (? IS NULL OR length(source_id)>length(?) OR (length(source_id)=length(?) AND source_id>?))
    ORDER BY length(source_id), source_id`, entity, entity, entity + ":%", input.cursor ?? null, input.cursor ?? null, input.cursor ?? null, input.cursor ?? null).rows;
  const items: BlingCutoverPartial[] = [];
  let next: string | null = null;
  for (const r of rows) {
    const raw = readRaw(db, entity, String(r.source_id));
    const data = r.item_data ? JSON.parse(String(r.item_data)) as Json : {};
    const state: BlingCutoverPartial["state"] = r.item_state === "adopted" ? "adopted" : r.item_state === "pending" && raw && Number(data.version) === raw.version ? "pending" : "waiting";
    if (input.state && input.state !== state) continue;
    if (items.length === limit) { next = items[items.length - 1].source_id; break; }
    const p = raw?.payload ?? {};
    const amount = centsOf(p.valor), balance = centsOf(p.saldo);
    items.push({ entity, source_id: String(r.source_id), number: clip(text(p.numeroDocumento), 150), contact_name: clip(text(at(p.contato, "nome")), 200), due_on: dateOf(p.vencimento),
      amount_cents: typeof amount === "bigint" ? amount.toString() : (text(data.amount_cents) ?? null), balance_cents: typeof balance === "bigint" ? balance.toString() : (text(data.balance_cents) ?? null),
      paid_cents: typeof amount === "bigint" && typeof balance === "bigint" ? (amount - balance).toString() : (text(data.paid_cents) ?? null),
      state, detail: state === "pending" ? clip(text(data.detail), 300) : null, record_id: r.record_id == null ? null : String(r.record_id) });
  }
  return { items, next_cursor: next };
}

const SUMMARY_SCOPES = ["paid", "cancelled", "returned", "other"] as const;
type SummaryScope = typeof SUMMARY_SCOPES[number];
function categoryName(db: SqlDriver, source: string | null, cache: Map<string, string>): string {
  if (!source) return "Sem categoria";
  const cached = cache.get(source);
  if (cached) return cached;
  const link = linkOf(db, "financial_categories", source);
  const name = link ? text(db.exec("SELECT name FROM erp_finance__category WHERE id=?", link.record_id).rows[0]?.name) : null;
  const raw = name ? null : readRaw(db, "financial_categories", source);
  const label = clip(name ?? (text(raw?.payload.descricao) ? `${text(raw!.payload.descricao)} (ainda não adotada)` : `Categoria do Bling id ${source} (não coletada)`), 200)!;
  cache.set(source, label);
  return label;
}
/** Situação, valor e saldo de cada conta direto do acervo (sem o histórico). */
function accountScan(db: SqlDriver, entity: BlingAdoptionAccountEntity): { source_id: string; scope: string; amount: bigint | null; balance: bigint | null }[] {
  const rows = db.exec(`SELECT r.source_id, json_extract(r.payload,'$.situacao') AS situacao, CAST(json_extract(r.payload,'$.valor') AS TEXT) AS valor,
      CAST(json_extract(r.payload,'$.saldo') AS TEXT) AS saldo,
      CASE WHEN json_type(r.payload,'$._brufap_source.deleted')='true' OR coalesce(m.deleted_observed,0)=1 THEN 1 ELSE 0 END AS deleted
    FROM origin_sync__raw_record r LEFT JOIN wb_bling_record_version m ON m.entity=r.entity AND m.source_id=r.source_id AND m.version=r.version WHERE r.entity=?`, entity).rows;
  return rows.map(r => {
    let situacao: unknown = r.situacao;
    if (typeof situacao === "string" && situacao.startsWith("{")) { try { situacao = JSON.parse(situacao); } catch { /* fica como texto */ } }
    const raw: AdoptionRaw = { source_id: String(r.source_id), version: 1, hash: "", deleted: Number(r.deleted) === 1, payload: { situacao, valor: r.valor, saldo: r.saldo } };
    const c = classifyB2(entity, raw), amount = centsOf(r.valor), balance = centsOf(r.saldo);
    return { source_id: String(r.source_id), scope: c.scope === "open" ? "open" : c.scope === "unknown" ? "unknown" : c.history ?? "other",
      amount: typeof amount === "bigint" ? amount : null, balance: typeof balance === "bigint" ? balance : null };
  });
}
export function cutoverAccountsSummary(call: AdoptionCall): Map_<"erp_bling_cutover_accounts_summary">["output"] {
  requireStep(call, "partials"); requireCutover(call.db);
  const db = call.db, cache = new Map<string, string>();
  const grouped = db.exec(`SELECT h.entity, h.scope, substr(h.issued_on,1,7) AS month, CAST(json_extract(r.payload,'$.categoria.id') AS TEXT) AS category, count(*) AS n, coalesce(sum(h.total_cents),0) AS total
      FROM wb_bling_adoption_history h JOIN origin_sync__raw_record r ON r.entity=h.entity AND r.source_id=h.source_id
      WHERE h.entity IN ('receivables','payables') AND h.scope IN ('paid','cancelled','returned','other')
      GROUP BY h.entity, h.scope, month, category ORDER BY h.entity, month DESC, category`).rows;
  const truncated = grouped.length > 3000;
  const totals = new Map<string, { count: number; total: bigint }>();
  const rows = grouped.map(r => {
    const key = `${r.entity}:${r.scope}`, current = totals.get(key) ?? { count: 0, total: 0n };
    current.count += Number(r.n); current.total += BigInt(String(r.total)); totals.set(key, current);
    return { entity: r.entity as BlingAdoptionAccountEntity, month: r.month == null ? null : String(r.month), category: categoryName(db, sourceOf(r.category), cache), scope: r.scope as SummaryScope, count: Number(r.n), total_cents: String(r.total) };
  }).slice(0, 3000);
  const acervo = new Map<string, { count: number; total: bigint }>();
  for (const entity of ACCOUNTS) for (const item of accountScan(db, entity)) {
    if (!(SUMMARY_SCOPES as readonly string[]).includes(item.scope)) continue;
    const key = `${entity}:${item.scope}`, current = acervo.get(key) ?? { count: 0, total: 0n };
    current.count++; current.total += item.amount ?? 0n; acervo.set(key, current);
  }
  const list = (source: Map<string, { count: number; total: bigint }>) => ACCOUNTS.flatMap(entity => SUMMARY_SCOPES.map(scope => {
    const v = source.get(`${entity}:${scope}`) ?? { count: 0, total: 0n };
    return { entity, scope, count: v.count, total_cents: v.total.toString() };
  }));
  const a = list(totals), b = list(acervo);
  return { rows, totals: a, acervo: b, matches: a.every((item, index) => item.count === b[index].count && item.total_cents === b[index].total_cents), truncated, partials: partialCounts(db) };
}

// ---------------------------------------------------------------------------
// Saldos de abertura das contas financeiras

const DEBIT = /^(d|s|-|deb|debito|débito|saida|saída|1)$/i, CREDIT = /^(c|e|\+|cred|credito|crédito|entrada|2)$/i;
/** Soma dos lançamentos de caixa coletados até a data, por conta do Bling. */
function cashTotals(db: SqlDriver, cutoverOn: string): Map<string, { cents: bigint; entries: number; unknown: number }> {
  const rows = db.exec(`SELECT CAST(json_extract(r.payload,'$.valor') AS TEXT) AS valor, substr(json_extract(r.payload,'$.data'),1,10) AS dia,
      CAST(coalesce(json_extract(r.payload,'$.contaFinanceira.id'), json_extract(r.payload,'$.portador.id'), json_extract(r.payload,'$.conta.id')) AS TEXT) AS conta,
      CAST(coalesce(json_extract(r.payload,'$.debitoCredito'), json_extract(r.payload,'$.tipoLancamento'), json_extract(r.payload,'$.tipo')) AS TEXT) AS sinal,
      CAST(coalesce(json_extract(r.payload,'$.situacao.valor'), json_extract(r.payload,'$.situacao.id'), json_extract(r.payload,'$.situacao')) AS TEXT) AS situacao,
      CASE WHEN json_type(r.payload,'$._brufap_source.deleted')='true' OR coalesce(m.deleted_observed,0)=1 THEN 1 ELSE 0 END AS deleted
    FROM origin_sync__raw_record r LEFT JOIN wb_bling_record_version m ON m.entity=r.entity AND m.source_id=r.source_id AND m.version=r.version WHERE r.entity='cash_entries'`).rows;
  const totals = new Map<string, { cents: bigint; entries: number; unknown: number }>();
  for (const r of rows) {
    const account = sourceOf(r.conta), day = dateOf(r.dia);
    if (!account || !day || day > cutoverOn || Number(r.deleted) === 1 || String(r.situacao ?? "").toUpperCase() === "E") continue;
    const value = centsOf(r.valor), sign = text(r.sinal);
    const t = totals.get(account) ?? { cents: 0n, entries: 0, unknown: 0 };
    t.entries++;
    if (typeof value !== "bigint") t.unknown++;
    else if (sign && DEBIT.test(sign)) t.cents -= value < 0n ? -value : value;
    else if (sign && CREDIT.test(sign)) t.cents += value < 0n ? -value : value;
    else if (value < 0n) t.cents += value;
    else t.unknown++;
    totals.set(account, t);
  }
  return totals;
}
const erpBalanceAt = (db: SqlDriver, account: string, day: string) =>
  BigInt(String(db.exec('SELECT coalesce(sum(delta_cents),0) AS b FROM "erp_finance__movement" WHERE account_id=? AND posted_on<=?', account, day).rows[0]?.b ?? 0));
function balanceRows(db: SqlDriver, cutoverOn: string): BlingCutoverBalance[] {
  const totals = cashTotals(db, cutoverOn);
  const links = db.exec("SELECT source_id, record_id FROM wb_bling_adoption_link WHERE entity='ledger_accounts' ORDER BY length(source_id), source_id LIMIT 500").rows;
  return links.map(link => {
    const source = String(link.source_id), record = String(link.record_id), t = totals.get(source), item = readItem(db, "balance", source);
    const name = text(db.exec("SELECT name FROM erp_finance__account WHERE id=?", record).rows[0]?.name);
    const computed = t && !t.unknown ? t.cents.toString() : null;
    const note = !t ? "Não há lançamentos de caixa coletados desta conta até a data de corte: informe o saldo do Bling nesse dia."
      : t.unknown ? `${t.unknown} de ${t.entries} lançamento(s) sem valor ou sem indicação de entrada ou saída: confira o saldo no Bling e informe.`
      : `Somados ${t.entries} lançamento(s) de caixa coletados até a data de corte. Confira com o extrato do Bling.`;
    const posted = item?.state === "posted";
    return { source_id: source, record_id: record, name: clip(name, 200), computed_cents: computed, computed_entries: t?.entries ?? 0, computed_note: note,
      erp_cents_at_cutover: erpBalanceAt(db, record, cutoverOn).toString(), state: posted ? "posted" : "waiting",
      posted_cents: posted ? text(item!.data.confirmed_cents) : null, entry_cents: posted ? text(item!.data.entry_cents) : null,
      posted_on: posted ? text(item!.data.posted_on) : null, posted_at: posted ? iso(item!.updated_at) : null };
  });
}
export function cutoverBalances(call: AdoptionCall): Map_<"erp_bling_cutover_balances">["output"] {
  requireStep(call, "balances");
  const cut = requireCutover(call.db);
  return { cutover_on: cut.cutover_on, items: balanceRows(call.db, cut.cutover_on) };
}
export function cutoverBalancePost(call: AdoptionCall, input: Map_<"erp_bling_cutover_balance_post">["input"]) {
  requireStep(call, "balances");
  return command(call, "erp_bling_cutover_balance_post", input.command_id, ctx => {
    const db = ctx.db, cut = requireCutover(db, true), actor = call.identity.actor!.user_id, now = call.now();
    const link = linkOf(db, "ledger_accounts", input.source_id);
    if (!link) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND", "Esta conta financeira ainda não foi adotada do Bling. Adote em Adotar cadastros e volte aqui.");
    const done = readItem(db, "balance", input.source_id);
    if (done?.state === "posted") {
      if (done.data.confirmed_cents !== input.confirmed_cents) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", `O saldo de abertura desta conta já foi gravado (${money(BigInt(String(done.data.confirmed_cents)))}). Para corrigir, use Ajustar saldo no Financeiro.`);
      return { item: balanceRows(db, cut.cutover_on).find(b => b.source_id === input.source_id)! };
    }
    const current = balanceRows(db, cut.cutover_on).find(b => b.source_id === input.source_id)!;
    if (current.computed_cents !== input.computed_cents) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "O saldo calculado do Bling mudou desde que você conferiu (nova coleta). Atualize a tela e confira de novo.");
    const confirmed = BigInt(input.confirmed_cents);
    if (confirmed > 999999999999999n || confirmed < -999999999999999n) throw new BlingAdoptionError("BLING_ADOPTION_INVALID", "O saldo informado passa do limite do ERP.");
    // O lançamento não pode ficar antes do saldo inicial da conta no ERP.
    const opening = text(db.exec(`SELECT max(posted_on) AS d FROM "erp_finance__movement" WHERE account_id=? AND kind='opening'`, link.record_id).rows[0]?.d);
    const postedOn = opening && opening > cut.cutover_on ? opening : cut.cutover_on;
    const before = erpBalanceAt(db, link.record_id, postedOn), delta = confirmed - before;
    let entry: string | null = null;
    if (delta !== 0n) {
      const result = invokeRpc(ctx, "erp_finance_cash_execute", { p_user_id: actor, p_command_id: commandUuid("bling-cutover-balance", input.source_id, cut.cutover_on), p_action: "entry_save",
        p_data: { expected_version: 0, account_id: link.record_id, kind: delta > 0n ? "in" : "out", amount_cents: (delta > 0n ? delta : -delta).toString(), posted_on: postedOn, competence_on: postedOn,
          category_id: null, contact_id: null, note: `Saldo de abertura vindo do Bling (data de corte ${br(cut.cutover_on)})`, origin: "manual" } });
      entry = text(at(result, "record", "id"));
    }
    saveItem(db, "balance", input.source_id, "posted", { confirmed_cents: confirmed.toString(), computed_cents: input.computed_cents, erp_before_cents: before.toString(),
      entry_cents: delta.toString(), posted_on: postedOn, entry_id: entry, corrected: input.computed_cents !== null && input.computed_cents !== confirmed.toString() }, link.record_id, actor, now);
    return { item: balanceRows(db, cut.cutover_on).find(b => b.source_id === input.source_id)! };
  });
}

// ---------------------------------------------------------------------------
// Estoque de abertura

interface StockLinePlan { product: string; target: string | null; cost: string | null }
const QTY = /^-?(0|[1-9]\d{0,11})(\.\d{1,6})?$/;
/** Saldo observado no Bling por depósito: produto → quantidade (texto exato). */
function stockObserved(db: SqlDriver): Map<string, StockLinePlan[]> {
  const byWarehouse = new Map<string, StockLinePlan[]>();
  const rows = db.exec("SELECT source_id, payload FROM origin_sync__raw_record WHERE entity='stock_balances' ORDER BY length(source_id), source_id").rows;
  for (const r of rows) {
    let payload: Json;
    try { payload = parseHistoricalPayload(String(r.payload)).payload as Json; } catch { continue; }
    if (json_deleted(payload)) continue;
    const deposits = Array.isArray(payload.depositos) ? payload.depositos.filter(object) : [];
    for (const d of deposits) {
      const warehouse = sourceOf(d.id);
      if (!warehouse) continue;
      // Saldo ausente não vira zero.
      const target = text(d.saldoFisico ?? d.saldo);
      const list = byWarehouse.get(warehouse) ?? [];
      list.push({ product: String(r.source_id), target, cost: null });
      byWarehouse.set(warehouse, list);
    }
  }
  return byWarehouse;
}
const json_deleted = (p: Json) => at(p, "_brufap_source", "deleted") === true;
function productCost(db: SqlDriver, source: string): string | null {
  const raw = readRaw(db, "products", source);
  const cost = text(raw?.payload.precoCusto ?? at(raw?.payload, "fornecedor", "precoCusto") ?? at(raw?.payload, "estoque", "custoMedio"));
  return cost && /^(0|[1-9]\d{0,13})(\.\d+)?$/.test(cost) ? cost : null;
}
const valueCents = (quantity: string, cost: string) => {
  const v = toScaled(quantity, 6) * toScaled(cost, 6); // escala 12
  const cents = v / 10_000_000_000n, rest = v % 10_000_000_000n;
  return rest * 2n >= 10_000_000_000n ? cents + 1n : rest * 2n <= -10_000_000_000n ? cents - 1n : cents;
};
interface WarehousePlan { source: string; record: string | null; name: string | null; lines: (BlingCutoverStockLine & { version: number; postable: boolean })[]; hash: string }
function warehousePlan(db: SqlDriver, source: string, lines: StockLinePlan[], cutoverOn: string): WarehousePlan {
  const record = linkOf(db, "warehouses", source)?.record_id ?? null;
  const name = record ? text(db.exec("SELECT name FROM erp_catalog__record WHERE id=?", record).rows[0]?.name) : text(readRaw(db, "warehouses", source)?.payload.descricao);
  const negative = negativeAllowed(db);
  const item = readItem(db, "stock", source);
  const after = item ? text(item.data.after) : null;
  const done = (p: string) => after !== null && (p.length < after.length || (p.length === after.length && p <= after));
  const planned = lines.map(line => {
    const product = linkOf(db, "products", line.product)?.record_id ?? null;
    const row = product ? db.exec(`SELECT r.name, r.code, p.kind, p.format, p.unit FROM erp_catalog__record r JOIN erp_catalog__product p ON p.record_id=r.id WHERE r.id=?`, product).rows[0] : undefined;
    const bal = product && record ? db.exec('SELECT CAST(quantity AS TEXT) AS q, version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', product, record).rows[0] : undefined;
    const now = bal ? fromColumn(bal.q) : 0n;
    const cost = productCost(db, line.product);
    const base = { product_source_id: line.product, product_id: product, name: clip(text(row?.name) ?? text(readRaw(db, "products", line.product)?.payload.nome), 200),
      code: clip(text(row?.code), 100), target: line.target ?? "desconhecido", erp_now: product && record ? formatScaled(now, 6).replace(/\.?0+$/, "") || "0" : null,
      unit_cost: cost, version: bal ? Number(bal.version) : 0 };
    const skip = (issue: BlingCutoverStockLine["issue"], issue_text: string) => ({ ...base, delta: null, issue, issue_text, state: (done(line.product) ? "posted" : "skipped") as BlingCutoverStockLine["state"], postable: false });
    if (!line.target || !QTY.test(line.target)) return skip("invalid", "O saldo deste produto no Bling não veio ou não é um número válido. Saldo desconhecido não vira zero.");
    if (!record) return skip("no_warehouse", "O depósito ainda não foi adotado.");
    if (!product) return skip("no_product", "O produto ainda não foi adotado: adote em Adotar cadastros ou justifique.");
    if (row?.kind !== "P" || row?.format === "V" || row?.format === "E" || !row?.unit) return skip("unsupported", "Serviço, produto com variações ou composição: o ERP não lança estoque direto nele.");
    const target = toScaled(line.target, 6);
    if (target < 0n && !negative) return skip("negative", "Saldo negativo no Bling e o ERP não aceita estoque negativo (Preferências → Estoque).");
    const delta = target - now;
    return { ...base, delta: formatScaled(delta, 6).replace(/\.?0+$/, "") || "0", issue: target < 0n ? "negative" as const : now !== 0n && !done(line.product) ? "difference" as const : null,
      issue_text: target < 0n ? "Saldo negativo no Bling (o ERP aceita estoque negativo)." : now !== 0n && !done(line.product) ? "O ERP já tem saldo deste produto neste depósito: será ajustado para o saldo do Bling." : null,
      state: (done(line.product) ? "posted" : "waiting") as BlingCutoverStockLine["state"], postable: true };
  });
  const hash = sha(JSON.stringify([cutoverOn, source, lines.map(l => [l.product, l.target])]));
  return { source, record, name: clip(name, 200), lines: planned, hash };
}
function warehouseSummary(db: SqlDriver, plan: WarehousePlan): BlingCutoverWarehouse {
  const item = readItem(db, "stock", plan.source);
  let valued: bigint | null = null;
  for (const line of plan.lines) if (line.unit_cost && QTY.test(line.target) && line.issue !== "invalid") valued = (valued ?? 0n) + valueCents(line.target, line.unit_cost);
  const postable = plan.lines.filter(l => l.postable), remaining = postable.filter(l => l.state === "waiting").length;
  const state: BlingCutoverWarehouse["state"] = !plan.record ? "blocked" : item?.state === "posted" ? "posted" : item ? (remaining ? "partial" : "posted") : "waiting";
  return { source_id: plan.source, record_id: plan.record, name: plan.name, products: plan.lines.length, ready: postable.length,
    without_product: plan.lines.filter(l => l.issue === "no_product").length, negatives: plan.lines.filter(l => l.issue === "negative").length,
    differences: plan.lines.filter(l => l.issue === "difference").length, unsupported: plan.lines.filter(l => l.issue === "unsupported" || l.issue === "invalid").length,
    valued_cents: valued === null ? null : valued.toString(), state, posted_lines: Number(item?.data.posted_lines ?? 0), preview_hash: plan.hash,
    movements: Array.isArray(item?.data.movements) ? (item!.data.movements as string[]).slice(0, 500) : [] };
}
function stockWarehouses(db: SqlDriver, cutoverOn: string): BlingCutoverWarehouse[] {
  return [...stockObserved(db)].slice(0, 500).map(([source, lines]) => warehouseSummary(db, warehousePlan(db, source, lines, cutoverOn)));
}
export function cutoverStock(call: AdoptionCall, input: Map_<"erp_bling_cutover_stock">["input"]): Map_<"erp_bling_cutover_stock">["output"] {
  requireStep(call, "stock");
  const db = call.db, cut = requireCutover(db), observed = stockObserved(db);
  const warehouses = [...observed].slice(0, 500).map(([source, lines]) => warehouseSummary(db, warehousePlan(db, source, lines, cut.cutover_on)));
  let lines: Map_<"erp_bling_cutover_stock">["output"]["lines"] = null;
  if (input.warehouse) {
    const list = observed.get(input.warehouse);
    if (!list) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND", "Não há saldo coletado do Bling para este depósito.");
    const plan = warehousePlan(db, input.warehouse, list, cut.cutover_on), limit = input.limit ?? 50, cursor = input.cursor ?? null;
    const filtered = plan.lines.filter(l => (input.only_issues !== "sim" || l.issue !== null) && (cursor === null || l.product_source_id.length > cursor.length || (l.product_source_id.length === cursor.length && l.product_source_id > cursor)));
    const page = filtered.slice(0, limit).map(({ version: _v, postable: _p, ...line }) => line);
    lines = { warehouse: input.warehouse, items: page, next_cursor: filtered.length > limit ? page[page.length - 1].product_source_id : null };
  }
  return { cutover_on: cut.cutover_on, negative_allowed: negativeAllowed(db), warehouses, lines };
}
const STOCK_CHUNK = 100;
export function cutoverStockPost(call: AdoptionCall, input: Map_<"erp_bling_cutover_stock_post">["input"]) {
  requireStep(call, "stock");
  return command(call, "erp_bling_cutover_stock_post", input.command_id, ctx => {
    const db = ctx.db, cut = requireCutover(db, true), actor = call.identity.actor!.user_id, now = call.now();
    if (cut.cutover_on > todaySaoPaulo(now)) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "A data de corte ainda não chegou. O estoque de abertura só pode ser gravado a partir desse dia.");
    const list = stockObserved(db).get(input.warehouse);
    if (!list) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND", "Não há saldo coletado do Bling para este depósito.");
    const plan = warehousePlan(db, input.warehouse, list, cut.cutover_on);
    if (!plan.record) throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", "Adote primeiro este depósito em Adotar cadastros.");
    if (plan.hash !== input.preview_hash) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "A prévia deste depósito mudou (nova coleta ou cadastro adotado). Confira de novo antes de gravar.");
    const item = readItem(db, "stock", input.warehouse);
    if (item?.state === "posted") return { warehouse: warehouseSummary(db, plan), posted_lines: 0, remaining: 0, movement_id: null };
    const waiting = plan.lines.filter(l => l.postable && l.state === "waiting");
    const chunk = waiting.slice(0, STOCK_CHUNK);
    const items = chunk.filter(l => l.delta !== "0").map(l => ({ product_id: l.product_id!, warehouse_id: plan.record!, quantity: l.delta!, expected_version: l.version }));
    let movement: string | null = null;
    if (items.length) {
      const result = invokeRpc(ctx, "erp_stock_post", { p_user_id: actor, p_command_id: commandUuid("bling-cutover-stock", input.warehouse, cut.cutover_on, text(item?.data.after) ?? "inicio"),
        p_kind: "adjustment", p_occurred_on: cut.cutover_on, p_reason: `Estoque de abertura vindo do Bling (data de corte ${br(cut.cutover_on)})`,
        p_reference: clip(`Bling: abertura do depósito ${plan.name ?? input.warehouse}`, 100), p_items: items });
      movement = text(at(result, "movement", "id"));
    }
    let value = BigInt(String(item?.data.value_cents ?? "0"));
    for (const line of chunk) if (line.unit_cost) value += valueCents(line.target, line.unit_cost);
    const after = chunk.length ? chunk[chunk.length - 1].product_source_id : text(item?.data.after);
    const remaining = waiting.length - chunk.length;
    const movements = [...(Array.isArray(item?.data.movements) ? item!.data.movements as string[] : []), ...(movement ? [movement] : [])];
    saveItem(db, "stock", input.warehouse, remaining ? "partial" : "posted", { after, hash: plan.hash, posted_lines: Number(item?.data.posted_lines ?? 0) + chunk.length,
      movements: movements.slice(0, 500), value_cents: value.toString(), cutover_on: cut.cutover_on }, plan.record, actor, now);
    const fresh = warehousePlan(db, input.warehouse, list, cut.cutover_on);
    return { warehouse: warehouseSummary(db, fresh), posted_lines: chunk.length, remaining, movement_id: movement };
  });
}

// ---------------------------------------------------------------------------
// Notas emitidas no Bling (só consulta, no Fiscal)

const NFE_SITUATIONS: Record<string, string> = { "1": "Pendente", "2": "Cancelada", "3": "Aguardando recibo", "4": "Rejeitada", "5": "Autorizada", "6": "Emitida DANFE",
  "7": "Registrada", "8": "Aguardando protocolo", "9": "Denegada", "10": "Consulta situação", "11": "Bloqueada" };
const INVOICE_FIELDS = `r.entity, r.source_id, CAST(json_extract(r.payload,'$.numero') AS TEXT) AS numero, CAST(json_extract(r.payload,'$.serie') AS TEXT) AS serie,
  CAST(json_extract(r.payload,'$.chaveAcesso') AS TEXT) AS chave, substr(coalesce(json_extract(r.payload,'$.dataEmissao'), json_extract(r.payload,'$.dataOperacao')),1,10) AS emissao,
  json_extract(r.payload,'$.contato.nome') AS contato, CAST(json_extract(r.payload,'$.contato.numeroDocumento') AS TEXT) AS documento,
  CAST(coalesce(json_extract(r.payload,'$.valorNota'), json_extract(r.payload,'$.valor')) AS TEXT) AS valor,
  CAST(coalesce(json_extract(r.payload,'$.situacao.id'), json_extract(r.payload,'$.situacao.valor'), json_extract(r.payload,'$.situacao')) AS TEXT) AS situacao,
  CAST(json_extract(r.payload,'$.tipo') AS TEXT) AS tipo`;
function invoiceItem(db: SqlDriver, profile: string, r: Row): BlingCutoverInvoice {
  const total = centsOf(r.valor), situation = text(r.situacao);
  return { entity: r.entity as "nfe" | "nfce", source_id: String(r.source_id), number: clip(text(r.numero), 40), series: clip(text(r.serie), 10), access_key: clip(text(r.chave), 60),
    issued_on: dateOf(r.emissao), contact_name: clip(text(r.contato), 200), contact_document: clip(text(r.documento), 40),
    total_cents: typeof total === "bigint" ? total.toString() : null, situation: situation ? clip(NFE_SITUATIONS[situation] ?? `código ${situation}`, 120) : null,
    direction: text(r.tipo) === "0" ? "Entrada" : text(r.tipo) === "1" ? "Saída" : null, has_xml: verifiedXmlOf(db, profile, String(r.entity), String(r.source_id)) !== null };
}
export function cutoverInvoices(call: AdoptionCall, input: Map_<"erp_bling_cutover_invoices">["input"]): Map_<"erp_bling_cutover_invoices">["output"] {
  requireStep(call, "invoices"); requireCutover(call.db);
  const db = call.db, limit = input.limit ?? 20;
  const q = input.q ? input.q.toLocaleLowerCase("pt-BR") : null, digits = input.q?.replace(/\D/g, "") || null;
  const [cursorDate, cursorId] = input.cursor ? input.cursor.split(".") : [null, null];
  const rows = db.exec(`SELECT * FROM (SELECT ${INVOICE_FIELDS} FROM origin_sync__raw_record r WHERE r.entity IN ('nfe','nfce') AND (? IS NULL OR r.entity=?)) x
    WHERE (? IS NULL OR emissao>=?) AND (? IS NULL OR emissao<=?)
      AND (? IS NULL OR numero=? OR chave=? OR instr(lower(coalesce(contato,'')), ?)>0 OR (? IS NOT NULL AND replace(replace(replace(coalesce(documento,''),'.',''),'/',''),'-','')=?))
      AND (? IS NULL OR coalesce(emissao,'0')<? OR (coalesce(emissao,'0')=? AND (length(source_id)<length(?) OR (length(source_id)=length(?) AND source_id<?))))
    ORDER BY coalesce(emissao,'0') DESC, length(source_id) DESC, source_id DESC LIMIT ?`,
    input.entity ?? null, input.entity ?? null, input.from ?? null, input.from ?? null, input.to ?? null, input.to ?? null,
    q, input.q ?? null, input.q ?? null, q, digits, digits, cursorDate, cursorDate, cursorDate, cursorId, cursorId, cursorId, limit + 1).rows;
  const items = rows.slice(0, limit).map(r => invoiceItem(db, call.profile, r));
  const last = items[items.length - 1];
  return { items, next_cursor: rows.length > limit && last ? `${last.issued_on ?? "0"}.${last.source_id}` : null, read_only_message: BLING_CUTOVER_TEXTS.invoices };
}
export interface CutoverMedia { get(key: string): Promise<{ size?: number; arrayBuffer(): Promise<ArrayBuffer> } | null> }
export async function cutoverInvoiceGet(call: AdoptionCall, input: Map_<"erp_bling_cutover_invoice_get">["input"], media: CutoverMedia | null): Promise<Map_<"erp_bling_cutover_invoice_get">["output"]> {
  requireStep(call, "invoices"); requireCutover(call.db);
  const db = call.db;
  const row = db.exec(`SELECT ${INVOICE_FIELDS} FROM origin_sync__raw_record r WHERE r.entity=? AND r.source_id=?`, input.entity, input.source_id).rows[0];
  // readRaw lê qualquer entidade do acervo; a tipagem é a das entidades adotáveis.
  const raw = row && readRaw(db, input.entity as unknown as BlingAdoptionEntity, input.source_id);
  if (!row || !raw) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND", "Esta nota não está no acervo do Bling.");
  const item = invoiceItem(db, call.profile, row), p = raw.payload, s = (v: unknown) => clip(text(v), 400);
  const fields: Record<string, string | null> = {
    "Modelo": input.entity === "nfe" ? "NF-e (55)" : "NFC-e (65)", "Número": item.number, "Série": item.series, "Chave de acesso": item.access_key,
    "Emissão": item.issued_on ? br(item.issued_on) : null, "Tipo": item.direction, "Situação no Bling": item.situation,
    "Destinatário": item.contact_name, "CPF/CNPJ do destinatário": item.contact_document, "Valor da nota": item.total_cents === null ? null : money(BigInt(item.total_cents)),
    "Natureza da operação": s(at(p.naturezaOperacao, "descricao")) ?? (sourceOf(p.naturezaOperacao) ? `id ${sourceOf(p.naturezaOperacao)}` : null),
    "Finalidade": s(p.finalidade), "Id no Bling": input.source_id,
  };
  const found = verifiedXmlOf(db, call.profile, input.entity, input.source_id);
  let xml: Map_<"erp_bling_cutover_invoice_get">["output"]["xml"] = { available: false, text: null, sha256: null, filename: null, note: "O XML desta nota não foi coletado do Bling. Peça a coleta de XML em Configuração." };
  if (found) {
    try {
      const object = media ? await media.get(found.key) : null;
      const bytes = object ? new Uint8Array(await object.arrayBuffer()) : null;
      const digest = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
      if (bytes && digest === found.sha256 && bytes.length <= 2_000_000)
        xml = { available: true, text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), sha256: found.sha256, filename: `${input.entity === "nfe" ? "NFe" : "NFCe"}-${found.access_key || input.source_id}.xml`, note: null };
      else xml = { available: false, text: null, sha256: found.sha256, filename: null, note: "O arquivo XML guardado não pôde ser lido ou não confere com o hash. Tente de novo mais tarde." };
    } catch { xml = { available: false, text: null, sha256: found.sha256, filename: null, note: "O arquivo XML guardado não pôde ser lido agora. Tente de novo mais tarde." }; }
  }
  return { item, fields, read_only_message: BLING_CUTOVER_TEXTS.invoices, xml };
}

// ---------------------------------------------------------------------------
// Conflitos depois do corte

const conflictSql = (table: string) => `SELECT l.entity, l.source_id, l.record_id, l.source_version, r.version, r.changed_at FROM ${table} l
  JOIN origin_sync__raw_record r ON r.entity=l.entity AND r.source_id=l.source_id WHERE r.version > l.source_version`;
function conflictCount(db: SqlDriver): number {
  if (!readCutover(db)) return 0;
  return ["wb_bling_adoption_link", "wb_bling_adoption_doc_link"].reduce((s, t) => s + Number(db.exec(`SELECT count(*) AS n FROM (${conflictSql(t)})`).rows[0]?.n ?? 0), 0);
}
export function cutoverConflicts(call: AdoptionCall, input: Map_<"erp_bling_cutover_conflicts">["input"]): Map_<"erp_bling_cutover_conflicts">["output"] {
  requireCutover(call.db);
  const db = call.db, limit = input.limit ?? 20, [ce, cs] = input.cursor ? input.cursor.split(":") : [null, null];
  const rows = db.exec(`SELECT * FROM (${conflictSql("wb_bling_adoption_link")} UNION ALL ${conflictSql("wb_bling_adoption_doc_link")})
    WHERE (? IS NULL OR entity>? OR (entity=? AND (length(source_id)>length(?) OR (length(source_id)=length(?) AND source_id>?))))
    ORDER BY entity, length(source_id), source_id LIMIT ?`, ce, ce, ce, cs, cs, cs, limit + 1).rows;
  const items: BlingCutoverConflict[] = rows.slice(0, limit).map(r => {
    const entity = String(r.entity) as BlingAdoptionEntity;
    return { entity, source_id: String(r.source_id), label: clip(`${BLING_ADOPTION_SINGULAR[entity] ?? entity} (id ${r.source_id})`, 200)!, from_version: String(r.source_version), to_version: String(r.version),
      changed_at: iso(r.changed_at), record_id: String(r.record_id), bling: blingSummary(db, entity, String(r.source_id)), erp: erpSummary(db, entity, String(r.record_id)),
      can_use_bling: !isAdoptionB2(entity) && BLING_ADOPTION_UPDATABLE.has(entity) };
  });
  const last = items[items.length - 1];
  return { items, next_cursor: rows.length > limit && last ? `${last.entity}:${last.source_id}` : null, total: conflictCount(db) };
}
export function cutoverConflictResolve(call: AdoptionCall, input: Map_<"erp_bling_cutover_conflict_resolve">["input"]) {
  return command(call, "erp_bling_cutover_conflict_resolve", input.command_id, ctx => {
    const db = ctx.db, actor = call.identity.actor!.user_id, now = call.now();
    requireCutover(db);
    const entity = input.entity as BlingAdoptionEntity;
    if (!(entity in BLING_ADOPTION_LABELS)) throw new BlingAdoptionError("BLING_ADOPTION_INVALID");
    const link = linkOf(db, entity, input.source_id), raw = readRaw(db, entity, input.source_id);
    if (!link || !raw || raw.version <= link.source_version) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND", "Esta mudança já foi decidida ou o registro não está mais ligado. Atualize a tela.");
    let outcome: "kept" | "updated" = "kept";
    if (input.action === "use_bling") {
      if (isAdoptionB2(entity)) throw new BlingAdoptionError("BLING_ADOPTION_INVALID", "Documentos e contas não mudam pela versão do Bling: ajuste no ERP, se precisar, e escolha manter o ERP.");
      try { applyBlingUpdate(ctx, entity as BlingAdoptionRecordEntity, raw, link.record_id, actor, now, "conflict:" + input.command_id); }
      catch (error) {
        if (error instanceof BlingAdoptionError) throw error;
        const failure = domainFailure(error);
        if (failure.stop === "permission") throw new BlingAdoptionError("BLING_ADOPTION_ADMIN_REQUIRED");
        throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", [BLING_ADOPTION_REASONS[failure.reason], failure.detail].filter(Boolean).join(" "));
      }
      outcome = "updated";
    }
    db.exec(`UPDATE ${adoptionTables(entity).link} SET source_version=?, source_hash=?${outcome === "updated" ? ", mode='updated'" : ""} WHERE entity=? AND source_id=?`, raw.version, raw.hash, entity, input.source_id);
    saveItem(db, "conflict", `${entity}:${input.source_id}:${raw.version}`, outcome, { from_version: link.source_version, to_version: raw.version }, link.record_id, actor, now);
    return { outcome };
  });
}

// ---------------------------------------------------------------------------
// Conferência final e conclusão

const JUSTIFIED_BY_DECISION = "Decidido na adoção: o registro foi ignorado por uma pessoa.";
function justificationOf(db: SqlDriver, key: string) {
  const item = readItem(db, "justification", key);
  return item ? { text: String(item.data.text), by: item.actor_id, at: new Date(item.updated_at).toISOString() } : null;
}
function itemJustifications(db: SqlDriver, group: string): Set<string> {
  return new Set(db.exec("SELECT key FROM wb_bling_cutover_item WHERE kind='justification' AND key LIKE ? ESCAPE '\\'", group.replace(/[\\%_]/g, c => "\\" + c) + ":%").rows.map(r => String(r.key)));
}
function openMoney(db: SqlDriver, entity: BlingAdoptionAccountEntity): { bling: bigint; erp: bigint; settled: bigint } {
  let bling = 0n;
  for (const item of accountScan(db, entity)) {
    if (item.scope === "open") bling += item.amount ?? 0n;
    else if (item.scope === "partial" && item.balance !== null && item.balance > 0n) bling += item.balance;
  }
  const erp = db.exec(`SELECT coalesce(sum(t.amount_cents),0) AS total, coalesce(sum(t.settled_cents),0) AS settled FROM wb_bling_adoption_doc_link l JOIN erp_finance__title t ON t.id=l.record_id
    WHERE l.entity=? AND t.deleted_at IS NULL AND t.cancelled=0`, entity).rows[0];
  return { bling, erp: BigInt(String(erp?.total ?? 0)), settled: BigInt(String(erp?.settled ?? 0)) };
}
export function cutoverReport(call: AdoptionCall): Map_<"erp_bling_cutover_report">["output"] {
  requireStep(call, "report");
  const db = call.db, cut = requireCutover(db), adoption = adoptionStatus(call);
  const entities: Map_<"erp_bling_cutover_report">["output"]["entities"] = adoption.entities.map(e => ({ key: e.entity, label: e.label, bling: e.collected, adopted: e.adopted, history: e.history ?? 0, pending: e.pending, ignored: e.ignored, waiting: e.waiting }));
  const groups: BlingCutoverDifference[] = [];
  const add = (key: string, kind: string, label: string, count: number, cents: bigint | null, explanation: string, items: { key: string; label: string; detail: string | null }[], decided = false) => {
    if (!count) return;
    const justification = decided ? { text: JUSTIFIED_BY_DECISION, by: "adoção", at: new Date(0).toISOString() } : justificationOf(db, key);
    const perItem = itemJustifications(db, key);
    groups.push({ key, kind, label: clip(label, 300)!, count, cents: cents === null ? null : cents.toString(), explanation: clip(explanation, 600)!,
      justified: !!justification || perItem.size >= count, justification,
      items: items.slice(0, 20).map(item => ({ ...item, label: clip(item.label, 300)!, detail: clip(item.detail, 300), justified: !!justification || perItem.has(item.key) })) });
  };
  for (const e of adoption.entities) {
    const t = adoptionTables(e.entity);
    if (e.pending) {
      const sample = db.exec(`SELECT source_id, reason, detail FROM ${t.review} WHERE entity=? AND state='pending' ORDER BY length(source_id), source_id LIMIT 20`, e.entity).rows;
      add(`pendente:${e.entity}`, "pendente", `${e.label}: pendências de revisão`, e.pending, null, "Registros que a adoção não decidiu sozinha. Decida em Adotar cadastros (usar a do Bling, manter a do ERP ou ignorar) ou justifique.",
        sample.map(r => ({ key: `pendente:${e.entity}:${r.source_id}`, label: `${BLING_ADOPTION_SINGULAR[e.entity]} id ${r.source_id}: ${blingSummary(db, e.entity, String(r.source_id))?.["Nome"] ?? "sem nome"}`,
          detail: [BLING_ADOPTION_REASONS[String(r.reason) as BlingAdoptionReason], r.detail ? String(r.detail) : null].filter(Boolean).join(" ") })));
    }
    if (e.waiting) add(`aguardando:${e.entity}`, "aguardando", `${e.label}: ainda não passaram pela adoção`, e.waiting, null,
      e.enabled ? "Coletados do Bling e ainda não processados. Rode a adoção em Adotar cadastros." : e.part_off_message ?? "Ligue o módulo e rode a adoção.", []);
    if (e.ignored) add(`ignorado:${e.entity}`, "ignorado", `${e.label}: ignorados pela pessoa`, e.ignored, null, "Ficaram de fora por decisão na adoção.", [], true);
  }
  if (call.parts.finance) {
    for (const p of partialCounts(db)) {
      const left = p.pending + p.waiting;
      if (!left) continue;
      const sample = cutoverPartials(call, { entity: p.entity, limit: 20 }).items.filter(i => i.state !== "adopted");
      add(`parcial:${p.entity}`, "parcial", `${BLING_ADOPTION_LABELS[p.entity]}: parciais ainda não adotadas pelo saldo`, left, null,
        "Contas com baixa parcial no Bling que ainda não viraram título do ERP pelo saldo. Rode Adotar parciais ou justifique.",
        sample.map(i => ({ key: `parcial:${p.entity}:${i.source_id}`, label: `Nº ${i.number ?? "—"} · ${i.contact_name ?? "sem contato"} · saldo ${i.balance_cents === null ? "—" : money(BigInt(i.balance_cents))}`, detail: i.detail })));
    }
    const balances = balanceRows(db, cut.cutover_on), waiting = balances.filter(b => b.state !== "posted");
    add("saldo", "saldo", "Contas financeiras sem saldo de abertura gravado", waiting.length, null, "Confira e grave o saldo de abertura de cada conta, ou justifique (por exemplo, conta sem movimento).",
      waiting.map(b => ({ key: `saldo:${b.source_id}`, label: b.name ?? `Conta id ${b.source_id}`, detail: b.computed_note })));
  }
  if (call.parts.stock && call.parts.products) {
    for (const w of stockWarehouses(db, cut.cutover_on)) {
      if (w.state !== "posted") add(`estoque:${w.source_id}`, "estoque", `Depósito ${w.name ?? w.source_id}: estoque de abertura não gravado`, 1, null,
        w.state === "blocked" ? "O depósito ainda não foi adotado. Adote em Adotar cadastros ou justifique." : "Confira a prévia e grave o estoque de abertura deste depósito.", []);
      const skipped = w.without_product + w.unsupported + (w.negatives && !negativeAllowed(db) ? w.negatives : 0);
      if (skipped) add(`estoque_fora:${w.source_id}`, "estoque_fora", `Depósito ${w.name ?? w.source_id}: produtos que não entram no estoque de abertura`, skipped, null,
        "Produtos sem cadastro adotado, serviços, variações ou composições e saldos negativos que o ERP não aceita. Adote o produto, ajuste à mão ou justifique.", []);
    }
  }
  const conflicts = conflictCount(db);
  add("conflito", "conflito", "Mudanças no Bling em registros já adotados", conflicts, null, BLING_CUTOVER_TEXTS.conflicts, []);
  const money_: Map_<"erp_bling_cutover_report">["output"]["money"] = [];
  const moneyRow = (key: string, label: string, bling: bigint, erp: bigint, explanation: string) => {
    money_.push({ key, label, bling_cents: bling.toString(), erp_cents: erp.toString(), difference_cents: (erp - bling).toString(), explanation: clip(explanation, 600)! });
    if (erp !== bling) add(`dinheiro:${key}`, "dinheiro", `${label}: diferença de ${money(erp - bling)}`, 1, erp - bling, explanation, []);
  };
  if (call.parts.finance) {
    for (const entity of ACCOUNTS) {
      const m = openMoney(db, entity);
      moneyRow(entity, entity === "receivables" ? "A receber" : "A pagar", m.bling, m.erp,
        `No Bling: contas em aberto pelo valor e parciais pelo saldo. No ERP: as contas adotadas do Bling pelo valor criado${m.settled ? ` (já baixado no ERP depois do corte: ${money(m.settled)})` : ""}. A diferença vem do que ainda não foi adotado ou está pendente.`);
    }
    const balances = balanceRows(db, cut.cutover_on);
    const bling = balances.reduce((s, b) => s + BigInt(b.posted_cents ?? b.computed_cents ?? "0"), 0n), erp = balances.reduce((s, b) => s + BigInt(b.erp_cents_at_cutover), 0n);
    moneyRow("balances", "Saldos das contas financeiras", bling, erp, "No Bling: o saldo confirmado (ou calculado dos lançamentos) na data de corte. No ERP: o saldo das contas adotadas nessa data.");
  }
  if (call.parts.stock && call.parts.products) {
    const warehouses = stockWarehouses(db, cut.cutover_on);
    const bling = warehouses.reduce((s, w) => s + BigInt(w.valued_cents ?? "0"), 0n);
    const erp = db.exec("SELECT data FROM wb_bling_cutover_item WHERE kind='stock'").rows.reduce((s, r) => s + BigInt(String((JSON.parse(String(r.data)) as Json).value_cents ?? "0")), 0n);
    moneyRow("stock", "Estoque valorizado (pelo custo do Bling)", bling, erp, "No Bling: saldo observado vezes o custo do produto, quando o acervo tem custo. No ERP: o mesmo custo nas quantidades gravadas na abertura. Produtos sem custo não entram.");
  }
  const blocking = groups.filter(g => !g.justified).length;
  return { cutover: publicCutover(db), entities, money: money_, differences: groups.slice(0, 60), blocking, can_conclude: blocking === 0 && groups.length <= 60 };
}
export function cutoverJustify(call: AdoptionCall, input: Map_<"erp_bling_cutover_justify">["input"]) {
  requireStep(call, "report");
  return command(call, "erp_bling_cutover_justify", input.command_id, ctx => {
    requireCutover(ctx.db, true);
    saveItem(ctx.db, "justification", input.key, "recorded", { text: input.text }, null, call.identity.actor!.user_id, call.now());
    return { key: input.key };
  });
}
export function cutoverConclude(call: AdoptionCall, input: Map_<"erp_bling_cutover_conclude">["input"]) {
  requireStep(call, "report");
  const previous = call.db.exec("SELECT 1 AS x FROM wb_bling_adoption_command WHERE command_id=?", input.command_id).rows.length > 0;
  const report = previous ? null : cutoverReport(call);
  return command(call, "erp_bling_cutover_conclude", input.command_id, ctx => {
    const db = ctx.db, cut = requireCutover(db, true), now = call.now();
    if (!report!.can_conclude) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", `Ainda há ${report!.blocking} diferença(s) sem justificativa. Resolva ou justifique cada uma na conferência.`);
    const snapshot = JSON.stringify({ cutover_on: cut.cutover_on, entities: report!.entities, money: report!.money,
      differences: report!.differences.map(({ items: _items, ...rest }) => rest) });
    db.exec("UPDATE wb_bling_cutover SET state='concluded', concluded_by=?, concluded_at=?, revision=revision+1, snapshot=?, updated_at=? WHERE id=1",
      call.identity.actor!.user_id, now, snapshot.length > 250_000 ? "{}" : snapshot, now);
    return { cutover: publicCutover(db) };
  });
}
