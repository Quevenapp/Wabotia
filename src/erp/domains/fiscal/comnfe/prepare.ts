/** Preparação síncrona: lê e congela fontes na transação do RPC, sem I/O externo. */
import type { RpcContext } from "../../../engine/registry.ts";
import { raise } from "../../../engine/errors.ts";
import { requireErpParts } from "../../../engine/parts-gate.ts";
import { erpRequirement } from "../../../parts.ts";
import type {
  CommercialNfeSlots, CommercialSettings, EffectView, FiscalBlocker, PrepareInput, PreparationResult,
} from "../../../commercial-nfe/contracts.ts";
import { installCommercialNfeSlots } from "../../../commercial-nfe/slots.ts";
import { requireCom1Access } from "./access.ts";
import { contactRequireVisible } from "../../catalog/contact.ts";
import { readCommercialSettings } from "./settings.ts";
import { com1Reference, com1Uuid, findOrderEmission, getEmissionView, replayCommand, savePreparation } from "./store.ts";
import { capturePreparationSources } from "./source.ts";
import { calculatePreparationTaxes } from "./taxes.ts";
import { mapPreparation } from "./mapper.ts";

const presence = new Set(["nao_se_aplica", "presencial", "internet", "teleatendimento", "entrega_domicilio", "presencial_fora", "outros"]);
function validate(input: PrepareInput): void {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["document_id", "expected_document_version", "command_id", "choices", "new_fiscal_version", "expected_emission_version"].includes(key)))
    raise("22023", "fiscal_invalid_request");
  com1Uuid(input.document_id);
  com1Uuid(input.command_id);
  if (!Number.isSafeInteger(input.expected_document_version) || input.expected_document_version < 1 ||
      (input.expected_emission_version !== undefined && (!Number.isSafeInteger(input.expected_emission_version) || input.expected_emission_version < 1)) ||
      (input.new_fiscal_version !== undefined && typeof input.new_fiscal_version !== "boolean")) raise("22023", "fiscal_invalid_request");
  const choices = input.choices;
  if (!choices || typeof choices !== "object" || Array.isArray(choices) ||
      Object.keys(choices).some(key => !["nature_id", "presence", "final_consumer", "series"].includes(key)) ||
      typeof choices.nature_id !== "string" || !presence.has(choices.presence) || typeof choices.final_consumer !== "boolean")
    raise("22023", "fiscal_invalid_request");
  // Ausência da natureza é bloqueio corrigível; um identificador malformado é erro de formato.
  if (choices.nature_id) com1Uuid(choices.nature_id);
  if (choices.series !== undefined && choices.series !== null &&
      (!Number.isSafeInteger(choices.series) || choices.series < 0 || choices.series > 889)) raise("22023", "fiscal_series_invalid");
}

function configuration(settings: CommercialSettings, choices: PrepareInput["choices"], issuerCnpj: unknown) {
  const blockers: FiscalBlocker[] = [];
  const block = (code: string, field: string, message: string) => blockers.push({ code, field, message, correction: { screen: "fiscal_settings", field } });
  const connection = settings.connection_public;
  if (!connection || !settings.connection_fingerprint) {
    block("fiscal_provider_not_configured", "connection", "Configure o endereço e a chave do cofre para emitir esta nota.");
  } else {
    if (connection.compatible !== true) block("fiscal_provider_incompatible", "connection.version", "A versão do cofre não é compatível com esta integração.");
    if (!Array.isArray(connection.environments) || !connection.environments.includes(settings.environment))
      block("fiscal_environment_not_allowed", "environment", "A chave do cofre não permite o ambiente selecionado.");
    if (connection.issuer_cnpj !== issuerCnpj) block("fiscal_issuer_mismatch", "company.cnpj", "O CNPJ da empresa difere do emitente configurado no cofre.");
  }
  if (settings.environment === "producao" && (!settings.production_enabled_at || !settings.tax_limits_acknowledged_at))
    block("fiscal_production_not_enabled", "environment", "Um administrador precisa habilitar a emissão em produção.");
  const available = Array.isArray(connection?.series) ? connection.series.filter((value): value is { environment: string; series: number } =>
    !!value && typeof value === "object" && "environment" in value && "series" in value &&
    value.environment === settings.environment && Number.isInteger(value.series) && Number(value.series) >= 0 && Number(value.series) <= 889) : [];
  const series = choices.series ?? settings[settings.environment === "homologacao" ? "series_homologacao" : "series_producao"];
  if (connection && ((series === null && available.length !== 1) || (series !== null && !available.some(value => value.series === series))))
    block("fiscal_series_required", "choices.series", "Selecione uma das séries de NF-e disponíveis no cofre para este ambiente.");
  return { blockers, series };
}

/** Prévia não aplica efeitos e não grava skips antes da autorização. A tarefa de efeitos
 * pode fornecer sua prévia detalhada; ausência de depósito/conta nunca vira bloqueio fiscal. */
export function preparationEffectsPreview(ctx: RpcContext, emissionId: string): EffectView[] {
  return (["stock", "finance"] as const).map(axis => ({
    emission_id: emissionId, axis, state: ctx.parts[axis] ? "pendente" : "pulado",
    origin: null, ids: {}, fingerprint: null, reason: ctx.parts[axis] ? "awaiting_fiscal_authorization" : "part_disabled",
    responsible_role: axis === "stock" ? "estoque" : "financeiro", person_id: null, command_id: null,
    result: null, compensation_state: null, compensation_command_id: null, compensation_result: null, updated_at: "0",
  }));
}

/** Implementação instalável do único comando público de preparação. */
export function prepareCommercialNfe(ctx: RpcContext, input: PrepareInput): PreparationResult {
  requireCom1Access(ctx, "prepare");
  requireErpParts(ctx, erpRequirement("erp-vendas", "erp-fiscal"));
  validate(input);
  return ctx.db.transaction(() => {
    // O replay precede releitura de cadastro/versões: resposta perdida não recalcula o corpo.
    const receipt = replayCommand(ctx, { command_id: input.command_id, action: "prepare", args: input });
    if (receipt?.emission_id) {
      const emission = getEmissionView(ctx, receipt.emission_id);
      // Repetição conserva a revisão, mas não conserva uma concessão de leitura revogada.
      const recipient = emission.revision.snapshot.recipient.contact_id;
      const carrier = emission.revision.snapshot.document.carrier_id;
      for (const id of [recipient, carrier]) if (typeof id === "string") {
        if (ctx.identity.customer_privacy?.restricted_contact_ids.includes(id)) raise("42501", "erp_customer_restricted");
        contactRequireVisible(ctx.db, ctx.identity.actor!.user_id, id);
      }
      return { emission, blockers: emission.revision.blockers, effects_preview: preparationEffectsPreview(ctx, emission.id), replayed: true };
    }
    const settings = readCommercialSettings(ctx);
    const previous = findOrderEmission(ctx, input.document_id);
    if (previous && previous.environment !== settings.environment) raise("40001", "fiscal_environment_conflict");
    if (input.new_fiscal_version) {
      if (!previous || !["cancelada", "denegada"].includes(previous.status) || previous.version !== input.expected_emission_version)
        raise("40001", "fiscal_emission_open");
    } else if (previous && !["bloqueada", "preparada", "rejeitada"].includes(previous.status)) {
      // Nem um novo comando pode reescrever uma emissão enviada ou incerta.
      raise("40001", "fiscal_emission_open");
    }
    if (previous && previous.version !== input.expected_emission_version) raise("40001", "com1_version_conflict");
    const fiscalVersion = (previous?.fiscal_version ?? 1) + (input.new_fiscal_version ? 1 : 0);
    const reference = com1Reference(input.document_id, fiscalVersion);
    const sources = capturePreparationSources(ctx, input);
    const config = configuration(settings, input.choices, sources.snapshot.company.cnpj);
    const taxes = calculatePreparationTaxes(sources);
    const mapped = mapPreparation(sources, taxes, { environment: settings.environment, reference, series: config.series });
    const blockers = [...new Map([...sources.blockers, ...config.blockers, ...taxes.blockers, ...mapped.blockers]
      .map(blocker => [`${blocker.field}|${blocker.code}|${blocker.item_id ?? ""}`, blocker])).values()];
    const saved = savePreparation(ctx, {
      ...input, args: input, environment: settings.environment, connection_fingerprint: settings.connection_fingerprint,
      snapshot: sources.snapshot, tax_sources: sources.tax_sources, commercial_hash: sources.commercial_hash,
      source_fingerprint: sources.source_fingerprint, body: blockers.length ? null : mapped.body,
      calculation: mapped.calculation, blockers,
    });
    return { ...saved, blockers: saved.emission.revision.blockers, effects_preview: preparationEffectsPreview(ctx, saved.emission.id) };
  });
}

export const commercialNfePreparationSlots: Pick<CommercialNfeSlots, "prepare"> = Object.freeze({ prepare: prepareCommercialNfe });
/** Sem instalação automática: a integração final decide quando habilitar o percurso. */
export const installCommercialNfePreparation = (): (() => void) => installCommercialNfeSlots(commercialNfePreparationSlots);
