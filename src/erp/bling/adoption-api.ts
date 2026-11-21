/** Despacho das operações de adoção dentro do objeto da área. O Worker só
 * encaminha nomes conhecidos; aqui se conferem pessoa, papel, partes e, para
 * bots, a concessão nominal e a confirmação da pessoa. */
import { createHash } from "node:crypto";
import type { IdentityPort } from "../engine/identity.ts";
import { storageDriver } from "../engine/driver.ts";
import { readErpPartsSnapshot, type ErpPartsSnapshot } from "../parts.ts";
import {
  BlingAdoptionError, adoptionOutputs, getAdoptionOperation, isAdoptionAdminOnly, parseAdoptionInput,
  type BlingAdoptionAuthorization, type BlingAdoptionOperationName,
} from "./adoption-contracts.ts";
import {
  adoptionAdoptOne, adoptionHistory, adoptionHistoryGet, adoptionLinks, adoptionPause, adoptionResolve, adoptionReviews, adoptionStart, adoptionStatus, adoptionUnlink,
  runAdoptionUnit, type AdoptionCall,
} from "./adoption.ts";
import {
  cutoverAccountsSummary, cutoverBalancePost, cutoverBalances, cutoverConclude, cutoverConfirm, cutoverConflictResolve, cutoverConflicts, cutoverInvoiceGet,
  cutoverInvoices, cutoverJustify, cutoverPartials, cutoverPartialsAdopt, cutoverReport, cutoverStatus, cutoverStock, cutoverStockPost, publicCutover,
  type CutoverMedia,
} from "./cutover.ts";
import { packageDownload, packageList, packageRunning, packageStart, runPackageUnit, type PackageMedia } from "./cutover-package.ts";
import { runTwoWayLocalUnit, twoWayIssues, twoWayPace, twoWayQueue, twoWayResolve, twoWayStatus, twoWaySwitch } from "./two-way.ts";
import { extrasAdopt, extrasContractDraftFor, extrasContractLink, extrasContracts, extrasInvoices, extrasPreview, extrasResolve, extrasReviews, extrasStatus, extrasUnlink } from "./extras.ts";
import { extrasOutbox, extrasOutboxResolve, extrasSwitch, runExtrasTwoWayLocal } from "./extras-two-way.ts";

const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export const adoptionRequestHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

export function adoptionFailureResponse(error: unknown): Response {
  const failure = error instanceof BlingAdoptionError ? error : new BlingAdoptionError("BLING_ADOPTION_UNAVAILABLE");
  return Response.json({ error: failure.toJSON() }, { status: failure.status, headers: privateHeaders });
}

export interface AdoptionDispatch {
  name: BlingAdoptionOperationName;
  identity: IdentityPort;
  profile: string;
  input: unknown;
  authorization: BlingAdoptionAuthorization | null;
}

/** Quem pode: administrador do ERP com sessão; bot só pela operação concedida e,
 * nas sensíveis, com a proposta confirmada pela própria pessoa. */
export function authorizeAdoption(call: AdoptionDispatch): void {
  const actor = call.identity.actor;
  if (!actor || actor.erp_role !== "admin") throw new BlingAdoptionError("BLING_ADOPTION_ADMIN_REQUIRED");
  // Ligar ou desligar a mão dupla e o ritmo: só a pessoa, nunca um bot.
  if (isAdoptionAdminOnly(call.name) && actor.is_agent) throw new BlingAdoptionError("BLING_ADOPTION_SCOPE_REQUIRED");
  if (!actor.is_agent) {
    if (!actor.session_id || call.authorization) throw new BlingAdoptionError("BLING_ADOPTION_ADMIN_REQUIRED");
    return;
  }
  const authorization = call.authorization;
  if (!authorization || authorization.bot.operation !== call.name || authorization.request_hash !== adoptionRequestHash(call.input))
    throw new BlingAdoptionError("BLING_ADOPTION_SCOPE_REQUIRED");
  if (getAdoptionOperation(call.name)!.sensitive && (!authorization.confirmed || !authorization.delegation.proposal_id))
    throw new BlingAdoptionError("BLING_ADOPTION_SCOPE_REQUIRED");
}

export interface AdoptionDependencies {
  storage: DurableObjectStorage;
  readSnapshot(): Promise<ErpPartsSnapshot | null>;
  now?(): number;
  /** Armazenamento de arquivos (R2) da área: XML das notas e pacote do contador. */
  media?: (PackageMedia & CutoverMedia) | null;
}
/** Pacote do contador: exige a parte Fiscal e a data de corte confirmada. */
function fiscalCutover(context: AdoptionCall): string {
  if (!context.parts.fiscal) throw new BlingAdoptionError("BLING_ADOPTION_PART_DISABLED", "Para gerar o pacote do contador, ligue o módulo Fiscal em Gestão → Módulos.");
  const cutover = publicCutover(context.db);
  if (!cutover.cutover_on) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "Confirme primeiro a data de corte em Receber dados do Bling → Passar a operar aqui. Sem ela nenhuma etapa do corte roda.");
  return cutover.cutover_on;
}
export async function handleAdoptionOperation(call: AdoptionDispatch, dependencies: AdoptionDependencies): Promise<Response> {
  try {
    const now = dependencies.now ?? (() => Date.now());
    const snapshot = readErpPartsSnapshot(await dependencies.readSnapshot(), call.profile, now());
    if (!snapshot?.parts.customers) throw new BlingAdoptionError("BLING_ADOPTION_DISABLED");
    authorizeAdoption(call);
    const input = parseAdoptionInput(call.name, call.input);
    const context: AdoptionCall = { db: storageDriver(dependencies.storage), profile: call.profile, now, parts: snapshot.parts,
      identity: { ...call.identity, parts: snapshot.parts }, request_hash: adoptionRequestHash(input) };
    let result: unknown;
    switch (call.name) {
      case "erp_bling_adoption_status": result = adoptionStatus(context); break;
      case "erp_bling_adoption_reviews": result = adoptionReviews(context, input as never); break;
      case "erp_bling_adoption_links": result = adoptionLinks(context, input as never); break;
      case "erp_bling_adoption_start": {
        result = adoptionStart(context, input as never);
        // Primeira unidade já na resposta: a pessoa vê o progresso começar.
        runAdoptionUnit({ db: context.db, profile: call.profile, now, parts: snapshot.parts });
        result = { ...(result as object), job: adoptionStatus(context).job };
        break;
      }
      case "erp_bling_adoption_pause": result = adoptionPause(context, input as never); break;
      case "erp_bling_adoption_resolve": result = adoptionResolve(context, input as never); break;
      case "erp_bling_adoption_unlink": result = adoptionUnlink(context, input as never); break;
      case "erp_bling_adoption_adopt_one": result = adoptionAdoptOne(context, input as never); break;
      case "erp_bling_adoption_history": result = adoptionHistory(context, input as never); break;
      case "erp_bling_adoption_history_get": result = adoptionHistoryGet(context, input as never); break;
      // Fatia C: o corte.
      case "erp_bling_cutover_status": result = cutoverStatus(context, input as never); break;
      case "erp_bling_cutover_confirm": result = cutoverConfirm(context, input as never); break;
      case "erp_bling_cutover_accounts_summary": result = cutoverAccountsSummary(context); break;
      case "erp_bling_cutover_partials": result = cutoverPartials(context, input as never); break;
      case "erp_bling_cutover_partials_adopt": result = cutoverPartialsAdopt(context, input as never); break;
      case "erp_bling_cutover_balances": result = cutoverBalances(context); break;
      case "erp_bling_cutover_balance_post": result = cutoverBalancePost(context, input as never); break;
      case "erp_bling_cutover_stock": result = cutoverStock(context, input as never); break;
      case "erp_bling_cutover_stock_post": result = cutoverStockPost(context, input as never); break;
      case "erp_bling_cutover_invoices": result = cutoverInvoices(context, input as never); break;
      case "erp_bling_cutover_invoice_get": result = await cutoverInvoiceGet(context, input as never, dependencies.media ?? null); break;
      case "erp_bling_cutover_packages": fiscalCutover(context); result = packageList(context); break;
      case "erp_bling_cutover_package_start": {
        result = packageStart(context, input as never, fiscalCutover(context));
        // Primeira parte já na resposta, como o lote da adoção.
        await runPackageUnit({ db: context.db, profile: call.profile, media: dependencies.media ?? null, now });
        const month = (input as { month: string }).month;
        const fresh = packageList(context).items.find(item => item.month === month);
        if (fresh) result = { ...(result as object), package: fresh };
        break;
      }
      case "erp_bling_cutover_package_download": {
        fiscalCutover(context);
        return await packageDownload(context.db, call.profile, dependencies.media ?? null, (input as { month: string }).month);
      }
      case "erp_bling_cutover_report": result = cutoverReport(context); break;
      case "erp_bling_cutover_justify": result = cutoverJustify(context, input as never); break;
      case "erp_bling_cutover_conclude": result = cutoverConclude(context, input as never); break;
      case "erp_bling_cutover_conflicts": result = cutoverConflicts(context, input as never); break;
      case "erp_bling_cutover_conflict_resolve": result = cutoverConflictResolve(context, input as never); break;
      // Mão dupla (versão 19).
      case "erp_bling_twoway_status": result = twoWayStatus(context); break;
      case "erp_bling_twoway_queue": result = twoWayQueue(context, input as never); break;
      case "erp_bling_twoway_issues": result = twoWayIssues(context, input as never); break;
      case "erp_bling_twoway_resolve": result = twoWayResolve(context, input as never); break;
      case "erp_bling_twoway_switch": result = twoWaySwitch(context, input as never); break;
      case "erp_bling_twoway_pace": result = twoWayPace(context, input as never); break;
      // Fatia D: outros dados do Bling (versão 24).
      case "erp_bling_extras_status": result = extrasStatus(context); break;
      case "erp_bling_extras_preview": result = extrasPreview(context, input as never); break;
      case "erp_bling_extras_reviews": result = extrasReviews(context, input as never); break;
      case "erp_bling_extras_adopt": result = extrasAdopt(context, input as never); break;
      case "erp_bling_extras_resolve": result = extrasResolve(context, input as never); break;
      case "erp_bling_extras_unlink": result = extrasUnlink(context, input as never); break;
      case "erp_bling_extras_invoices": result = extrasInvoices(context, input as never); break;
      case "erp_bling_extras_contracts": result = extrasContracts(context, input as never); break;
      // O Worker completa com os módulos, os planos e os clientes do atendimento.
      case "erp_bling_extras_contract_options": result = { draft: extrasContractDraftFor(context, (input as { source_id: string }).source_id), modules: { os: false, mensalidade: false },
        missing: "Ligue o módulo Ordem de Serviço em Gestão → Módulos.", plans: [], contacts: [] }; break;
      case "erp_bling_extras_contract_create": throw new BlingAdoptionError("BLING_ADOPTION_INVALID", "O contrato de manutenção é criado pela tela Receber dados do Bling.");
      case "erp_bling_extras_contract_link": result = extrasContractLink(context, input as never); break;
      case "erp_bling_extras_switch": result = extrasSwitch(context, input as never); break;
      case "erp_bling_extras_outbox": result = extrasOutbox(context, input as never); break;
      case "erp_bling_extras_outbox_resolve": result = extrasOutboxResolve(context, input as never); break;
    }
    const output = adoptionOutputs[call.name].safeParse(result);
    if (!output.success) throw new BlingAdoptionError("BLING_ADOPTION_UNAVAILABLE");
    return Response.json(output.data, { headers: privateHeaders });
  } catch (error) { return adoptionFailureResponse(error); }
}

/** Uma unidade no alarme, depois do trabalho operacional da área. */
export async function runAdoptionWake(profile: string, dependencies: AdoptionDependencies): Promise<{ worked: boolean; nextWake: number | null }> {
  const now = dependencies.now ?? (() => Date.now());
  const snapshot = readErpPartsSnapshot(await dependencies.readSnapshot(), profile, now());
  if (!snapshot?.parts.customers) return { worked: false, nextWake: null };
  const db = storageDriver(dependencies.storage);
  const result = runAdoptionUnit({ db, profile, now, parts: snapshot.parts });
  if (result.worked) return { worked: true, nextWake: result.more || packageRunning(db) ? now() + 1_000 : null };
  // Pacote do contador: uma parte pequena por acordada, depois da adoção.
  if (!packageRunning(db) || !snapshot.parts.fiscal) return { worked: false, nextWake: null };
  const unit = await runPackageUnit({ db, profile, media: dependencies.media ?? null, now });
  return { worked: unit.worked, nextWake: unit.more ? now() + 1_000 : null };
}

/** Mão dupla, parte local (sem I/O): aplica no ERP o que a coleta trouxe e
 * varre o que mudou no ERP para a fila de saída. Uma unidade por acordada. */
export async function runTwoWayWake(profile: string, dependencies: AdoptionDependencies): Promise<{ worked: boolean; nextWake: number | null }> {
  const now = dependencies.now ?? (() => Date.now());
  const snapshot = readErpPartsSnapshot(await dependencies.readSnapshot(), profile, now());
  if (!snapshot?.parts.customers) return { worked: false, nextWake: null };
  const db = storageDriver(dependencies.storage);
  const result = runTwoWayLocalUnit({ db, profile, now, parts: snapshot.parts });
  if (result.worked) return { worked: true, nextWake: result.more ? now() + 1_000 : null };
  // Fatia D: listas de preços e campos customizados, com interruptores próprios.
  const extras = runExtrasTwoWayLocal({ db, profile, now, parts: snapshot.parts });
  return { worked: extras.worked, nextWake: extras.more ? now() + 1_000 : null };
}
