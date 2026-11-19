import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  channelAccountsHandlers,
  probeZernioChannelAccount,
  resolveZernioChannelConnection,
} from "../src/channel-accounts";
import { CHANNEL_REGISTRY } from "../src/channels";
import { channelImplementationReady } from "../src/channel-ports";
import type { ChannelAccountImport } from "../src/channel-contracts";
import { removeConnection } from "../src/connection-removal";
import { all, exec, one } from "../src/db";
import { probe } from "../src/integrations";
import { secret } from "../src/security";
import { type Actor, defaults, json, now, uid } from "../src/types";
import { zernioAccountCommand } from "../src/zernio-accounts";
import { resolveZernioProfile } from "../src/zernio-profile-resolution";

const admin: Actor = {
  id: "cn-contas-admin", kind: "user", role: "admin", name: "Administrador",
  profiles: [], scopes: [], bots: [], rate: 300, runLimit: 3,
};
const remoteId = () => uid().replaceAll("-", "").slice(0, 24);
let unexpectedRequests: string[] = [];

beforeEach(() => {
  unexpectedRequests = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    unexpectedRequests.push(String(input));
    throw new Error("Rede inesperada no teste de contas sociais.");
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(unexpectedRequests).toEqual([]);
});

async function fixture(profile = uid()) {
  await exec(env, "INSERT OR IGNORE INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    profile, "Contas sociais", JSON.stringify(defaults), now());
  const remote = remoteId();
  const integration = await zernioAccountCommand(env, admin, profile, "zernio-account.save", {
    name: "Zernio da loja", zernio_profile_id: remote,
    secrets: { api_key: "cn-contas-api-key", webhook_secret: "cn-contas-webhook-secret" },
  });
  return { profile, remote, integrationId: integration.id as string };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

// Esquema sintético do anexo, a conferir com a conta real. Não é captura real.
function social(f: Fixture, platform = "instagram", accountId = remoteId()) {
  return {
    _id: accountId, platform, profileId: f.remote, displayName: "Loja São José",
    username: "@loja.saojose", isActive: true,
    accessToken: "nao-persistir-token-social",
    metadata: { appSecret: "nao-persistir-segredo-social" },
  };
}

function provider(f: Fixture, accounts: unknown[], options: { unfiltered?: boolean; error?: boolean } = {}) {
  return vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    try {
      expect(request.method).toBe("GET");
      expect(url.origin).toBe("https://zernio.com");
      expect(url.pathname).toBe("/api/v1/accounts");
      expect(url.searchParams.get("profileId")).toBe(f.remote);
      expect(["whatsapp", "instagram", "facebook", "tiktok", "googlebusiness"])
        .toContain(url.searchParams.get("platform"));
      expect(request.headers.get("Authorization")).toBe("Bearer cn-contas-api-key");
    } catch (error) {
      // zernioRequest pode transformar falha de fetch em ApiError. A falha de
      // contrato também é conferida no afterEach, mesmo em testes de rejeição.
      unexpectedRequests.push(`${request.method} ${url}`);
      throw error;
    }
    if (options.error)
      return Response.json({ code: "INBOX_REQUIRED", error: "Inbox required" }, { status: 403 });
    const selected = options.unfiltered ? accounts : accounts.filter((row: any) => row.platform === url.searchParams.get("platform"));
    return Response.json({ accounts: selected, pagination: { nextCursor: null } });
  });
}

async function imported(f: Fixture, account = social(f)) {
  provider(f, [account]);
  return channelAccountsHandlers.importAccount(env, admin, f.profile, {
    commandId: uid(), integrationId: f.integrationId, accountId: account._id,
    channel: account.platform as "instagram" | "facebook",
  });
}

describe("cn-contas: integração existente e importação social", () => {
  it("só WhatsApp mantém Buscar telefones, número, cota e roteador separados", async () => {
    const f = await fixture(), phoneId = remoteId();
    provider(f, [{
      _id: phoneId, platform: "whatsapp", profileId: f.remote,
      username: "+5511999998888", displayName: "Telefone da loja", isActive: true,
      metadata: { displayPhoneNumber: "+5511999998888", qualityRating: "GREEN" },
    }, social(f)]);
    const discovery = await zernioAccountCommand(env, admin, f.profile, "zernio-account.discover", { id: f.integrationId });
    expect(discovery.data).toEqual([{
      account_id: phoneId, phone_id: phoneId, number: "5511999998888",
      name: "Telefone da loja", quality: "GREEN",
    }]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const saved = await zernioAccountCommand(env, admin, f.profile, "zernio-number.save", {
      account_id: f.integrationId, accountId: phoneId,
    });
    expect(saved).toMatchObject({ status: "paused", usage: { delivered: 0, service_delivered: 0 } });
    const connection = await one(env, "SELECT * FROM connections WHERE id=?", saved.id);
    expect(connection).toMatchObject({ channel: "whatsapp", account_label: "", kind: "zernio" });
    expect(json(connection.config).number).toBe("5511999998888");
    const numbers = await all(env, "SELECT * FROM meta_numbers WHERE account_id=?", f.integrationId);
    const cached = await one(env, "SELECT discovered,discovered_at FROM meta_accounts WHERE id=?", f.integrationId);
    const accounts = await channelAccountsHandlers.discover(env, admin, f.profile, f.integrationId);
    expect(accounts.accounts.every((account) => account.channel !== ("whatsapp" as any))).toBe(true);
    expect(await all(env, "SELECT * FROM meta_numbers WHERE account_id=?", f.integrationId)).toEqual(numbers);
    expect(await one(env, "SELECT discovered,discovered_at FROM meta_accounts WHERE id=?", f.integrationId)).toEqual(cached);
    expect(await all(env, "SELECT * FROM zernio_channel_accounts WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it.each(["instagram", "facebook"])("importa %s sem telefone, sem cota e sem duplicar credenciais", async (channel) => {
    const f = await fixture(), account = social(f, channel);
    provider(f, [account]);
    const found = await channelAccountsHandlers.discover(env, admin, f.profile, f.integrationId);
    expect(found.accounts).toContainEqual(expect.objectContaining({
      integrationId: f.integrationId, channel, accountId: account._id,
      providerProfileId: f.remote, importable: true,
    }));
    const result = await imported(f, account);
    expect(result.duplicate).toBe(false);
    expect(result.connection).toMatchObject({ profile_id: f.profile, kind: "zernio", channel });
    const row = await one(env, "SELECT * FROM connections WHERE id=?", result.connection.id);
    expect(row.status).toBe("paused");
    expect(row.account_label).toBeTruthy();
    expect(json(row.config)).toMatchObject({
      account_id: account._id, zernio_profile_id: f.remote, zernio_workspace_id: f.integrationId,
    });
    for (const key of ["number", "phone", "api_key", "webhook_secret"])
      expect(json(row.config)).not.toHaveProperty(key);
    expect(JSON.stringify(result)).not.toContain("nao-persistir");
    expect(JSON.stringify(row)).not.toContain("nao-persistir");
    expect(await one(env, "SELECT * FROM zernio_channel_accounts WHERE connection_id=?", row.id))
      .toMatchObject({ profile_id: f.profile, integration_id: f.integrationId, channel, account_id: account._id });
    expect(await all(env, "SELECT * FROM meta_numbers WHERE account_id=?", f.integrationId)).toEqual([]);
    expect(await secret(env, `connection:${row.id}`)).toEqual({});
    expect(await secret(env, `zernio-account:${f.integrationId}`)).toEqual({
      api_key: "cn-contas-api-key", webhook_secret: "cn-contas-webhook-secret",
    });
    expect(await probeZernioChannelAccount(env, row)).toMatchObject({ account_id: account._id, channel });
  });

  it("reimportação e repetição do comando devolvem a mesma conexão", async () => {
    const f = await fixture(), account = social(f);
    provider(f, [account]);
    const input = { commandId: uid(), integrationId: f.integrationId, channel: "instagram" as const, accountId: account._id };
    const first = await channelAccountsHandlers.importAccount(env, admin, f.profile, input);
    const again = await channelAccountsHandlers.importAccount(env, admin, f.profile, input);
    const reimport = await channelAccountsHandlers.importAccount(env, admin, f.profile, { ...input, commandId: uid() });
    expect(again.connection.id).toBe(first.connection.id);
    expect(reimport.connection.id).toBe(first.connection.id);
    expect(again.duplicate).toBe(true);
    expect(reimport.duplicate).toBe(true);
    expect(await all(env, "SELECT id FROM connections WHERE profile_id=?", f.profile)).toEqual([{ id: first.connection.id }]);
    expect(await all(env, "SELECT connection_id FROM zernio_channel_accounts WHERE profile_id=?", f.profile))
      .toEqual([{ connection_id: first.connection.id }]);
  });

  it("duas importações simultâneas confirmam um único vínculo e uma única conexão", async () => {
    const f = await fixture(), account = social(f);
    provider(f, [account]);
    const input = { commandId: uid(), integrationId: f.integrationId, channel: "instagram" as const, accountId: account._id };
    const results = await Promise.all([
      channelAccountsHandlers.importAccount(env, admin, f.profile, input),
      channelAccountsHandlers.importAccount(env, admin, f.profile, { ...input }),
    ]);
    expect(results[0].connection.id).toBe(results[1].connection.id);
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
    expect(await all(env, "SELECT id FROM connections WHERE profile_id=?", f.profile))
      .toEqual([{ id: results[0].connection.id }]);
    expect(await all(env, "SELECT connection_id FROM zernio_channel_accounts WHERE profile_id=?", f.profile))
      .toEqual([{ connection_id: results[0].connection.id }]);
  });

  it("a disputa da mesma conta entre áreas permite um único vínculo global", async () => {
    const areas = [await fixture(), await fixture()], accountId = remoteId();
    let requests = 0, release!: () => void;
    const bothRequests = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      try {
        expect(request.method).toBe("GET");
        expect(url.origin).toBe("https://zernio.com");
        expect(url.pathname).toBe("/api/v1/accounts");
        expect(url.searchParams.get("platform")).toBe("instagram");
        expect(request.headers.get("Authorization")).toBe("Bearer cn-contas-api-key");
        const area = areas.find((candidate) => candidate.remote === url.searchParams.get("profileId"));
        expect(area).toBeDefined();
        // Ambas leram ausência de vínculo antes de disputar o lote. Este
        // retorno contraditório é sintético e exercita o isolamento local.
        if (++requests === 2) release();
        await bothRequests;
        return Response.json({ accounts: [social(area!, "instagram", accountId)], pagination: { nextCursor: null } });
      } catch (error) {
        unexpectedRequests.push(`${request.method} ${url}`);
        release();
        throw error;
      }
    });
    const results = await Promise.allSettled(areas.map((area) =>
      channelAccountsHandlers.importAccount(env, admin, area.profile, {
        commandId: uid(), integrationId: area.integrationId, channel: "instagram", accountId,
      })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    for (const result of results)
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "account_already_imported" });
    expect(await all(env, "SELECT id FROM connections WHERE profile_id IN (?,?)", areas[0].profile, areas[1].profile)).toHaveLength(1);
    expect(await all(env, "SELECT connection_id FROM zernio_channel_accounts WHERE channel='instagram' AND account_id=?", accountId)).toHaveLength(1);
    expect(await all(env, "PRAGMA foreign_key_check")).toEqual([]);
  });

  it("a alteração de conexão propaga o resumo antes da primeira DM e o cliente não pode forjá-lo", async () => {
    const f = await fixture(), whatsapp = uid(), conversation = uid(), timestamp = now();
    await exec(env, "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'WhatsApp','qr','direct','active',?,?)",
      whatsapp, f.profile, JSON.stringify({ number: "5511999998888" }), timestamp);
    await exec(env, "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,session,last_customer,created,updated) VALUES(?,?,?,?,'5511888887777','5511888887777',?,?,?,?)",
      conversation, f.profile, whatsapp, `channel:${whatsapp}`, uid(), timestamp, timestamp, timestamp);
    const before = await one(env, "SELECT config FROM connections WHERE id=?", whatsapp);
    expect(json(before.config)).not.toHaveProperty("_channel_summary");
    const socialConnection = (await imported(f)).connection;
    const summary = {
      connected_channels: ["instagram", "whatsapp"],
      conversation_channels: ["instagram", "whatsapp"], multichannel: true,
    };
    for (const id of [whatsapp, socialConnection.id]) {
      const connection = await one(env, "SELECT * FROM connections WHERE id=?", id);
      expect(json(connection.config)._channel_summary).toEqual(summary);
      const validated = await channelAccountsHandlers.validateConfiguration(env, admin, f.profile, {
        existingConnectionId: id, kind: connection.kind, channel: connection.channel,
        config: { ...json(connection.config), _channel_summary: { connected_channels: ["email"], multichannel: false }, multichannel: false },
      });
      expect(validated.config._channel_summary).toEqual(summary);
      expect(validated.config).not.toHaveProperty("multichannel");
    }
    expect(json((await one(env, "SELECT channel_context FROM conversations WHERE id=?", conversation)).channel_context))
      .toMatchObject({ multichannel: true });
    expect(await all(env, "SELECT id FROM conversations WHERE profile_id=? AND channel='instagram'", f.profile)).toEqual([]);
  });

  it("recusa integração de outra área e reautoriza reimportação", async () => {
    const f = await fixture(), account = social(f);
    await imported(f, account);
    const input = { commandId: uid(), integrationId: f.integrationId, channel: "instagram" as const, accountId: account._id };
    await expect(channelAccountsHandlers.importAccount(env, admin, uid(), input)).rejects.toThrow();
    await expect(channelAccountsHandlers.importAccount(env, { ...admin, role: "operator", profiles: [f.profile] }, f.profile, input))
      .rejects.toMatchObject({ code: "admin_required" });
    expect(await all(env, "SELECT connection_id FROM zernio_channel_accounts WHERE integration_id=?", f.integrationId)).toHaveLength(1);
  });

  it("não importa a mesma conta por integração indevida nem troca sua plataforma", async () => {
    const f = await fixture(), account = social(f), result = await imported(f, account);
    const other = await fixture(f.profile);
    provider(other, [account], { unfiltered: true });
    await expect(channelAccountsHandlers.importAccount(env, admin, f.profile, {
      commandId: uid(), integrationId: other.integrationId, channel: "instagram", accountId: account._id,
    })).rejects.toThrow();
    provider(f, [account], { unfiltered: true });
    await expect(channelAccountsHandlers.importAccount(env, admin, f.profile, {
      commandId: uid(), integrationId: f.integrationId, channel: "facebook", accountId: account._id,
    })).rejects.toThrow();
    expect(await all(env, "SELECT id FROM connections WHERE profile_id=?", f.profile)).toEqual([{ id: result.connection.id }]);
  });

  it("filtra plataforma, perfil remoto, ID inválido e conta que exige reconexão", async () => {
    const f = await fixture(), account = social(f);
    provider(f, [account, { ...social(f), profileId: remoteId() },
      { ...social(f), _id: "identidade-inválida" }, { ...social(f), needsReconnect: true },
      { ...social(f), isActive: false }, { ...social(f), platform: "whatsapp" }], { unfiltered: true });
    const discovery = await channelAccountsHandlers.discover(env, admin, f.profile, f.integrationId);
    expect(discovery.accounts.filter((row) => row.importable).map((row) => row.accountId)).toEqual([account._id]);
    expect(JSON.stringify(discovery)).not.toContain("nao-persistir");
  });

  it("mantém Google sem linha e recusa importação sem conta correspondente ou por canal próprio", async () => {
    const f = await fixture();
    provider(f, [social(f, "googlebusiness"), social(f, "tiktok")]);
    const discovery = await channelAccountsHandlers.discover(env, admin, f.profile, f.integrationId);
    expect(discovery.accounts).toEqual([]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(globalThis.fetch).mock.calls.map(([input]) =>
      new URL(input instanceof Request ? input.url : String(input)).searchParams.get("platform")).sort())
      .toEqual(["facebook", "instagram"]);
    expect(CHANNEL_REGISTRY.googlebusiness.serviceLine).toBe(false);
    for (const channel of ["googlebusiness", "tiktok"] as const) {
      await expect(channelAccountsHandlers.importAccount(env, admin, f.profile, {
        commandId: uid(), integrationId: f.integrationId, channel, accountId: remoteId(),
      })).rejects.toMatchObject({ status: 400, code: "invalid_request", message: "Conta não encontrada neste canal e nesta integração Zernio." });
    }
    // Telegram e e-mail estão instalados, mas usam conexão própria: não são
    // contas importáveis da Zernio e conservam a recusa channel_not_ready.
    for (const channel of ["telegram", "email"] as const) {
      expect(channelImplementationReady(channel, "direct")).toBe(true);
      // Viola o DTO de propósito para provar a recusa também em runtime.
      await expect(channelAccountsHandlers.importAccount(env, admin, f.profile, {
        commandId: uid(), integrationId: f.integrationId, channel, accountId: remoteId(),
      } as unknown as ChannelAccountImport)).rejects.toMatchObject({ status: 503, code: "channel_not_ready" });
    }
    expect(await all(env, "SELECT connection_id FROM zernio_channel_accounts WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT connection_id FROM meta_numbers WHERE account_id=?", f.integrationId)).toEqual([]);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM connections WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("explica Inbox exigido pelo plano e não deixa conexão parcial", async () => {
    const f = await fixture(), account = social(f);
    provider(f, [], { error: true });
    await expect(channelAccountsHandlers.discover(env, admin, f.profile, f.integrationId))
      .rejects.toMatchObject({ code: "inbox_required" });
    await expect(channelAccountsHandlers.importAccount(env, admin, f.profile, {
      commandId: uid(), integrationId: f.integrationId, channel: "instagram", accountId: account._id,
    })).rejects.toMatchObject({ code: "inbox_required" });
    expect(await all(env, "SELECT id FROM connections WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT * FROM zernio_channel_accounts WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("rejeita ID de conta inválido antes de consultar a Zernio", async () => {
    const f = await fixture();
    await expect(channelAccountsHandlers.importAccount(env, admin, f.profile, {
      commandId: uid(), integrationId: f.integrationId, channel: "instagram", accountId: "5511999998888",
    })).rejects.toThrow();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(await all(env, "SELECT id FROM connections WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("valida vínculo importado, imutabilidade de canal e identidade da conta", async () => {
    const f = await fixture(), account = social(f), result = await imported(f, account);
    const config = json(result.connection.config);
    await expect(channelAccountsHandlers.validateConfiguration(env, admin, f.profile, {
      kind: "zernio", channel: "instagram", config,
    })).rejects.toThrow();
    await expect(channelAccountsHandlers.validateConfiguration(env, admin, f.profile, {
      existingConnectionId: result.connection.id, kind: "zernio", channel: "facebook", config,
    })).rejects.toThrow();
    await expect(channelAccountsHandlers.validateConfiguration(env, admin, f.profile, {
      existingConnectionId: result.connection.id, kind: "zernio", channel: "whatsapp", config,
    })).rejects.toThrow();
    await expect(channelAccountsHandlers.validateConfiguration(env, admin, f.profile, {
      existingConnectionId: result.connection.id, kind: "zernio", channel: "instagram",
      config: { ...config, account_id: remoteId() },
    })).rejects.toThrow();
    const validated = await channelAccountsHandlers.validateConfiguration(env, admin, f.profile, {
      existingConnectionId: result.connection.id, kind: "zernio", channel: "instagram", config,
    });
    expect(validated.channel).toBe("instagram");
    expect(validated.config).not.toHaveProperty("number");
  });

  it("o probe existente confirma a conta social sem número e não aceita identidade trocada", async () => {
    const f = await fixture(), account = social(f), result = await imported(f, account);
    expect(json(result.connection.config)).not.toHaveProperty("verified_at");
    expect(await probe(env, result.connection.id, f.profile, "https://wabotia.example"))
      .toMatchObject({ ok: true, provider: "zernio", channel: "instagram", account_id: account._id });
    const verified = await one(env, "SELECT * FROM connections WHERE id=?", result.connection.id);
    expect(json(verified.config).verified_at).toBeGreaterThan(0);
    expect(json(verified.config)).not.toHaveProperty("number");
    vi.mocked(globalThis.fetch).mockClear();
    await expect(probeZernioChannelAccount(env, {
      ...verified, config: JSON.stringify({ ...json(verified.config), account_id: remoteId() }),
    })).rejects.toThrow();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("preserva segredos compartilhados enquanto houver entrega social pendente", async () => {
    const f = await fixture(), result = await imported(f), delivery = uid(), timestamp = now();
    await exec(env, "INSERT INTO outbox(id,profile_id,connection_id,kind,actor,payload,status,dedupe,created,updated) VALUES(?,?,?,'text','system','{}','pending',?,?,?)",
      delivery, f.profile, result.connection.id, uid(), timestamp, timestamp);
    const before = await secret(env, `zernio-account:${f.integrationId}`);
    vi.mocked(globalThis.fetch).mockClear();
    await expect(zernioAccountCommand(env, admin, f.profile, "zernio-account.save", {
      id: f.integrationId, name: "Chave nova", secrets: { api_key: "replacement-social-key" },
    })).rejects.toThrow(/Reconcilie as entregas/);
    expect(await secret(env, `zernio-account:${f.integrationId}`)).toEqual(before);
    expect(await one(env, "SELECT status FROM outbox WHERE id=?", delivery)).toEqual({ status: "pending" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("a resolução de perfil usa a plataforma social sem ler ou comparar telefone", async () => {
    const f = await fixture(), actualProfile = remoteId();
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      try {
        expect(request.method).toBe("GET");
        expect(url.origin).toBe("https://zernio.com");
        expect(request.headers.get("Authorization")).toBe("Bearer cn-contas-api-key");
        if (url.pathname === "/api/v1/profiles")
          return Response.json({ profiles: [{ _id: actualProfile, name: "Perfil social" }] });
        expect(url.pathname).toBe("/api/v1/accounts");
        expect(url.searchParams.get("platform")).toBe("instagram");
        return Response.json({ accounts: [{ _id: f.remote, platform: "instagram", profileId: actualProfile }], pagination: { nextCursor: null } });
      } catch (error) {
        unexpectedRequests.push(`${request.method} ${url}`);
        throw error;
      }
    });
    const result = await resolveZernioProfile(env, admin, f.profile, { id: f.integrationId, channel: "instagram" });
    expect(result).toMatchObject({ suggested_id: actualProfile, matched_by: "account", current_id: f.remote });
    expect(await one(env, "SELECT zernio_profile_id FROM meta_accounts WHERE id=?", f.integrationId))
      .toEqual({ zernio_profile_id: f.remote });
  });

  it("a correção de perfil não separa uma conta social da integração importada", async () => {
    const f = await fixture(), result = await imported(f), replacement = remoteId();
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      try {
        expect(request.method).toBe("GET");
        expect(url.origin).toBe("https://zernio.com");
        expect(url.pathname).toBe("/api/v1/profiles");
        return Response.json({ profiles: [{ _id: f.remote, name: "Atual" }, { _id: replacement, name: "Outra" }] });
      } catch (error) {
        unexpectedRequests.push(`${request.method} ${url}`);
        throw error;
      }
    });
    await expect(resolveZernioProfile(env, admin, f.profile, {
      id: f.integrationId, channel: "instagram", zernio_profile_id: replacement,
    })).rejects.toMatchObject({ code: "integration_in_use" });
    expect(await one(env, "SELECT zernio_profile_id FROM meta_accounts WHERE id=?", f.integrationId))
      .toEqual({ zernio_profile_id: f.remote });
    expect(await one(env, "SELECT provider_profile_id FROM zernio_channel_accounts WHERE connection_id=?", result.connection.id))
      .toEqual({ provider_profile_id: f.remote });
  });
});

describe("cn-contas: resolução e exclusão local", () => {
  it("o port remove a conexão local e repete sem remover credenciais compartilhadas", async () => {
    const f = await fixture(), result = await imported(f);
    const input = { commandId: uid(), connectionId: result.connection.id };
    expect(await channelAccountsHandlers.removeLink(env, admin, f.profile, input))
      .toMatchObject({ connectionId: result.connection.id, removed: true, duplicate: false });
    expect(await channelAccountsHandlers.removeLink(env, admin, f.profile, input))
      .toMatchObject({ connectionId: result.connection.id, duplicate: true });
    expect(await one(env, "SELECT id FROM connections WHERE id=?", result.connection.id)).toBeNull();
    expect(await secret(env, `zernio-account:${f.integrationId}`)).toHaveProperty("api_key", "cn-contas-api-key");
  });

  it("repetir a fixture de webhook resolve a mesma conexão sem criar outra", async () => {
    const f = await fixture(), account = social(f), importedAccount = await imported(f, account);
    // Apenas a fronteira de contas: o processamento/deduplicação da mensagem é de cn-transporte/cn-servidor.
    const webhook = {
      type: "message.received", platform: "instagram", accountId: account._id,
      profileId: f.remote, message: { id: "provider-event-1", senderId: "opaque-subject" },
    };
    const scope = {
      profileId: f.profile, integrationId: f.integrationId, channel: webhook.platform as "instagram",
      accountId: webhook.accountId, providerProfileId: webhook.profileId,
    };
    expect(await resolveZernioChannelConnection(env, scope)).toBeNull();
    await exec(env, "UPDATE connections SET status='active' WHERE id=?", importedAccount.connection.id);
    vi.mocked(globalThis.fetch).mockClear();
    const resolved = await Promise.all([
      resolveZernioChannelConnection(env, scope), resolveZernioChannelConnection(env, { ...scope }),
    ]);
    expect(resolved.map((row) => row?.id)).toEqual([importedAccount.connection.id, importedAccount.connection.id]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(await all(env, "SELECT id FROM connections WHERE profile_id=?", f.profile)).toEqual([{ id: importedAccount.connection.id }]);
    for (const invalid of [
      { profileId: uid() }, { integrationId: uid() }, { channel: "facebook" as const },
      { providerProfileId: remoteId() }, { accountId: remoteId() }, { channel: "tiktok" as const },
    ]) expect(await resolveZernioChannelConnection(env, { ...scope, ...invalid })).toBeNull();
  });

  it("remove vínculo social, preserva histórico, identidade e segredo compartilhado", async () => {
    const f = await fixture(), account = social(f), importedAccount = await imported(f, account);
    const id = importedAccount.connection.id, conversation = uid(), contact = uid(), identity = uid(), message = uid();
    const timestamp = now();
    await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','Cliente','Cliente','manual',?,?,?,?)",
      contact, f.profile, admin.id, admin.id, timestamp, timestamp);
    await exec(env, "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,session,last_customer,created,updated,channel,account_label,channel_account_id,channel_subject_id) VALUES(?,?,?,?,'opaque-subject',?,?,?,?,?,?,?,?)",
      conversation, f.profile, id, `channel:${id}`, uid(), timestamp, timestamp, timestamp,
      "instagram", importedAccount.connection.account_label, account._id, "opaque-subject");
    await exec(env, "INSERT INTO customer_channel_ids(id,profile_id,namespace,channel,account_id,subject_namespace,subject_id,contact_id,connection_id,proof_conversation_id,state,created,updated) VALUES(?,?,'team','instagram',?,'dm','opaque-subject',?,?,?,'ready',?,?)",
      identity, f.profile, account._id, contact, id, conversation, timestamp, timestamp);
    await exec(env, "UPDATE conversations SET channel_identity_id=? WHERE id=?", identity, conversation);
    await exec(env, "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,created) VALUES(?,?,?,'customer','customer','Histórico social preservado',?)",
      message, f.profile, conversation, timestamp);
    vi.mocked(globalThis.fetch).mockClear();
    expect(await removeConnection(env, admin, f.profile, id))
      .toMatchObject({ id, deleted: true, conversations_preserved: 1 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(await one(env, "SELECT * FROM connections WHERE id=?", id)).toBeNull();
    expect(await one(env, "SELECT * FROM zernio_channel_accounts WHERE connection_id=?", id)).toBeNull();
    expect(await one(env, "SELECT * FROM conversations WHERE id=?", conversation)).toMatchObject({
      connection_id: null, state: "closed", channel: "instagram", channel_account_id: account._id,
      channel_subject_id: "opaque-subject", channel_identity_id: identity,
      account_label: importedAccount.connection.account_label,
    });
    expect(await one(env, "SELECT * FROM customer_channel_ids WHERE id=?", identity)).toMatchObject({
      connection_id: null, state: "ready", contact_id: contact,
      proof_conversation_id: conversation, account_id: account._id,
    });
    expect(await one(env, "SELECT text FROM messages WHERE id=?", message)).toEqual({ text: "Histórico social preservado" });
    expect(await secret(env, `zernio-account:${f.integrationId}`)).toEqual({
      api_key: "cn-contas-api-key", webhook_secret: "cn-contas-webhook-secret",
    });
    expect(await one(env, "SELECT id FROM meta_accounts WHERE id=?", f.integrationId)).toEqual({ id: f.integrationId });
    expect(await all(env, "PRAGMA foreign_key_check")).toEqual([]);
  });
});
