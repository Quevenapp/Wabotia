/** Notas da ordem de serviço (OS, parte 5) pela máquina da NF-e comercial: a
 * nota de serviço (NFS-e) e a de peças (NF-e modelo 55). A ordem já está
 * aprovada quando isto roda e nunca espera a nota: falha, demora ou recusa do
 * cofre deixam a nota pendente, com o motivo, e a ordem segue. Resultado
 * incerto sempre é consultado antes de qualquer novo envio (mesma referência,
 * mesma emissão). Nada aqui lança estoque ou financeiro: são os da fase 3.
 */
import { createHash } from "node:crypto";
import type { CommercialNfeBridge } from "./bridge.ts";
import type { NfseCancelReason, PreparationResult } from "./contracts.ts";
import type { createCommercialNfeService } from "./service.ts";
import { CommercialNfeError } from "./artifacts.ts";
import type { NfseSettingsView, OsNoteKind, OsNoteSection, OsNotesView } from "../domains/fiscal/comnfe/os-notes.ts";
import type { OsNoteSnapshot, OsOrderFiscalState } from "../../modules/os/fiscal/notes.ts";

/** O que o último "Testar conexão" trouxe do cofre para a NFS-e. */
export interface NfseVaultStatus {
  configured: boolean;
  checked_at: number | null;
  /** O cofre emite NFS-e do Sistema Nacional (null: ainda não informou). */
  nfse: boolean | null;
  environments: ("homologacao" | "producao")[];
}
export interface OsNotesServiceDependencies {
  bridge: CommercialNfeBridge;
  base: ReturnType<typeof createCommercialNfeService>;
  /** Estado da ordem no D1 (modules/os/fiscal/notes.ts): aprovação e modelo. */
  order(orderId: string): Promise<OsOrderFiscalState>;
  vaultStatus(): Promise<NfseVaultStatus>;
  /** Anota no D1 da ordem a situação lida (modules/os/fiscal/notes.ts); falha aqui não muda a nota. */
  remember?(orderId: string, notes: OsNoteSnapshot[]): Promise<void>;
}
export type OsNoteAction = "emitir" | "emitir_de_novo" | "consultar" | "cancelar" | "xml" | "pdf" | "xml_cancelamento";
export interface DecoratedSection extends OsNoteSection {
  label: string;
  /** Situação em palavras e o que fazer. */
  situation: string;
  /** Por que não dá para emitir agora (null quando dá ou já saiu). */
  reason: string | null;
  actions: OsNoteAction[];
  /** O que continua lançado quando a nota é cancelada. */
  effects_note: string | null;
}
export interface OsNotesOverview {
  order: { id: string; title: string | null; status: string | null; eligible: boolean; reason: string | null; require_invoice_to_deliver: boolean };
  vault: NfseVaultStatus;
  environment: string;
  document: OsNotesView["document"];
  notes: DecoratedSection[];
  /** Há nota autorizada (de serviço ou de peças) vigente. */
  authorized: boolean;
}

const IN_FLIGHT = ["enviando", "processando", "incerta"];
const RETRY = ["cancelada", "denegada"];
const LABEL: Record<OsNoteKind, string> = { nfse: "Nota de serviço (NFS-e)", nfe: "Nota de peças (NF-e)" };
const EFFECTS_NOTE = "Cancelar a nota não desfaz a ordem: o estoque e o financeiro lançados pela ordem continuam lançados. Se precisar desfazê-los, cancele ou estorne pela ordem e pelo ERP.";
export const OS_NOTE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  com1_not_ready: "As notas da ordem ainda não estão habilitadas nesta instalação. A ordem continua sem nota.",
  module_disabled: "As notas da ordem dependem da parte Fiscal ligada (e, na nota de peças, de Vendas e Produtos). Peça ao administrador para ligá-las em Gestão → Módulos.",
  fiscal_forbidden: "Seu papel no ERP não permite esta operação da nota. Peça a quem tem o papel fiscal ou de administrador.",
  os_document_missing: "A ordem ainda não tem o documento comercial no ERP. Monte e aprove o orçamento; a integração com o ERP gera o documento.",
  fiscal_emission_open: "Esta nota já foi emitida ou está em andamento. Consulte a nota antes de pedir outra.",
  fiscal_environment_conflict: "Esta ordem já teve nota em outro ambiente fiscal (homologação ou produção). Use uma ordem nova.",
  com1_version_conflict: "A nota foi atualizada em outra tela. Atualize e tente de novo.",
  fiscal_config_conflict: "A configuração da nota de serviço mudou em outra tela. Atualize e salve de novo.",
  fiscal_nature_missing: "Escolha uma natureza de operação de venda ativa para a nota de peças.",
  fiscal_provider_not_configured: "Configure o endereço e a chave do cofre em Preferências do Fiscal e use Testar conexão.",
  erp_customer_restricted: "O cadastro do cliente desta ordem está restrito para você.",
  fiscal_command_conflict: "Este pedido já foi usado com outros dados. Atualize a tela e tente de novo.",
  nfse_service_missing: "Um dos serviços informados não existe mais no catálogo. Atualize a tela.",
});
const step = (command: string, name: string) => {
  const h = createHash("sha256").update(`${command}:os-notas:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const first = (messages: { code: string; description: string }[] | undefined) => messages?.find(m => m.description)?.description ?? null;

/** Situação da nota em palavras, como a tela mostra. */
export function osNoteSituation(section: OsNoteSection): string {
  const e = section.emission, kind = section.kind === "nfse" ? "prefeitura" : "SEFAZ";
  if (!e) return section.lines.length ? "Ainda não emitida." : section.kind === "nfse" ? "A ordem não tem serviços." : "A ordem não tem peças.";
  if (e.cancellation && e.cancellation.state !== "registrado")
    return e.cancellation.state === "recusado"
      ? `O cancelamento foi recusado: ${first(e.cancellation.messages) ?? `a ${kind} não aceitou`}. A nota continua autorizada.`
      : "Cancelamento pedido e ainda sem confirmação. Use Consultar antes de tentar de novo.";
  switch (e.status) {
    case "autorizada": return `Autorizada${e.number ? ` (${section.kind === "nfse" ? `NFS-e ${e.protocol ?? ""}, DPS ${e.number}` : `nº ${e.number}, série ${e.series}`})` : ""}.`;
    case "cancelada": return e.cancellation?.xml_status === "pendente" ? "Cancelada. O XML do cancelamento ainda não foi guardado: use Consultar." : "Cancelada.";
    case "rejeitada": return `Recusada: ${first(e.messages) ?? `a ${kind} não deu o motivo`}. Corrija o cadastro e emita de novo.`;
    case "denegada": return `Denegada: ${first(e.messages) ?? "sem descrição do governo"}. Procure o contador.`;
    case "processando": return `A ${kind} ainda está processando a nota. Use Consultar em instantes.`;
    case "enviando": case "incerta": return `O resultado do envio não chegou${first(e.messages) ? ` (${first(e.messages)})` : ""}: a nota pode ter saído. Use Consultar antes de qualquer reenvio.`;
    case "bloqueada": return `Falta um dado para a nota: ${e.blockers[0]?.message ?? "corrija e emita de novo"}.`;
    default: return "Preparada, ainda não enviada.";
  }
}

export function createOsNotesService(dependencies: OsNotesServiceDependencies) {
  const { bridge, base } = dependencies;
  const notes = (orderId: string) => bridge.call("erp_com1_os_notes", { order_id: orderId });

  function decorate(section: OsNoteSection, order: OsOrderFiscalState, vault: NfseVaultStatus): DecoratedSection {
    const e = section.emission, status = e?.status;
    let reason: string | null = null;
    if (!e || ["bloqueada", "preparada", "rejeitada", ...RETRY].includes(status!)) {
      if (!section.lines.length) reason = section.kind === "nfse" ? "A ordem não tem serviços no orçamento." : "A ordem não tem peças no orçamento.";
      else if (!order.eligible) reason = order.reason;
      else if (!vault.configured) reason = "O cofre não está configurado: configure o endereço e a chave em Preferências do Fiscal e use Testar conexão.";
      else if (section.kind === "nfse" && vault.nfse === false) reason = "O cofre configurado não emite NFS-e do Sistema Nacional. Prefeituras com provedor próprio ainda não são atendidas.";
      else if (section.blockers.length && !RETRY.includes(status ?? "")) reason = section.blockers[0].message;
    }
    const actions: OsNoteAction[] = [];
    const pending = e?.cancellation && ["pedido", "enviando", "incerto"].includes(e.cancellation.state);
    if (e && (IN_FLIGHT.includes(e.status) || pending || (e.status === "cancelada" && e.cancellation?.xml_status === "pendente"))) actions.push("consultar");
    if (!reason && section.lines.length && (!e || ["bloqueada", "preparada", "rejeitada"].includes(e.status))) actions.push("emitir");
    if (!reason && e && RETRY.includes(e.status) && order.eligible) actions.push("emitir_de_novo");
    if (e?.status === "autorizada") actions.push("cancelar", "xml", ...(section.kind === "nfe" ? ["pdf" as const] : []));
    if (e?.status === "cancelada") actions.push("xml", ...(e.cancellation?.xml_status === "disponivel" ? ["xml_cancelamento" as const] : []));
    return { ...section, label: LABEL[section.kind], situation: osNoteSituation(section), reason, actions: [...new Set(actions)],
      effects_note: e && ["autorizada", "cancelada"].includes(e.status) ? EFFECTS_NOTE : null };
  }

  async function overview(orderId: string): Promise<OsNotesOverview> {
    const [order, vault] = await Promise.all([dependencies.order(orderId), dependencies.vaultStatus()]);
    if (!order.found) throw new CommercialNfeError(404, "os_order_not_found", order.reason ?? "Ordem de serviço não encontrada nesta área.");
    const view = await notes(orderId);
    try {
      await dependencies.remember?.(orderId, [view.nfse, view.nfe].map(section => ({ kind: section.kind, emission: section.emission
        ? { id: section.emission.id, status: section.emission.status, number: section.emission.number, protocol: section.emission.protocol, environment: section.emission.environment } : null })));
    } catch { /* Só a conferência da entrega usa esta anotação; a próxima leitura refaz. */ }
    const sections = [view.nfse, view.nfe].filter(section => section.lines.length || section.emission).map(section => decorate(section, order, vault));
    return { order: { id: orderId, title: order.title, status: order.status, eligible: order.eligible, reason: order.reason, require_invoice_to_deliver: order.require_invoice_to_deliver },
      vault, environment: view.environment, document: view.document, notes: sections,
      authorized: [view.nfse, view.nfe].some(section => section.emission?.status === "autorizada") };
  }
  async function section(orderId: string, kind: OsNoteKind): Promise<OsNoteSection> {
    return (await notes(orderId))[kind];
  }

  async function consult(orderId: string, kind: OsNoteKind, command: string): Promise<OsNotesOverview> {
    const e = (await section(orderId, kind)).emission;
    if (!e) throw new CommercialNfeError(409, "os_note_missing", "Esta nota ainda não foi emitida: não há o que consultar.");
    if (IN_FLIGHT.includes(e.status))
      await base.resume({ emission_id: e.id, command_id: step(command, "resume"), expected_version: e.version, body_revision: e.body_revision });
    else if (e.cancellation && (e.cancellation.state !== "registrado" || e.cancellation.xml_status === "pendente") && e.cancellation.state !== "recusado")
      // Retoma o mesmo cancelamento (mesma justificativa): nunca pede outro.
      await base.cancel({ emission_id: e.id, command_id: step(command, "cancel"), expected_version: e.version, justification: e.cancellation.justification });
    return overview(orderId);
  }

  async function emit(orderId: string, kind: OsNoteKind, command: string): Promise<{ overview: OsNotesOverview; blocked: boolean }> {
    const [order, vault] = await Promise.all([dependencies.order(orderId), dependencies.vaultStatus()]);
    if (!order.found) throw new CommercialNfeError(404, "os_order_not_found", order.reason ?? "Ordem de serviço não encontrada nesta área.");
    const current = (await notes(orderId))[kind], e = current.emission;
    // Pedir de novo sobre uma emissão em andamento vira consulta.
    if (e && IN_FLIGHT.includes(e.status)) return { overview: await consult(orderId, kind, command), blocked: false };
    if (e && e.status === "autorizada") throw new CommercialNfeError(409, "fiscal_emission_open", "Esta nota já está autorizada. Para emitir outra, cancele a atual primeiro.");
    if (!order.eligible) throw new CommercialNfeError(409, "os_note_not_allowed", order.reason ?? "A ordem ainda não permite emitir a nota.");
    if (kind === "nfse" && vault.nfse === false)
      throw new CommercialNfeError(409, "fiscal_nfse_not_supported", "O cofre configurado não emite NFS-e do Sistema Nacional. Prefeituras com provedor próprio ainda não são atendidas.");
    const prepared: PreparationResult = await bridge.call("erp_com1_os_prepare", { order_id: orderId, kind, command_id: step(command, "prepare"),
      ...(e ? { expected_emission_version: e.version } : {}), ...(e && RETRY.includes(e.status) ? { new_fiscal_version: true } : {}) });
    if (prepared.blockers.length || !prepared.emission.revision.body_hash) return { overview: await overview(orderId), blocked: true };
    await base.emit({ emission_id: prepared.emission.id, command_id: step(command, "emit"), expected_version: prepared.emission.version,
      body_revision: prepared.emission.current_body_revision, body_hash: prepared.emission.revision.body_hash });
    return { overview: await overview(orderId), blocked: false };
  }

  async function cancel(orderId: string, kind: OsNoteKind, command: string, justification: string, reason?: NfseCancelReason): Promise<OsNotesOverview> {
    const e = (await section(orderId, kind)).emission;
    if (!e || (e.status !== "autorizada" && !(e.status === "cancelada" && e.cancellation?.state === "incerto")))
      throw new CommercialNfeError(409, "com1_cancellation_requires_authorization", "Só a nota autorizada pode ser cancelada.");
    await base.cancel({ emission_id: e.id, command_id: step(command, "cancel"), expected_version: e.version, justification,
      ...(kind === "nfse" ? { reason: reason ?? "outros" } : {}) });
    return overview(orderId);
  }

  async function file(orderId: string, kind: OsNoteKind, which: "xml" | "pdf" | "cancellation"): Promise<Response> {
    const e = (await section(orderId, kind)).emission;
    if (!e) throw new CommercialNfeError(409, "fiscal_artifact_unavailable", "Esta nota ainda não foi emitida.");
    if (which === "pdf" && kind === "nfse")
      throw new CommercialNfeError(409, "fiscal_nfse_pdf_unavailable", "O cofre não gera o PDF da nota de serviço. Baixe o XML ou consulte a nota no Portal Nacional da NFS-e pela chave.");
    return which === "pdf" ? base.danfe({ emission_id: e.id }) : which === "xml" ? base.xml({ emission_id: e.id }) : base.cancellationXml({ emission_id: e.id });
  }

  return {
    overview, emit, consult, cancel, file,
    config: async (): Promise<NfseSettingsView & { vault: NfseVaultStatus }> => ({ ...await bridge.call("erp_com1_nfse_config_get", undefined), vault: await dependencies.vaultStatus() }),
    saveConfig: (input: Record<string, unknown>) => bridge.call("erp_com1_nfse_config_save", input),
  };
}
export type OsNotesService = ReturnType<typeof createOsNotesService>;
