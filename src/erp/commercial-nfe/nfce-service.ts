/** Cupom fiscal do balcão (NFC-e) pela máquina da NF-e comercial. A venda já
 * está concluída no caixa quando isto roda: nada aqui desfaz ou segura a
 * venda. Falha, demora ou recusa do cofre deixam o cupom pendente, com o
 * motivo, e o caixa segue. Resultado incerto sempre é consultado antes de
 * qualquer novo envio (mesma referência, mesma emissão).
 */
import { createHash } from "node:crypto";
import type { CommercialNfeBridge, NfceConfigView, NfceSaleRow, NfceSalesInput, NfceSalesPage } from "./bridge.ts";
import type { EmissionView } from "./contracts.ts";
import type { createCommercialNfeService } from "./service.ts";
import { CommercialNfeError } from "./artifacts.ts";
import { NFCE_CANCEL_MINUTES } from "./nfce-metadata.ts";

/** O que o cofre informou no último "Testar conexão", só o que vale para a NFC-e. */
export interface NfceVaultStatus {
  configured: boolean;
  checked_at: number | null;
  /** UFs em que o cofre emite NFC-e (null: o cofre não informou). */
  ufs: string[] | null;
  series: { environment: "homologacao" | "producao"; series: number; next_number: number | null }[];
  contingency_pending: number | null;
  certificate_days_left: number | null;
  environments: ("homologacao" | "producao")[];
}
export interface NfceServiceDependencies {
  bridge: CommercialNfeBridge;
  base: ReturnType<typeof createCommercialNfeService>;
  vaultStatus(): Promise<NfceVaultStatus>;
  now?: () => number;
}
type Situation = NfceSaleRow & { reason: { code: string; text: string } | null; cancel_until: string | null; actions: string[] };

const IN_FLIGHT = ["enviando", "processando", "incerta"];
const step = (command: string, name: string) => {
  const h = createHash("sha256").update(`${command}:nfce-http:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const first = (messages: { code: string; description: string }[] | undefined) => messages?.find(m => m.description)?.description ?? null;

/** Motivo em palavras para a lista de cupons pendentes. */
export function nfceReason(row: NfceSaleRow): { code: string; text: string } | null {
  const coupon = row.coupon;
  if (row.situation === "autorizado" || row.situation === "cancelado" || row.situation === "sem_cupom") {
    if (coupon?.cancellation && coupon.cancellation.state !== "registrado")
      return { code: "cancel_pending", text: `Cancelamento do cupom ainda sem confirmação: ${first(coupon.cancellation.messages) ?? "consulte o cupom antes de tentar de novo."}` };
    return null;
  }
  if (!coupon) return { code: "not_requested", text: "O cupom ainda não foi pedido ao cofre para esta venda. Use \"Tentar de novo\"." };
  if (coupon.status === "bloqueada") {
    const blocker = coupon.blockers[0];
    return { code: "blocked", text: blocker ? `Falta um dado para o cupom: ${blocker.message}` : "Falta um dado para o cupom. Corrija e reenvie." };
  }
  if (coupon.status === "rejeitada") return { code: "rejected", text: `A SEFAZ recusou o cupom: ${first(coupon.messages) ?? "sem descrição do governo"}. Corrija e reenvie.` };
  if (coupon.status === "denegada") return { code: "denied", text: `A SEFAZ denegou o cupom: ${first(coupon.messages) ?? "sem descrição do governo"}. Procure o contador.` };
  if (coupon.status === "processando" && coupon.provider_status === "contingency")
    return { code: "contingency", text: "Cupom emitido em contingência (SEFAZ fora do ar): já vale para o cliente e o cofre transmite sozinho quando a SEFAZ voltar. Use \"Consultar\" para conferir." };
  if (coupon.status === "processando") return { code: "processing", text: "A SEFAZ ainda está processando o cupom. Use \"Consultar\" em instantes." };
  if (coupon.status === "incerta" || coupon.status === "enviando")
    return { code: "uncertain", text: `O resultado do envio não chegou${first(coupon.messages) ? ` (${first(coupon.messages)})` : ""}: o cupom pode ter saído. Use \"Consultar\" antes de qualquer reenvio.` };
  return { code: "pending", text: "O cupom ainda não foi autorizado. Use \"Consultar\"." };
}

export function createNfceService(dependencies: NfceServiceDependencies) {
  const { bridge, base } = dependencies, now = dependencies.now ?? Date.now;
  const environment = async () => (await base.configGet()).environment;
  const deadline = (row: NfceSaleRow) => row.coupon?.authorized_at && /^\d+$/.test(row.coupon.authorized_at)
    ? String(BigInt(row.coupon.authorized_at) + BigInt(NFCE_CANCEL_MINUTES) * 60_000_000n) : null;
  const decorate = (row: NfceSaleRow): Situation => {
    const until = row.situation === "autorizado" ? deadline(row) : null, status = row.coupon?.status;
    const actions = row.situation !== "pendente" ? [] : status && IN_FLIGHT.includes(status) ? ["consultar"]
      : status === "denegada" ? [] : status === "bloqueada" || status === "rejeitada" ? ["tentar_de_novo", "corrigir_e_reenviar"] : ["tentar_de_novo"];
    if (row.situation === "autorizado") actions.push("imprimir", until && BigInt(until) >= BigInt(now()) * 1000n ? "cancelar" : "devolucao");
    if (row.coupon?.provider_status === "contingency" && status === "processando") actions.push("imprimir");
    return { ...row, reason: nfceReason(row), cancel_until: until, actions };
  };
  async function sale(saleId: string): Promise<Situation> {
    const page = await bridge.call("erp_com1_nfce_sales", { environment: await environment(), sale_id: saleId });
    const row = page.items.find(item => item.sale_id === saleId);
    if (!row) throw new CommercialNfeError(404, "erp_pos_not_found", "Venda do caixa não encontrada ou sem acesso.");
    return decorate(row);
  }
  const series = async () => {
    const status = await dependencies.vaultStatus(), env = await environment();
    const available = status.series.filter(item => item.environment === env).map(item => item.series).sort((a, b) => a - b);
    // Uma série: vai no pedido. Várias: a menor (o caixa ainda não escolhe a sua). Nenhuma: bloqueio em palavras.
    return { series: available[0] ?? null, series_count: available.length };
  };
  /** Consulta a emissão aberta (nunca reenvia por cima de um resultado incerto). */
  async function consult(saleId: string, command: string): Promise<Situation> {
    const row = await sale(saleId), coupon = row.coupon;
    if (!coupon || !IN_FLIGHT.includes(coupon.status)) return row;
    try {
      await base.resume({ emission_id: coupon.emission_id, command_id: step(command, `resume:${coupon.version}`),
        expected_version: coupon.version, body_revision: coupon.body_revision });
    } catch { /* Cofre fora do ar: o cupom continua pendente com o motivo. */ }
    return sale(saleId);
  }
  async function emit(saleId: string, command: string, consumer: string | null): Promise<Situation> {
    const row = await sale(saleId);
    if (row.sale_state !== "finished") throw new CommercialNfeError(409, "nfce_sale_not_finished", "Só a venda finalizada no caixa recebe cupom fiscal.");
    const coupon = row.coupon;
    if (coupon && IN_FLIGHT.includes(coupon.status)) return consult(saleId, command);
    if (coupon && ["autorizada", "cancelada", "denegada"].includes(coupon.status)) return row;
    const prepared = await bridge.call("erp_com1_nfce_prepare", { sale_id: saleId, command_id: step(command, "prepare"),
      ...(consumer ? { consumer_document: consumer } : {}), ...await series(), ...(coupon ? { expected_emission_version: coupon.version } : {}) });
    const emission: EmissionView = prepared.emission;
    if (emission.status !== "preparada" || !emission.revision.body_hash) return sale(saleId);
    try {
      await base.emit({ emission_id: emission.id, command_id: step(command, `emit:${emission.current_body_revision}`), expected_version: emission.version,
        body_revision: emission.current_body_revision, body_hash: emission.revision.body_hash });
    } catch { /* A venda já está feita: falha do cofre deixa o cupom pendente. */ }
    return sale(saleId);
  }
  async function cancel(saleId: string, command: string, justification: string, physicalReturn: boolean): Promise<Situation> {
    let row = await sale(saleId);
    const coupon = row.coupon;
    if (!coupon || !["autorizada", "cancelada"].includes(coupon.status))
      throw new CommercialNfeError(409, "nfce_not_authorized", "Esta venda não tem cupom autorizado para cancelar. Sem cupom, cancele a venda pelo caixa.");
    if (coupon.status === "autorizada") {
      const until = deadline(row);
      if (!until || BigInt(until) < BigInt(now()) * 1000n)
        throw new CommercialNfeError(409, "nfce_cancel_deadline", `O prazo de ${NFCE_CANCEL_MINUTES} minutos para cancelar o cupom já passou. A venda não foi cancelada: registre uma devolução (fora desta etapa) e combine com o contador.`);
      await base.cancel({ emission_id: coupon.emission_id, command_id: step(command, "cancel"), expected_version: coupon.version, justification });
      row = await sale(saleId);
      if (row.coupon?.status !== "cancelada") return row;
    }
    // Só depois do cancelamento fiscal: a venda, o estoque e as contas.
    if (row.sale_state === "finished")
      await bridge.call("erp_com1_nfce_sale_cancel", { emission_id: coupon.emission_id, command_id: step(command, "sale"),
        reason: `Cupom fiscal cancelado: ${justification}`.slice(0, 1000), physical_return_confirmed: physicalReturn });
    // A compensação da nota reconhece os estornos feitos pela venda.
    for (const axis of ["stock", "finance"] as const) {
      try {
        const current = await base.read({ emission_id: coupon.emission_id });
        await base.effects({ emission_id: coupon.emission_id, command_id: step(command, `reverse:${axis}:${current.version}`), expected_version: current.version,
          axis, intent: "reverse", ...(axis === "stock" ? { physical_return_confirmed: physicalReturn } : {}) });
      } catch { /* Pendência de compensação continua visível no Fiscal. */ }
    }
    return sale(saleId);
  }
  return {
    async config(): Promise<{ nature: NfceConfigView; vault: NfceVaultStatus; environment: string; production_enabled: boolean; missing: string[] }> {
      const [nature, vault, settings] = await Promise.all([bridge.call("erp_com1_nfce_config_get", undefined), dependencies.vaultStatus(), base.configGet()]);
      const missing: string[] = [];
      if (!vault.configured) missing.push("Configure o endereço e a chave do cofre e use Testar conexão.");
      else {
        if (vault.ufs !== null && !vault.ufs.length) missing.push("O cofre não está liberado para emitir NFC-e. Ative a NFC-e e o CSC no cofre.");
        if (!vault.series.some(item => item.environment === settings.environment)) missing.push(`O cofre não tem série de NFC-e em ${settings.environment === "producao" ? "produção" : "homologação"}. Cadastre a série no cofre e teste a conexão de novo.`);
        if (!vault.environments.includes(settings.environment)) missing.push("A chave do cofre não permite o ambiente escolhido.");
      }
      if (!nature.resolved_nature_id) missing.push(nature.natures.length ? "Escolha abaixo a natureza de operação do cupom." : "Cadastre uma natureza de operação de venda (saída) para o cupom.");
      return { nature, vault, environment: settings.environment, production_enabled: settings.production_enabled_at !== null, missing };
    },
    saveConfig: (input: { command_id: string; expected_version: number; nature_id: string | null }) => bridge.call("erp_com1_nfce_config_save", input),
    async sales(input: Omit<NfceSalesInput, "environment"> & { environment?: NfceSalesInput["environment"] }): Promise<NfceSalesPage & { items: Situation[] }> {
      const page = await bridge.call("erp_com1_nfce_sales", { ...input, environment: input.environment ?? await environment() });
      return { ...page, items: page.items.map(decorate) };
    },
    get: sale, emit, consult, cancel,
    async coupon(saleId: string, via: "consumer" | "establishment" = "consumer"): Promise<Response> {
      const row = await sale(saleId);
      if (!row.coupon || !row.actions.includes("imprimir"))
        throw new CommercialNfeError(409, "fiscal_artifact_unavailable", "O cupom ainda não foi autorizado pelo cofre. Consulte a situação antes de imprimir.");
      return base.danfe({ emission_id: row.coupon.emission_id }, via);
    },
  };
}
export type NfceService = ReturnType<typeof createNfceService>;
