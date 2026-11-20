import { ApiError, type Env } from "../../types";
import { erpPartsEnvelope } from "../../modules/erp/parts-state";
import { COM1_CONNECTION_HEADER, type CommercialConnectionCheck } from "../domains/fiscal/comnfe/settings.ts";
import { erpIdentity } from "../../modules/erp/identity";
import { erpPrivacy, erpPrivacyChanged, erpPrivacyDenies, type ErpPrivacy } from "../../customer/erp-privacy";
import { erpFetch } from "../hub.ts";
import { encodeIdentity, GATE_HEADER, GATE_DENIED_HEADER, IDENTITY_HEADER, SYSTEM_HEADER, type IdentityPort } from "../engine/identity.ts";
import { FISCAL_MODULE_HEADER } from "../engine/module-state.ts";
import { COM1_AUTHORITY_HEADER, com1ActionForRpc, com1ExecutionActor } from "../domains/fiscal/comnfe/access.ts";
import type { CommercialNfeHttpContext } from "./routes.ts";
import type {
  CancelClaimInput, CancelClaimResult, CancelRecordInput, CancellationView, CancellationXmlInput,
  ClaimInput, ClaimResult, CommercialSettings, ConfigSaveInput, EffectInput, EffectView,
  EmissionPage, EmissionView, ListInput, PreparationResult, PrepareInput, ReadInput, RecordInput,
} from "./contracts.ts";

/** Inventário fechado: o HTTP nunca fornece nome de RPC, ator ou capacidade. */
export interface CommercialNfeRpcMap {
  erp_com1_config_get: { input: undefined; output: CommercialSettings };
  erp_com1_config_save: { input: ConfigSaveInput; output: CommercialSettings };
  erp_com1_prepare: { input: PrepareInput; output: PreparationResult };
  erp_com1_get: { input: ReadInput; output: EmissionView };
  erp_com1_list: { input: ListInput; output: EmissionPage };
  erp_com1_claim: { input: ClaimInput; output: ClaimResult };
  erp_com1_record: { input: RecordInput; output: EmissionView };
  erp_com1_cancel_claim: { input: CancelClaimInput; output: CancelClaimResult };
  erp_com1_cancel_record: { input: CancelRecordInput; output: EmissionView };
  erp_com1_cancel_xml_record: { input: CancellationXmlInput; output: CancellationView };
  erp_com1_effect_apply: { input: EffectInput; output: EffectView };
  erp_com1_effect_reverse: { input: EffectInput; output: EffectView };
}

export interface CommercialNfeBridge {
  call<K extends keyof CommercialNfeRpcMap>(name: K, input: CommercialNfeRpcMap[K]["input"]): Promise<CommercialNfeRpcMap[K]["output"]>;
}

export interface CommercialNfeBridgeDependencies {
  /** Somente transporte interno Worker → Coordinator; não é o fetch do cofre. */
  rpcFetch?: typeof erpFetch;
  privacy?: typeof erpPrivacy;
  /** Releitura autenticada antes de novos comandos e efeitos. Nunca é fornecida pelo HTTP. */
  resolveIdentity?: (context: CommercialNfeHttpContext) => Promise<IdentityPort>;
  /** Renova a fotografia após o I/O; não concede identidade ao commit de evidência. */
  partsEnvelope?: typeof erpPartsEnvelope;
  /** Estado público conferido do cofre, exclusivamente na gravação da configuração. */
  connection?: (context: CommercialNfeHttpContext) => Promise<CommercialConnectionCheck | null>;
}

const RPC_NAMES = new Set<keyof CommercialNfeRpcMap>([
  "erp_com1_config_get", "erp_com1_config_save", "erp_com1_prepare", "erp_com1_get", "erp_com1_list",
  "erp_com1_claim", "erp_com1_record", "erp_com1_cancel_claim", "erp_com1_cancel_record",
  "erp_com1_cancel_xml_record", "erp_com1_effect_apply", "erp_com1_effect_reverse",
]);
const EVIDENCE_NAMES = new Set<keyof CommercialNfeRpcMap>([
  "erp_com1_record", "erp_com1_cancel_record", "erp_com1_cancel_xml_record",
]);
const privacyDenied = () => new ApiError(403, "erp_customer_restricted", "O acesso ao cadastro mudou. Atualize a consulta.");
const PUBLIC_MESSAGES: Record<string, string> = {
  fiscal_connection_changed: "Esta emissão pertence a outro cofre. Restabeleça a conexão original para consultar o resultado.",
  fiscal_provider_not_configured: "Configure o endereço e a chave do cofre para emitir esta nota.",
  fiscal_provider_incompatible: "A versão do cofre não é compatível com esta integração.",
  fiscal_environment_not_allowed: "A chave do cofre não permite o ambiente selecionado.",
  fiscal_production_not_enabled: "Um administrador precisa habilitar a emissão em produção.",
  fiscal_source_changed: "O pedido ou os dados fiscais mudaram. Atualize a preparação e confira novamente.",
  fiscal_environment_conflict: "Este pedido já foi usado em outro ambiente. Use um novo pedido para produção.",
  fiscal_command_conflict: "Este comando já foi usado com outros dados. Atualize a tela.",
  com1_version_conflict: "A emissão foi atualizada em outra operação. Consulte a situação atual antes de continuar.",
  module_disabled: "Esta operação depende de uma parte desligada.",
};

/** A cópia sem símbolos não herda o cache da autenticação anterior ao I/O. */
async function currentIdentity(context: CommercialNfeHttpContext): Promise<IdentityPort> {
  const env = Object.fromEntries(Object.entries(context.env)) as Env;
  return erpIdentity(env, context.actor, context.profile, context.request.method, new URL(context.request.url).pathname);
}

function executionIdentity(context: CommercialNfeHttpContext, identity: IdentityPort, name: string, input: unknown): IdentityPort {
  const action = com1ActionForRpc(name, input);
  return identity.actor && action ? { ...identity, actor: com1ExecutionActor(identity.actor, action, context.authority) } : identity;
}

function upstreamError(status: number, value: unknown, gate: string | null): ApiError {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const error = raw.error && typeof raw.error === "object" ? raw.error as Record<string, unknown> : raw;
  const sql = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  // Só códigos curtos publicados; mensagens SQLite/provedor podem conter dados fiscais.
  const code = /^[a-z][a-z0-9_]{1,100}$/.test(message) ? message
    : /^[a-z][a-z0-9_]{1,100}$/.test(sql) ? sql : "fiscal_operation_failed";
  if (gate || ["42501", "28000"].includes(sql))
    return new ApiError(403, gate === "mfa_required" ? "ERP_MFA_REQUIRED" : code, "Seu acesso não permite esta operação fiscal.");
  if (sql === "P0002" || status === 404) return new ApiError(404, code, "Emissão não encontrada ou não visível.");
  if (sql === "22023") return new ApiError(400, code, "Confira os dados informados para a operação.");
  if (["fiscal_blocked", "com1_emission_blocked", "com1_preparation_blocked"].includes(code)) return new ApiError(422, code, "Corrija os bloqueios fiscais antes de emitir.");
  if (["40001", "23505", "55000", "0A000"].includes(sql) || status === 409)
    return new ApiError(409, code, PUBLIC_MESSAGES[code] ?? "A operação precisa ser revisada. Consulte a emissão e sua configuração.");
  return new ApiError(status >= 400 && status <= 599 ? status : 502, code, "Não foi possível concluir a comunicação com o ERP.");
}

/** Cada chamada termina uma transação do motor; nenhuma aguarda o cofre. */
export function createCommercialNfeBridge(context: CommercialNfeHttpContext, dependencies: CommercialNfeBridgeDependencies = {}): CommercialNfeBridge {
  const send = dependencies.rpcFetch ?? erpFetch;
  const privacy = dependencies.privacy ?? erpPrivacy;
  return {
    async call<K extends keyof CommercialNfeRpcMap>(name: K, input: CommercialNfeRpcMap[K]["input"]): Promise<CommercialNfeRpcMap[K]["output"]> {
      if (!RPC_NAMES.has(name)) throw new ApiError(400, "fiscal_invalid_operation", "Operação fiscal desconhecida.");
      const evidence = EVIDENCE_NAMES.has(name);
      // Evidência reivindicada não reabre o portão nem projeta uma identidade
      // revogada. Usa o token persistido, nunca o papel nem a fotografia
      // anteriores ao cofre. Renovar partes não pode impedir seu arquivamento
      // se o D1 estiver temporariamente indisponível (o hub valida o token).
      const identity: IdentityPort = evidence ? { actor: null, people: null,
        ...await (dependencies.partsEnvelope ?? erpPartsEnvelope)(context.env, context.profile).catch(() => ({})) }
        : executionIdentity(context, await (dependencies.resolveIdentity ?? currentIdentity)(context), name, input);
      const connection: Record<string, string> = name === "erp_com1_config_save" && dependencies.connection
        ? { [COM1_CONNECTION_HEADER]: JSON.stringify(await dependencies.connection(context)) } : {};
      const policy: ErpPrivacy = evidence ? { restricted_contact_ids: [] } : await privacy(context.env, context.profile);
      const args = {
        ...(evidence ? {} : { p_user_id: identity.actor?.user_id }),
        ...(name === "erp_com1_config_get" ? {} : { p_input: input }),
      };
      if (!evidence && (!identity.actor || erpPrivacyDenies(policy, name, args))) throw privacyDenied();
      const envelope = encodeIdentity({ ...identity, customer_privacy: policy });
      if (envelope.length > 200_000) throw privacyDenied();
      const response = await send(context.env, context.profile, `/erp-rpc/${name}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json", [IDENTITY_HEADER]: envelope, [SYSTEM_HEADER]: "1",
          [COM1_AUTHORITY_HEADER]: JSON.stringify(context.authority),
          ...connection,
          [FISCAL_MODULE_HEADER]: identity.parts?.fiscal ? "1" : "0",
          ...(!evidence ? { [GATE_HEADER]: "1" } : {}),
        },
        body: JSON.stringify(args),
      });
      let result: unknown;
      try { result = await response.json(); }
      catch { throw new ApiError(502, "fiscal_invalid_rpc_response", "O ERP devolveu uma resposta incompleta. Consulte a mesma emissão."); }
      if (!response.ok) throw upstreamError(response.status, result, response.headers.get(GATE_DENIED_HEADER));
      // A evidência é privada para o serviço. A rota revalida a privacidade na
      // resposta pública; uma mudança durante o cofre não pode impedir o commit.
      if (!evidence) {
        const latest = await privacy(context.env, context.profile);
        if (erpPrivacyChanged(policy, latest) || erpPrivacyDenies(latest, name, args, result)) throw privacyDenied();
      }
      return result as CommercialNfeRpcMap[K]["output"];
    },
  };
}
