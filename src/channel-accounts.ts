import { all, batch, one } from "./db";
import { access, admin } from "./security";
import { ApiError, type Actor, type Env, json, now, requireValue, uid } from "./types";
import { zernioRequest } from "./zernio";
import type { ChannelAccountsPort } from "./channel-ports";
import type {
  ChannelAccountDiscovery, ChannelAccountImport, ChannelAccountImportResult,
  ChannelAccountView, ChannelConfigurationInput, ChannelConfigurationResult,
  ChannelConnection, ChannelId, DirectSocialChannelId,
} from "./channel-contracts";

const directChannels = ["instagram", "facebook"] as const;
const discoveryChannels = [...directChannels, "tiktok", "googlebusiness"] as const;
type DiscoveredChannel = typeof discoveryChannels[number];
const objectId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const directChannel = (value: unknown): value is DirectSocialChannelId =>
  value === "instagram" || value === "facebook";
const label = (value: unknown) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, 100) : "";
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

function authorize(actor: Actor, profileId: string) {
  access(actor, profileId, "routing:read");
  admin(actor);
}
function notReady(): never {
  throw new ApiError(503, "channel_not_ready", "Este canal ainda não está disponível.");
}
function inboxRequired(): never {
  throw new ApiError(402, "inbox_required", "Ative o Inbox no plano da Zernio e autorize as mensagens desta conta antes de importar.");
}
async function integration(env: Env, profileId: string, integrationId: string) {
  requireValue(typeof integrationId === "string" && integrationId.length > 0, "Informe a integração Zernio.");
  const account = await one(env,
    "SELECT * FROM meta_accounts WHERE id=? AND profile_id=? AND provider='zernio'", integrationId, profileId);
  if (!account) throw new ApiError(404, "not_found", "Integração Zernio não encontrada nesta área de atendimento.");
  requireValue(objectId(account.zernio_profile_id), "Use Encontrar ID na Zernio para identificar esta integração.");
  return account;
}

interface RemoteAccount {
  accountId: string;
  channel: DiscoveredChannel;
  providerProfileId: string;
  accountLabel: string;
  available: boolean;
  inbox: boolean;
}

/** Único leitor de descoberta social. Formato do anexo, a conferir com a conta real:
 * accounts, profileId, platform, isActive, needsReconnect e inboxEnabled.
 * IDs são opacos; username é apresentação, nunca telefone nem credencial.
 * Não conserva tokens, metadata nem o payload do fornecedor.
 */
export function readZernioChannelAccounts(input: unknown, channel: DiscoveredChannel, profileId?: string) {
  const result = record(input);
  if (result.inboxEnabled === false) inboxRequired();
  if (!Array.isArray(result.accounts))
    throw new ApiError(502, "provider_unknown", "A Zernio não retornou uma lista válida de contas.");
  const accounts = new Map<string, RemoteAccount>();
  for (const value of result.accounts) {
    const item = record(value);
    const remoteProfile = typeof item.profileId === "string" ? item.profileId : record(item.profileId)._id;
    if (item.platform !== channel || !objectId(remoteProfile) ||
        (profileId !== undefined && remoteProfile !== profileId) || !objectId(item._id)) continue;
    const account: RemoteAccount = {
      accountId: item._id, channel, providerProfileId: remoteProfile,
      accountLabel: label(item.username) || label(item.displayName) || (channel === "instagram" ? "Conta do Instagram" : channel === "facebook" ? "Página do Facebook" : "Conta social"),
      available: item.isActive !== false && item.needsReconnect !== true,
      inbox: item.inboxEnabled !== false,
    };
    const previous = accounts.get(account.accountId);
    // Duplicatas contraditórias nunca promovem uma conta indisponível.
    if (previous) {
      account.available &&= previous.available;
      account.inbox &&= previous.inbox;
    }
    accounts.set(account.accountId, account);
  }
  const next = record(result.pagination).nextCursor;
  if (next != null && (typeof next !== "string" || !next || next.length > 2048))
    throw new ApiError(502, "provider_unknown", "Paginação Zernio inválida.");
  return { accounts: [...accounts.values()], nextCursor: (next ?? null) as string | null };
}

async function remoteAccounts(env: Env, account: any, channel: DiscoveredChannel): Promise<RemoteAccount[]> {
  const connection = { profile_id: account.profile_id, config: JSON.stringify({ zernio_workspace_id: account.id }) };
  const found = new Map<string, RemoteAccount>(), cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ profileId: account.zernio_profile_id, platform: channel, limit: "100" });
    if (cursor) query.set("cursor", cursor);
    let response: unknown;
    try { response = await zernioRequest(env, connection, `accounts?${query}`); }
    catch (error) {
      // O cliente existente já remove segredos. Código do fornecedor a conferir
      // com a conta real; não interpretar texto livre como permissão de Inbox.
      if (error instanceof ApiError && /^Zernio recusou a operação \(HTTP \d{3}, código INBOX_REQUIRED(?:, campo [^)]+)?\)/i.test(error.message)) inboxRequired();
      throw error;
    }
    const page = readZernioChannelAccounts(response, channel, account.zernio_profile_id);
    for (const item of page.accounts) {
      const previous = found.get(item.accountId);
      if (previous) {
        item.available &&= previous.available;
        item.inbox &&= previous.inbox;
      }
      found.set(item.accountId, item);
    }
    cursor = page.nextCursor;
    if (cursor && (cursors.has(cursor) || cursors.size >= 100))
      throw new ApiError(502, "provider_unknown", "Paginação Zernio inválida.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...found.values()];
}

function accountView(account: any, remote: RemoteAccount, linked?: any): ChannelAccountView {
  const conflict = linked && (linked.profile_id !== account.profile_id || linked.integration_id !== account.id);
  const reason = !directChannel(remote.channel) ? "channel_not_ready" : conflict ? "account_already_imported"
    : !remote.inbox ? "inbox_required" : !remote.available ? "account_disconnected" : null;
  return {
    integrationId: account.id, channel: remote.channel, accountId: remote.accountId,
    providerProfileId: remote.providerProfileId, accountLabel: remote.accountLabel,
    connectionId: conflict ? null : linked?.connection_id ?? null,
    importable: reason === null, reason,
  };
}

export async function discoverChannelAccounts(env: Env, actor: Actor, profileId: string, integrationId: string): Promise<ChannelAccountDiscovery> {
  authorize(actor, profileId);
  const account = await integration(env, profileId, integrationId);
  const linked = await all(env, "SELECT * FROM zernio_channel_accounts");
  const accounts: ChannelAccountView[] = [];
  // Descoberta não altera o cache de telefones de meta_accounts.discovered.
  // Permissões/planos de canais futuros não bloqueiam a primeira leva.
  for (const channel of directChannels)
    for (const remote of await remoteAccounts(env, account, channel))
      accounts.push(accountView(account, remote, linked.find(row => row.channel === channel && row.account_id === remote.accountId)));
  return { accounts, warnings: [
    "Instagram exige conta profissional e Facebook exige Página com mensagens autorizadas. O Inbox deve estar ativo no plano da Zernio.",
    "Formatos e requisitos do fornecedor: a conferir com a conta real. TikTok e Google Business ficam indisponíveis nesta etapa.",
  ] };
}

/** Usar SOMENTE em lotes que alteram conexões (importação, edição/estado e remoção).
 * cn-servidor deve chamar após connection.save/state; nenhuma entrada consulta
 * contagem de canais. Conversas arquivadas continuam identificáveis no resumo.
 */
export function refreshChannelSummaryStatements(profileId: string): [string, any[]][] {
  const summary = `WITH connected AS (
    SELECT DISTINCT channel FROM connections WHERE profile_id=? AND kind IN ('zernio','qr','meta') AND channel IN ('whatsapp','instagram','facebook')
  ), conversation_channels AS (
    SELECT channel FROM connected
    UNION SELECT DISTINCT channel FROM conversations WHERE profile_id=? AND channel IN ('whatsapp','instagram','facebook')
      AND external_namespace NOT LIKE 'app:%' AND chat_type NOT IN ('team','internal')
    UNION SELECT 'whatsapp' FROM conversations c JOIN connections n ON n.id=c.connection_id
      WHERE c.profile_id=? AND c.channel IS NULL AND n.kind IN ('zernio','qr','meta') AND n.channel='whatsapp'
      AND c.external_namespace='channel:'||n.id AND c.chat_type NOT IN ('team','internal')
  ), summary AS (SELECT json_object(
    'connected_channels',json((SELECT json_group_array(channel) FROM (SELECT channel FROM connected ORDER BY channel))),
    'conversation_channels',json((SELECT json_group_array(channel) FROM (SELECT channel FROM conversation_channels ORDER BY channel))),
    'multichannel',json(CASE WHEN EXISTS(SELECT 1 FROM connected WHERE channel!='whatsapp')
      OR EXISTS(SELECT 1 FROM conversation_channels WHERE channel!='whatsapp') THEN 'true' ELSE 'false' END)) AS value)
  `;
  return [
    [summary + `UPDATE connections SET config=json_set(config,'$._channel_summary',json((SELECT value FROM summary)))
      WHERE profile_id=? AND kind IN ('zernio','qr','meta')
      AND (json_extract((SELECT value FROM summary),'$.multichannel')=1 OR json_type(config,'$._channel_summary') IS NOT NULL)
      AND COALESCE(json_extract(config,'$._channel_summary'),'')!=(SELECT value FROM summary)`, [profileId, profileId, profileId, profileId]],
    [summary + `UPDATE conversations SET channel_context=json_set(channel_context,
      '$.version',COALESCE(json_extract(channel_context,'$.version'),1),
      '$.context',COALESCE(json_extract(channel_context,'$.context'),CASE WHEN chat_type='group' THEN 'group' ELSE 'direct' END),
      '$.multichannel',json(CASE WHEN json_extract((SELECT value FROM summary),'$.multichannel')=1 THEN 'true' ELSE 'false' END))
      WHERE profile_id=? AND (channel IN ('whatsapp','instagram','facebook') OR (channel IS NULL AND external_namespace LIKE 'channel:%'))
      AND external_namespace NOT LIKE 'app:%' AND chat_type NOT IN ('team','internal')
      AND (json_extract((SELECT value FROM summary),'$.multichannel')=1 OR json_type(channel_context,'$.multichannel') IS NOT NULL)
      AND (json_type(channel_context,'$.multichannel') IS NULL OR json_extract(channel_context,'$.multichannel')!=json_extract((SELECT value FROM summary),'$.multichannel'))`, [profileId, profileId, profileId, profileId]],
  ];
}

async function linkedAccount(env: Env, channel: string, accountId: string) {
  return one(env, "SELECT * FROM zernio_channel_accounts WHERE channel=? AND account_id=?", channel, accountId);
}
function sameIntegration(link: any, account: any) {
  if (link.profile_id !== account.profile_id || link.integration_id !== account.id ||
      (link.provider_profile_id !== null && link.provider_profile_id !== account.zernio_profile_id))
    throw new ApiError(409, "account_already_imported", "Esta conta já pertence a outra área ou integração.");
}
async function importedResult(env: Env, account: any, link: any, duplicate: boolean): Promise<ChannelAccountImportResult> {
  sameIntegration(link, account);
  const connection = await one(env, "SELECT * FROM connections WHERE id=? AND profile_id=? AND channel=? AND kind='zernio'", link.connection_id, account.profile_id, link.channel);
  if (!connection) throw new ApiError(409, "account_link_invalid", "O vínculo da conta precisa ser conferido.");
  return { connection, duplicate, account: accountView(account, {
    accountId: link.account_id, channel: link.channel, providerProfileId: account.zernio_profile_id,
    accountLabel: link.account_label, available: true, inbox: true,
  }, link) };
}

/** Executado pelo Coordinator da área; recibo/commandId pertencem à composição.
 * A chave natural também torna reimportações e repetição do lote idempotentes.
 */
export async function importChannelAccount(env: Env, actor: Actor, profileId: string, input: ChannelAccountImport): Promise<ChannelAccountImportResult> {
  authorize(actor, profileId);
  requireValue(typeof input.commandId === "string" && input.commandId.trim().length > 0, "Informe a chave idempotente.");
  if (!directChannel(input.channel)) notReady();
  requireValue(objectId(input.accountId), "Informe um ID de conta válido da Zernio.");
  const account = await integration(env, profileId, input.integrationId);
  const existing = await linkedAccount(env, input.channel, input.accountId);
  if (existing) return importedResult(env, account, existing, true);
  const remote = (await remoteAccounts(env, account, input.channel)).find(item => item.accountId === input.accountId);
  requireValue(remote, "Conta não encontrada neste canal e nesta integração Zernio.");
  if (!remote.inbox) inboxRequired();
  requireValue(remote.available, "Reconecte esta conta na Zernio antes de importar.");
  const id = uid(), created = now();
  const config = JSON.stringify({ account_id: remote.accountId, zernio_workspace_id: account.id, zernio_profile_id: remote.providerProfileId });
  try {
    await batch(env, [
      ["INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created,channel,account_label) SELECT ?,?,?,'zernio','direct','paused',?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM zernio_channel_accounts WHERE channel=? AND account_id=?) AND EXISTS(SELECT 1 FROM meta_accounts WHERE id=? AND profile_id=? AND provider='zernio' AND zernio_profile_id=?)",
        [id, profileId, remote.accountLabel, config, created, remote.channel, remote.accountLabel, remote.channel, remote.accountId, account.id, profileId, remote.providerProfileId]],
      ["INSERT INTO zernio_channel_accounts(connection_id,profile_id,integration_id,channel,account_id,provider_profile_id,account_label,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
        [id, profileId, account.id, remote.channel, remote.accountId, remote.providerProfileId, remote.accountLabel, created, created]],
      ...refreshChannelSummaryStatements(profileId),
    ]);
  } catch (error) {
    // Uma disputa de unicidade reverte o lote inteiro, inclusive a conexão.
    const winner = await linkedAccount(env, input.channel, input.accountId);
    if (winner) return importedResult(env, account, winner, true);
    throw error;
  }
  return importedResult(env, account, { connection_id: id, profile_id: profileId, integration_id: account.id,
    channel: remote.channel, account_id: remote.accountId, provider_profile_id: remote.providerProfileId, account_label: remote.accountLabel }, false);
}

export async function validateChannelConfiguration(env: Env, actor: Actor, profileId: string, input: ChannelConfigurationInput): Promise<ChannelConfigurationResult> {
  authorize(actor, profileId);
  const old = input.existingConnectionId
    ? await one(env, "SELECT * FROM connections WHERE id=? AND profile_id=?", input.existingConnectionId, profileId) : null;
  if (input.existingConnectionId && !old) throw new ApiError(404, "not_found", "Conexão não encontrada nesta área.");
  if (old && (old.channel ?? "whatsapp") !== input.channel)
    throw new ApiError(409, "channel_immutable", "O canal de uma conexão existente não pode ser alterado.");
  const previous = json(old?.config);
  if (input.channel === "whatsapp") {
    const config = { ...input.config };
    delete config._channel_summary;
    delete config.multichannel;
    if (previous._channel_summary) config._channel_summary = previous._channel_summary;
    return { channel: input.channel, config };
  }
  if (!directChannel(input.channel)) notReady();
  requireValue(input.kind === "zernio" && (!old || old.kind === "zernio"), "Este canal exige a integração Zernio.");
  if (!old) throw new ApiError(409, "channel_import_required", "Use Buscar contas na Zernio para importar esta conexão.");
  const link = await one(env, "SELECT * FROM zernio_channel_accounts WHERE connection_id=? AND profile_id=? AND channel=?", old.id, profileId, input.channel);
  if (!link) throw new ApiError(409, "channel_import_required", "A conexão social precisa de um vínculo importado da Zernio.");
  const account = await integration(env, profileId, link.integration_id);
  sameIntegration(link, account);
  for (const [key, value] of Object.entries({ account_id: link.account_id, zernio_workspace_id: link.integration_id, zernio_profile_id: account.zernio_profile_id }))
    requireValue(input.config[key] === undefined || input.config[key] === value, "A identidade da conta importada não pode ser alterada.");
  requireValue(!["number", "phone", "phone_id", "number_policy", "api_key", "webhook_secret"].some(key => input.config[key] !== undefined), "Contas sociais não usam telefone, cota nem credenciais próprias.");
  const config: Record<string, unknown> = {
    account_id: link.account_id, zernio_workspace_id: link.integration_id, zernio_profile_id: account.zernio_profile_id,
  };
  // A edição de credenciais não altera a linha nem permite forjar o resumo.
  for (const key of ["service", "bot_options", "_channel_summary"])
    if (previous[key] !== undefined) config[key] = previous[key];
  return { channel: input.channel, config };
}

/** Resolução local após assinatura verificada pelo chamador. Não cria conexão,
 * contato ou conversa. WhatsApp retorna sem nenhuma consulta social. */
export async function resolveZernioChannelConnection(env: Env, scope: {
  profileId: string; integrationId: string; channel: ChannelId; accountId: string; providerProfileId?: string | null;
}): Promise<ChannelConnection | null> {
  if (!directChannel(scope.channel) || !objectId(scope.accountId) ||
      (scope.providerProfileId != null && !objectId(scope.providerProfileId))) return null;
  return one(env, `SELECT c.* FROM zernio_channel_accounts a
    JOIN connections c ON c.id=a.connection_id AND c.profile_id=a.profile_id AND c.channel=a.channel
    JOIN meta_accounts i ON i.id=a.integration_id AND i.profile_id=a.profile_id AND i.provider='zernio'
    WHERE a.profile_id=? AND a.integration_id=? AND a.channel=? AND a.account_id=?
      AND c.kind='zernio' AND c.status='active'
      AND (a.provider_profile_id IS NULL OR a.provider_profile_id=i.zernio_profile_id)
      AND (? IS NULL OR i.zernio_profile_id=?)
      AND json_extract(c.config,'$.account_id')=a.account_id
      AND json_extract(c.config,'$.zernio_workspace_id')=a.integration_id
      AND json_extract(c.config,'$.zernio_profile_id')=i.zernio_profile_id`,
    scope.profileId, scope.integrationId, scope.channel, scope.accountId, scope.providerProfileId ?? null, scope.providerProfileId ?? null);
}

export async function probeZernioChannelAccount(env: Env, connection: ChannelConnection) {
  if (!directChannel(connection.channel)) notReady();
  const link = await one(env, "SELECT * FROM zernio_channel_accounts WHERE connection_id=? AND profile_id=? AND channel=?", connection.id, connection.profile_id, connection.channel);
  requireValue(link, "Importe esta conta pela integração Zernio antes de testar.");
  const account = await integration(env, connection.profile_id, link.integration_id);
  sameIntegration(link, account);
  const config = json(connection.config);
  requireValue(connection.kind === "zernio" && config.account_id === link.account_id && config.zernio_workspace_id === account.id && config.zernio_profile_id === account.zernio_profile_id,
    "A configuração não corresponde à conta importada.");
  const remote = (await remoteAccounts(env, account, connection.channel)).find(item => item.accountId === link.account_id);
  requireValue(remote?.available, "Reconecte a conta e autorize as mensagens na Zernio.");
  if (!remote.inbox) inboxRequired();
  return { account_id: remote.accountId, channel: connection.channel, account_label: remote.accountLabel, zernio_profile_id: remote.providerProfileId };
}

export const channelAccountsHandlers: ChannelAccountsPort = {
  channels: directChannels,
  discover: discoverChannelAccounts,
  importAccount: importChannelAccount,
  validateConfiguration: validateChannelConfiguration,
  async removeLink(env, actor, profileId, input) {
    authorize(actor, profileId);
    requireValue(typeof input.commandId === "string" && input.commandId.trim().length > 0, "Informe a chave idempotente.");
    const connection = await one(env, "SELECT * FROM connections WHERE id=? AND profile_id=?", input.connectionId, profileId);
    if (!connection) return { connectionId: input.connectionId, removed: false, duplicate: true };
    if (!directChannel(connection.channel)) notReady();
    // Remoção completa usa um único lote; nunca deixa conta ativa sem vínculo.
    const { removeConnection } = await import("./connection-removal");
    await removeConnection(env, actor, profileId, input.connectionId);
    return { connectionId: input.connectionId, removed: true, duplicate: false };
  },
};
