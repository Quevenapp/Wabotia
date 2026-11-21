/** Depois da NF-e autorizada: carta de correção, inutilização e devolução de
 * venda pelo cofre. Cada passo do motor é uma transação (bridge); o cofre é
 * chamado entre elas, nunca dentro. Resposta perdida nunca vira reenvio às
 * cegas: a carta confere a contagem de cartas da nota antes de reenviar, a
 * inutilização repetida volta "repetida" no cofre, e a devolução usa a mesma
 * referência (wb.<devolução>.v1), que o cofre não emite duas vezes.
 */
import { createHash } from "node:crypto";
import type { FiscalEnvironment, FiscalResult } from "../emissor/provider.ts";
import type { EmissionView, FiscalMessage } from "./contracts.ts";
import type { CommercialNfeBridge } from "./bridge.ts";
import { CommercialNfeError, privateFiscalFile, type CommercialVaultSession } from "./artifacts.ts";
import { correctionPdf, parseCorrectionXml } from "./correction-pdf.ts";
import type {
  CorrectionView, NfeEventsView, ReturnFinanceOption, ReturnItemInput, ReturnView, VoidRangeView,
} from "./events-contracts.ts";

/** O que o último "Testar conexão" disse do cofre para a inutilização. */
export interface VoidVaultStatus {
  configured: boolean;
  version: string | null;
  /** UFs em que o cofre emite (null: não informou). */
  nfe: string[] | null;
  nfce: string[] | null;
  environments: FiscalEnvironment[];
}
export interface NfeEventsServiceDependencies {
  bridge: CommercialNfeBridge;
  /** Sessão do cofre presa à conexão da emissão (ambiente e impressão digital). */
  vault(emission: Pick<EmissionView, "environment" | "connection_fingerprint"> & Partial<EmissionView>): Promise<CommercialVaultSession>;
  vaultStatus(): Promise<VoidVaultStatus>;
  /** Impressão digital da conexão conferida agora (para a inutilização, que não tem nota). */
  fingerprint(): Promise<string | null>;
}
const step = (command: string, name: string) => {
  const h = createHash("sha256").update(`${command}:nfe-events:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
interface ErrorShape { code: string; message: string; messages: FiscalMessage[]; emission: FiscalResult | null }
function errorShape(error: unknown): ErrorShape {
  const object = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const details = object.details && typeof object.details === "object" ? object.details as Record<string, unknown> : {};
  const code = typeof object.code === "string" && /^[a-z][a-z0-9_]{1,100}$/.test(object.code) ? object.code : "fiscal_no_conclusive_answer";
  return { code, message: typeof object.message === "string" ? object.message.slice(0, 500) : "", messages: Array.isArray(details.messages) ? details.messages as FiscalMessage[] : [],
    emission: details.emission && typeof details.emission === "object" ? details.emission as FiscalResult : null };
}
/** Recusa conclusiva do cofre ou da SEFAZ: o pedido não foi registrado e não adianta repetir igual. */
const CONCLUSIVE = new Set(["fiscal_rejected", "fiscal_invalid_request", "fiscal_correction_not_applicable", "fiscal_correction_limit", "fiscal_event_rejected",
  "fiscal_not_authorized", "fiscal_void_range_abolished", "fiscal_range_in_use", "fiscal_number_used", "fiscal_series_not_registered", "fiscal_series_required",
  "fiscal_uf_not_supported", "fiscal_emitter_mismatch", "fiscal_key_homologation_only", "fiscal_production_blocked", "vault_outdated", "fiscal_certificate_missing",
  "fiscal_certificate_expired", "fiscal_document_not_found"]);
const reasonMessages = (shape: ErrorShape): FiscalMessage[] =>
  shape.messages.length ? shape.messages : [{ code: shape.code, description: EVENT_MESSAGES[shape.code] ?? (shape.message || "O cofre não confirmou o pedido.") }];

/** Causas conhecidas, em palavras: o que aconteceu e o que fazer. */
export const EVENT_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  com1_not_ready: "Carta de correção, inutilização e devolução ainda não estão habilitadas nesta instalação.",
  module_disabled: "Carta de correção, inutilização e devolução dependem da parte Fiscal ligada. Peça ao administrador para ligá-la em Gestão → Módulos.",
  fiscal_forbidden: "Seu papel não permite esta operação fiscal. Peça a quem tem o papel fiscal ou ao administrador.",
  com1_emission_not_found: "Nota não encontrada ou sem acesso.",
  nfe_correction_text_invalid: "Escreva a correção com 15 a 1.000 caracteres.",
  nfe_correction_cancelled: "A nota está cancelada: a SEFAZ não aceita carta de correção em nota cancelada. Se a venda continua valendo, emita uma nota nova pelo pedido.",
  nfe_correction_limit: "Esta nota já tem 20 cartas de correção, o limite da SEFAZ. Fale com o contador sobre cancelar (se houver prazo) ou fazer uma nota complementar.",
  nfe_correction_in_flight: "Uma carta de correção desta nota ainda está sem resposta. Use \"Consultar carta\" antes de enviar outra.",
  nfe_correction_not_found: "Carta de correção não encontrada nesta nota.",
  nfe_not_authorized: "A nota ainda não foi autorizada pela SEFAZ. Carta de correção, cancelamento e devolução só valem para nota autorizada.",
  nfe_cancel_in_flight: "O cancelamento desta nota está em andamento. Espere a resposta antes de continuar.",
  nfe_event_model: "Carta de correção e devolução por esta tela valem só para a NF-e de venda (modelo 55).",
  fiscal_correction_not_applicable: "A SEFAZ recusou a carta: o que foi pedido não pode ser corrigido por carta (valores, impostos, destinatário ou data). Cancele no prazo ou faça uma devolução ou nota complementar.",
  fiscal_correction_limit: "A SEFAZ informou que a nota chegou ao limite de 20 cartas de correção.",
  fiscal_command_conflict: "Este pedido já foi usado com outros dados. Atualize a tela e tente de novo.",
  nfe_void_range_invalid: "Confira a série (0 a 889) e a faixa: o número inicial vem antes do final, de 1 a 999.999.999.",
  nfe_void_range_too_large: "A faixa passa de 10.000 números. Divida em pedidos menores.",
  nfe_void_justification_invalid: "Escreva o motivo da inutilização com 15 a 255 caracteres.",
  nfe_void_number_used: "Há nota emitida pelo ERP com número dentro desta faixa. Só número que nunca foi usado pode ser inutilizado.",
  nfe_void_not_found: "Inutilização não encontrada.",
  nfe_void_not_offered: "O cofre desta área não oferece inutilização para este documento. Confira a configuração do emissor.",
  fiscal_void_range_abolished: "Na UF do emitente a inutilização foi extinta (SP, AC e BA). Não há o que fazer: os números pulados não precisam ser inutilizados.",
  fiscal_range_in_use: "O cofre informou que a faixa tem nota autorizada ou em andamento. Só número que nunca foi usado pode ser inutilizado.",
  fiscal_number_used: "O cofre informou que um número da faixa já foi usado.",
  fiscal_series_not_registered: "A série informada não está cadastrada no cofre. Confira a série em Configuração do emissor.",
  nfe_return_cfop_unknown: "Um dos itens escolhidos saiu com um CFOP que não tem devolução conhecida por aqui (a tela mostra qual). Faça a devolução desse item com o contador, pela tela de notas fiscais.",
  nfe_return_items_required:"Escolha pelo menos um item e a quantidade a devolver.",
  nfe_return_item_invalid: "Item da devolução não confere com a nota. Atualize a tela.",
  nfe_return_quantity_invalid: "Confira a quantidade a devolver (até 4 casas decimais).",
  nfe_return_quantity_exceeded: "A quantidade passa do que ainda falta devolver deste item (contando as devoluções em andamento).",
  nfe_return_cancelled: "A nota está cancelada: não há o que devolver, porque ela não vale mais. Confira o estoque e as contas do pedido na compensação do cancelamento.",
  nfe_return_nothing_left: "Todos os itens desta nota já foram devolvidos (ou estão numa devolução em andamento).",
  nfe_return_finance_option_invalid: "Escolha o que fazer com o valor já recebido: crédito do cliente ou conta a pagar de devolução.",
  nfe_return_not_found: "Devolução não encontrada.",
  nfe_return_not_authorized: "A NF-e de devolução ainda não foi autorizada. Consulte a devolução antes de lançar estoque e contas.",
  fiscal_artifact_unavailable: "O arquivo aguarda a autorização da nota no cofre.",
  fiscal_provider_not_configured: "Configure o endereço e a chave do cofre e use Testar conexão em Configuração do emissor.",
  fiscal_connection_changed: "Esta nota pertence a outro cofre. Restabeleça a conexão original para continuar.",
  fiscal_environment_not_allowed: "A chave do cofre não permite o ambiente desta nota.",
  fiscal_provider_incompatible: "A versão do cofre não é compatível com esta integração. Atualize o cofre.",
  com1_version_conflict: "A nota foi atualizada em outra tela. Atualize e tente de novo.",
});
const effectReason: Readonly<Record<string, string>> = Object.freeze({
  part_disabled: "A parte está desligada. Peça ao administrador para ligá-la e use \"Lançar pendências\".",
  local_role_required: "Seu papel não lança este efeito no estoque ou nas contas. Peça ao administrador do ERP para abrir a nota e usar \"Consultar e lançar pendências\".",
  nfe_return_finance_account_missing: "Não há conta financeira ativa para registrar o abatimento. Cadastre uma conta em Financeiro e use \"Lançar pendências\".",
});
export const returnEffectText = (reason: unknown): string | null => typeof reason === "string" ? effectReason[reason] ?? null : null;

export function createNfeEventsService(dependencies: NfeEventsServiceDependencies) {
  const { bridge } = dependencies;
  const events = (emissionId: string): Promise<NfeEventsView> => bridge.call("erp_com1_events_get", { emission_id: emissionId });

  // ---------------------------------------------------------------- carta
  async function correctionXml(vault: CommercialVaultSession, claim: { emission: { provider_id: string | null; access_key: string | null; environment: FiscalEnvironment } }, sequence: number) {
    const xml = await vault.provider.correctionXml(vault.context, claim.emission.provider_id!, sequence);
    return { xml, event: parseCorrectionXml(xml, { access_key: claim.emission.access_key, environment: claim.emission.environment, sequence }) };
  }
  async function correct(emissionId: string, command: string, text: string, resumeOnly = false): Promise<NfeEventsView> {
    const claim = await bridge.call("erp_com1_correction_claim", { emission_id: emissionId, command_id: command, text });
    if (claim.disposition === "replay") return events(emissionId);
    const correction = claim.correction, vault = await dependencies.vault({ ...claim.emission, id: claim.emission.id } as EmissionView);
    const record = (state: "incerto" | "recusado" | "registrado", extra: Record<string, unknown> = {}) =>
      bridge.call("erp_com1_correction_record", { correction_id: correction.id, command_id: correction.command_id, state, ...extra });
    const registered = async () => {
      const { xml, event } = await correctionXml(vault, claim, correction.expected_sequence);
      // A carta na sequência esperada precisa ser esta (outro texto: alguém enviou outra carta pelo cofre).
      if (event.text.replace(/\s+/g, " ").trim() !== correction.text) throw new CommercialNfeError(409, "nfe_correction_mismatch",
        "O cofre tem outra carta nesta sequência. Consulte as cartas da nota no cofre antes de enviar outra.");
      await record("registrado", { sequence: event.sequence, protocol: event.protocol, event_at: event.event_at, xml, xml_hash: sha(xml) });
    };
    try {
      if (claim.disposition === "resume") {
        // Resposta perdida: a nota já tem a carta esperada? Então só arquiva; senão reenvia o mesmo texto.
        const current = await vault.provider.get(vault.context, "nfe", claim.emission.provider_id!, { environment: claim.emission.environment, reference: claim.emission.reference, ...(claim.emission.access_key ? { access_key: claim.emission.access_key } : {}) });
        if (current.corrections >= correction.expected_sequence) { await registered(); return events(emissionId); }
        if (resumeOnly && current.status !== "authorized") { await record("recusado", { messages: [{ code: "nfe_not_authorized", description: EVENT_MESSAGES.nfe_not_authorized }] }); return events(emissionId); }
      }
      const result = await vault.provider.correct(vault.context, claim.emission.provider_id!, correction.text);
      if (result.corrections < correction.expected_sequence && result.event_repeated !== true)
        throw new CommercialNfeError(409, "fiscal_no_conclusive_answer", "O cofre não confirmou a carta.");
      try { await registered(); }
      catch {
        // Carta registrada no cofre; o XML fica para depois (a consulta arquiva).
        await record("registrado", { sequence: Math.max(correction.expected_sequence, Math.min(result.corrections, 20)), messages: result.messages });
      }
    } catch (error) {
      const shape = errorShape(error);
      if (error instanceof CommercialNfeError && error.code === "nfe_correction_mismatch") throw error;
      await record(CONCLUSIVE.has(shape.code) ? "recusado" : "incerto", { messages: reasonMessages(shape) });
    }
    return events(emissionId);
  }
  /** Consulta uma carta sem resposta (mesmo comando e mesmo texto). */
  async function correctionConsult(emissionId: string, correctionId: string): Promise<NfeEventsView> {
    const view = await events(emissionId), item = view.corrections.find(c => c.id === correctionId);
    if (!item) throw new CommercialNfeError(404, "nfe_correction_not_found", EVENT_MESSAGES.nfe_correction_not_found);
    if (item.state === "registrado" && item.xml_available) return view;
    if (item.state === "registrado") {
      // Só falta o XML: arquiva sem reenviar.
      const file = await bridge.call("erp_com1_correction_file", { emission_id: emissionId, sequence: item.sequence! });
      const vault = await dependencies.vault(file.emission as EmissionView);
      const { xml } = await correctionXml(vault, file, item.sequence!);
      await bridge.call("erp_com1_correction_record", { correction_id: item.id, command_id: item.command_id, state: "registrado", xml, xml_hash: sha(xml) });
      return events(emissionId);
    }
    if (item.state === "recusado") return view;
    return correct(emissionId, item.command_id, item.text, true);
  }
  async function correctionFile(emissionId: string, sequence: number, kind: "pdf" | "xml"): Promise<Response> {
    let file = await bridge.call("erp_com1_correction_file", { emission_id: emissionId, sequence });
    if (!file.xml) {
      const vault = await dependencies.vault(file.emission as EmissionView);
      const { xml } = await correctionXml(vault, file, sequence);
      await bridge.call("erp_com1_correction_record", { correction_id: file.correction.id, command_id: file.correction.command_id, state: "registrado", xml, xml_hash: sha(xml) });
      file = { ...file, xml };
    }
    const event = parseCorrectionXml(file.xml!, { access_key: file.emission.access_key, environment: file.emission.environment, sequence });
    const name = `carta-correcao-${file.emission.number ?? "nfe"}-seq${sequence}`;
    const bytes = kind === "xml" ? new TextEncoder().encode(file.xml!) : correctionPdf({ issuer: file.issuer, recipient: file.recipient,
      emission: file.emission, event: { sequence, protocol: event.protocol, event_at: event.event_at, text: event.text } });
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": kind === "pdf" ? "application/pdf" : "application/xml; charset=utf-8",
      "Content-Length": String(bytes.byteLength), "Content-Disposition": `attachment; filename="${name}.${kind}"`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  }

  // ---------------------------------------------------------------- inutilização
  async function voidCapability(): Promise<{ nfe: { offered: boolean; reason: string | null }; nfce: { offered: boolean; reason: string | null } }> {
    const status = await dependencies.vaultStatus();
    const of = (ufs: string[] | null, label: string) => {
      if (!status.configured) return { offered: false, reason: "O cofre ainda não foi configurado e testado. Informe o endereço e a chave do cofre e use Testar conexão." };
      if (ufs !== null && !ufs.length) return { offered: false, reason: `O cofre desta área não emite ${label}, então também não inutiliza numeração de ${label}. Ative o documento no cofre e teste a conexão de novo.` };
      return { offered: true, reason: null };
    };
    return { nfe: of(status.nfe, "NF-e"), nfce: of(status.nfce, "NFC-e") };
  }
  async function voids(environment?: FiscalEnvironment, model?: "nfe" | "nfce") {
    const [list, capability] = await Promise.all([bridge.call("erp_com1_void_list", { ...(environment ? { environment } : {}), ...(model ? { model } : {}) }), voidCapability()]);
    return { items: list.items, capability };
  }
  async function voidRange(input: { command_id: string; model: "nfe" | "nfce"; environment: FiscalEnvironment; series: number; first: number; last: number; justification: string }) {
    const capability = (await voidCapability())[input.model];
    if (!capability.offered) throw new CommercialNfeError(409, "nfe_void_not_offered", capability.reason ?? EVENT_MESSAGES.nfe_void_not_offered);
    const claim = await bridge.call("erp_com1_void_claim", input);
    const done = async () => ({ void: (await voids(input.environment)).items.find(item => item.id === claim.void.id) ?? claim.void, capability });
    if (claim.disposition === "replay") return done();
    const record = (state: "incerto" | "recusado" | "registrado", extra: Record<string, unknown> = {}) =>
      bridge.call("erp_com1_void_record", { void_id: claim.void.id, command_id: claim.void.command_id, state, ...extra });
    if (!claim.uf) { await record("recusado", { messages: [{ code: "company_uf_missing", description: "Informe a UF da empresa em Dados da empresa: a inutilização vai à SEFAZ dela." }] }); return done(); }
    try {
      const fingerprint = await dependencies.fingerprint();
      if (!fingerprint) throw new CommercialNfeError(409, "fiscal_provider_not_configured", EVENT_MESSAGES.fiscal_provider_not_configured);
      const vault = await dependencies.vault({ environment: input.environment, connection_fingerprint: fingerprint, model: input.model === "nfce" ? "nfce" : undefined });
      // O cofre devolve "repetido" para a faixa já inutilizada: repetir depois de resposta perdida é seguro.
      const result = await vault.provider.voidRange(vault.context, { kind: input.model, environment: input.environment, series: input.series,
        first: input.first, last: input.last, justification: claim.void.justification, uf: claim.uf });
      if (result.series !== input.series || result.first !== input.first || result.last !== input.last)
        throw new CommercialNfeError(409, "fiscal_no_conclusive_answer", "O cofre devolveu outra faixa.");
      await record("registrado", { provider_ref: result.provider_ref, protocol: result.protocol, repeated: result.repeated === true });
    } catch (error) {
      const shape = errorShape(error);
      await record(CONCLUSIVE.has(shape.code) ? "recusado" : "incerto", { messages: reasonMessages(shape) });
    }
    return done();
  }

  // ---------------------------------------------------------------- devolução
  const returnView = async (id: string): Promise<ReturnView> => (await bridge.call("erp_com1_return_get", { return_id: id })).return;
  async function effects(ret: ReturnView, command: string): Promise<ReturnView> {
    let current = ret;
    if (current.status !== "autorizada") return current;
    for (const axis of ["stock", "finance"] as const) {
      if (current[axis].state !== "pendente") continue;
      try { current = await bridge.call("erp_com1_return_effects", { return_id: current.id, command_id: step(command, `effect:${axis}`), axis }); }
      catch { /* A pendência fica visível com o motivo; "Lançar pendências" tenta de novo. */ }
    }
    return current;
  }
  async function emitReturn(returnId: string, command: string): Promise<ReturnView> {
    const claim = await bridge.call("erp_com1_return_claim", { return_id: returnId, command_id: step(command, "claim") });
    if (claim.disposition === "replay") return effects(claim.return, command);
    // A devolução usa o mesmo cofre e o mesmo ambiente da nota de origem (o motor gravou a mesma conexão).
    const ret = claim.return, vault = await dependencies.vault(claim.emission as EmissionView);
    const key = { document_id: ret.id, version: 1 }, body = JSON.parse(claim.body_text) as Record<string, unknown>;
    const identity = { environment: ret.environment, reference: ret.reference };
    let result: FiscalResult | null = null, failure: ErrorShape | null = null;
    try {
      if (claim.disposition === "send") result = await vault.provider.emit(vault.context, "nfe", body, key, { keep_issue_date: false });
      else {
        // Retomada: procura a mesma referência; só reenvia se ela nunca chegou ao cofre.
        result = ret.provider_id ? await vault.provider.get(vault.context, "nfe", ret.provider_id, identity) : await vault.provider.find(vault.context, "nfe", key, ret.environment);
        if (!result) result = await vault.provider.emit(vault.context, "nfe", body, key, { keep_issue_date: false });
        else if (["processing", "undetermined"].includes(result.status)) result = await vault.provider.reconcile(vault.context, "nfe", result.provider_ref, identity);
      }
    } catch (error) { failure = errorShape(error); result = failure.emission; }
    const recorded = await bridge.call("erp_com1_return_record", { return_id: ret.id, command_id: ret.command_id, result,
      ...(failure && !result ? { error: { code: failure.code, message: EVENT_MESSAGES[failure.code] ?? failure.message, conclusive: CONCLUSIVE.has(failure.code) } } : {}) });
    return effects(recorded, command);
  }
  async function createReturn(emissionId: string, input: { command_id: string; items: ReturnItemInput[]; finance_option: ReturnFinanceOption }): Promise<ReturnView> {
    const prepared = await bridge.call("erp_com1_return_prepare", { emission_id: emissionId, command_id: input.command_id, items: input.items, finance_option: input.finance_option });
    return emitReturn(prepared.id, input.command_id);
  }
  /** Retomar: consulta a mesma devolução no cofre (ou tenta de novo, se recusada) e lança os efeitos pendentes. */
  async function resumeReturn(returnId: string, command: string): Promise<ReturnView> {
    const current = await returnView(returnId);
    if (current.status === "autorizada") return effects(current, command);
    return emitReturn(returnId, command);
  }
  async function returnFile(returnId: string, kind: "danfe" | "xml"): Promise<Response> {
    const { return: ret, emission } = await bridge.call("erp_com1_return_get", { return_id: returnId });
    if (!ret.provider_id || !["autorizada", "cancelada"].includes(ret.status))
      throw new CommercialNfeError(409, "fiscal_artifact_unavailable", EVENT_MESSAGES.fiscal_artifact_unavailable);
    const vault = await dependencies.vault({ ...emission, connection_fingerprint: emission.connection_fingerprint } as EmissionView);
    const current = await vault.provider.get(vault.context, "nfe", ret.provider_id, { environment: ret.environment, reference: ret.reference, ...(ret.access_key ? { access_key: ret.access_key } : {}) });
    if (current.reference !== ret.reference || current.provider_ref !== ret.provider_id || current.access_key !== ret.access_key)
      throw new CommercialNfeError(409, "fiscal_artifact_mismatch", "O arquivo do cofre não corresponde a esta devolução.");
    if (kind === "danfe") {
      const file = await vault.provider.danfe(vault.context, ret.provider_id);
      if (!/^application\/pdf/i.test(file.content_type) || new TextDecoder().decode(file.body.subarray(0, 5)) !== "%PDF-")
        throw new CommercialNfeError(409, "fiscal_artifact_mismatch", "O arquivo do cofre não corresponde a esta devolução.");
      return privateFiscalFile(ret.id, "danfe", file.body);
    }
    const xml = await vault.provider.xml(vault.context, "nfe", ret.provider_id);
    if (!ret.access_key || !xml.includes(`NFe${ret.access_key}`)) throw new CommercialNfeError(409, "fiscal_artifact_mismatch", "O XML do cofre não corresponde a esta devolução.");
    return privateFiscalFile(ret.id, "xml", new TextEncoder().encode(xml));
  }

  return { events, correct, correctionConsult, correctionFile, voids, voidRange, createReturn, resumeReturn, returnView, returnFile };
}
export type NfeEventsService = ReturnType<typeof createNfeEventsService>;
export type { CorrectionView, VoidRangeView };
