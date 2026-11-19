import { ApiError, type Actor, type Conversation, type Env } from "./types";
import type { CustomerRef, InboundEvidence, Statement } from "./customer/contracts";
import { invalidateCustomerResolution } from "./customer/ports";
import type {
  ChannelAccountDiscovery, ChannelAccountImport, ChannelAccountImportResult,
  ChannelAccountRemoval, ChannelAccountRemovalResult, ChannelConfigurationInput,
  ChannelConfigurationResult, ChannelId, ContactMergePreview, ContactMergePreviewRequest,
  ContactMergeRequest, ContactMergeResult, ContactMergeUndoRequest, CustomerChannelsView,
  SocialEventResult, SocialEventScope, SocialSendInput, SocialSendPlan,
  TranscriptOptions, TranscriptPreview, TranscriptPreviewRequest, TranscriptSendRequest,
  TranscriptSendResult,
} from "./channel-contracts";

export interface ChannelAccountsPort {
  readonly channels: readonly ChannelId[];
  discover(env: Env, actor: Actor, profileId: string, integrationId: string): Promise<ChannelAccountDiscovery>;
  importAccount(env: Env, actor: Actor, profileId: string, input: ChannelAccountImport): Promise<ChannelAccountImportResult>;
  validateConfiguration(env: Env, actor: Actor, profileId: string, input: ChannelConfigurationInput): Promise<ChannelConfigurationResult>;
  removeLink(env: Env, actor: Actor, profileId: string, input: ChannelAccountRemoval): Promise<ChannelAccountRemovalResult>;
}

export interface ChannelIdentityPlan {
  /** Executar junto da inbox/mensagem no mesmo lote D1; preparar não confirma nenhuma escrita. */
  statements: Statement[];
  /** Identidade social nunca herda telefone da ficha, nem após junção administrativa. */
  customer: CustomerRef & { verifiedPhone: null };
  identityId: string;
}
export interface ChannelIdentityPort {
  readonly channels: readonly ChannelId[];
  prepareInbound(env: Env, conversation: Conversation, evidence: Extract<InboundEvidence, { channel: Exclude<ChannelId, "whatsapp"> }>): Promise<ChannelIdentityPlan>;
  readChannels(env: Env, actor: Actor, profileId: string, contactId: string): Promise<CustomerChannelsView>;
  previewMerge(env: Env, actor: Actor, profileId: string, sourceId: string, input: ContactMergePreviewRequest): Promise<ContactMergePreview>;
  /** commandId é a chave idempotente validada; reautorizar também o replay. */
  merge(env: Env, actor: Actor, profileId: string, sourceId: string, commandId: string, input: ContactMergeRequest): Promise<ContactMergeResult>;
  undoMerge(env: Env, actor: Actor, profileId: string, sourceId: string, commandId: string, input: ContactMergeUndoRequest): Promise<ContactMergeResult>;
}
export interface ChannelTranscriptPort {
  options(env: Env, actor: Actor, conversation: Conversation): Promise<TranscriptOptions>;
  preview(env: Env, actor: Actor, conversation: Conversation, input: TranscriptPreviewRequest): Promise<TranscriptPreview>;
  /** Reserva/cota e reautorização pertencem à implementação; a fachada não envia nada. */
  send(env: Env, actor: Actor, conversation: Conversation, commandId: string, input: TranscriptSendRequest): Promise<TranscriptSendResult>;
}
export interface SocialTransportPort {
  readonly channels: readonly ChannelId[];
  /** Leitor único: diferenças de formato do fornecedor são a conferir com a conta real. */
  normalizeEvent(input: unknown, scope: SocialEventScope): Promise<SocialEventResult>;
  /** Produz entregas ordenadas para a outbox; nunca oculta dois envios numa entrega. */
  prepareSend(env: Env, input: SocialSendInput): Promise<SocialSendPlan>;
}

function unavailable(): never {
  throw new ApiError(503, "channel_not_ready", "Este canal ainda não está disponível.");
}
function register<T>(name: string, previous: T | null, next: T): T {
  if (previous !== null && previous !== next)
    throw new Error(`Implementação de ${name} já registrada.`);
  return next;
}

/** Registros isolados servem à composição explícita e aos testes; nenhum instalador faz I/O. */
export function createChannelPorts() {
  let accounts: ChannelAccountsPort | null = null;
  let identity: ChannelIdentityPort | null = null;
  let transcript: ChannelTranscriptPort | null = null;
  let transport: SocialTransportPort | null = null;

  function channelImplementationReady(channel: ChannelId): boolean {
    if (channel === "whatsapp") return true;
    if (channel !== "instagram" && channel !== "facebook") return false;
    return !!accounts?.channels.includes(channel) && !!identity?.channels.includes(channel)
      && !!transport?.channels.includes(channel);
  }
  const requireReady = (channel: ChannelId): void => {
    // O caminho WhatsApp é independente e nunca usa os adaptadores sociais.
    if ((channel !== "instagram" && channel !== "facebook") || !channelImplementationReady(channel))
      unavailable();
  };

  // Objetos permanentes: referências importadas antes da instalação continuam válidas.
  const channelAccountsPort: ChannelAccountsPort = {
    get channels() { return accounts?.channels ?? []; },
    async discover(...args) { return accounts ? accounts.discover(...args) : unavailable(); },
    async importAccount(env, actor, profileId, input) {
      requireReady(input.channel);
      return accounts ? accounts.importAccount(env, actor, profileId, input) : unavailable();
    },
    async validateConfiguration(env, actor, profileId, input) {
      requireReady(input.channel);
      return accounts ? accounts.validateConfiguration(env, actor, profileId, input) : unavailable();
    },
    async removeLink(...args) { return accounts ? accounts.removeLink(...args) : unavailable(); },
  };
  const channelIdentityPort: ChannelIdentityPort = {
    get channels() { return identity?.channels ?? []; },
    async prepareInbound(env, conversation, evidence) {
      requireReady(evidence.channel);
      if (!identity) return unavailable();
      invalidateCustomerResolution(env);
      try { return await identity.prepareInbound(env, conversation, evidence); }
      finally { invalidateCustomerResolution(env); }
    },
    async readChannels(...args) { return identity ? identity.readChannels(...args) : unavailable(); },
    async previewMerge(...args) { return identity ? identity.previewMerge(...args) : unavailable(); },
    async merge(env, ...args) {
      if (!identity) return unavailable();
      invalidateCustomerResolution(env);
      try { return await identity.merge(env, ...args); }
      finally { invalidateCustomerResolution(env); }
    },
    async undoMerge(env, ...args) {
      if (!identity) return unavailable();
      invalidateCustomerResolution(env);
      try { return await identity.undoMerge(env, ...args); }
      finally { invalidateCustomerResolution(env); }
    },
  };
  const channelTranscriptPort: ChannelTranscriptPort = {
    async options(...args) { return transcript ? transcript.options(...args) : unavailable(); },
    async preview(...args) { return transcript ? transcript.preview(...args) : unavailable(); },
    async send(...args) { return transcript ? transcript.send(...args) : unavailable(); },
  };
  const socialTransportPort: SocialTransportPort = {
    get channels() { return transport?.channels ?? []; },
    async normalizeEvent(input, scope) {
      requireReady(scope.channel);
      return transport ? transport.normalizeEvent(input, scope) : unavailable();
    },
    async prepareSend(env, input) {
      requireReady(input.scope.channel);
      return transport ? transport.prepareSend(env, input) : unavailable();
    },
  };

  return {
    channelAccountsPort, channelIdentityPort, channelTranscriptPort, socialTransportPort,
    channelImplementationReady,
    installChannelAccountsPort(port: ChannelAccountsPort): void {
      accounts = register("contas de canais", accounts, port);
    },
    installChannelIdentityPort(port: ChannelIdentityPort): void {
      identity = register("identidade de canais", identity, port);
    },
    installChannelTranscriptPort(port: ChannelTranscriptPort): void {
      transcript = register("transcrição de conversa", transcript, port);
    },
    installSocialTransportPort(port: SocialTransportPort): void {
      transport = register("transporte social", transport, port);
    },
  };
}

export const {
  channelAccountsPort, channelIdentityPort, channelTranscriptPort, socialTransportPort,
  channelImplementationReady, installChannelAccountsPort, installChannelIdentityPort,
  installChannelTranscriptPort, installSocialTransportPort,
} = createChannelPorts();
