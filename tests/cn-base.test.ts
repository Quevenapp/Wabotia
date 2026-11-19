import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANNEL_REGISTRY, FUTURE_CHANNEL_CONTRACTS, SOCIAL_LOCAL_LIMITS, allowsModules, assertChannelSend,
  channelCapabilities, channelRules, channelWindow, conversationChannel, isChannelId,
} from "../src/channels";
import type {
  ChannelConnection, ChannelId, ChannelSpec, SendOrigin, SocialEventScope,
} from "../src/channel-contracts";
import { createChannelPorts, type ChannelAccountsPort } from "../src/channel-ports";
import type { CustomerRef, IdentityPort, InboundEvidence } from "../src/customer/contracts";
import type { ContactProfileView } from "../src/customer/profile-contracts";
import type { Actor, Conversation, Env } from "../src/types";

// Isola a base mesmo quando o Worker de outra suíte já compôs os adaptadores.
vi.hoisted(() => vi.resetModules());

// Estes casos só exercitam decisões puras/ports. Qualquer chamada real é erro.
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Rede inesperada no teste da base de canais.");
  });
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const connection = (
  kind = "zernio", channel?: ChannelId | null, config: object = {},
): ChannelConnection => ({
  id: "connection-a", profile_id: "profile-a", kind, channel,
  config: JSON.stringify(config),
});
const legacyConversation: Conversation = {
  id: "conversation-a", profile_id: "profile-a", connection_id: "connection-a",
  external_namespace: "channel:connection-a", external_id: "5511999999999",
  phone: "5511999999999", chat_type: "direct", title: "Contato",
  bot_policy: "allow", state: "open", owner: null, epoch: 1, session: "session-a",
  topic: null, tags: "[]", last_customer: NOW, created: NOW, updated: NOW,
};
const installedRules = (channel: "instagram" | "facebook" = "instagram"): ChannelSpec => ({
  ...CHANNEL_REGISTRY[channel], enabled: true,
});
const send = (
  age: number, origin: SendOrigin = "manual_text", contentType = "text",
  hasAttachments = false, channel: "instagram" | "facebook" = "instagram",
) => {
  const rules = installedRules(channel);
  return () => assertChannelSend({
    rules, window: channelWindow(rules, NOW - age, NOW),
    origin, contentType, hasAttachments,
  });
};

describe("cn-base: registro e compatibilidade só WhatsApp", () => {
  it("declara exatamente os canais contratados e recusa valores desconhecidos", () => {
    expect(Object.keys(CHANNEL_REGISTRY).sort()).toEqual([
      "email", "facebook", "googlebusiness", "instagram", "telegram", "tiktok", "whatsapp",
    ]);
    for (const id of Object.keys(CHANNEL_REGISTRY)) expect(isChannelId(id)).toBe(true);
    for (const value of [null, undefined, "", "sms", "WhatsApp", "__proto__", 1, {}])
      expect(isChannelId(value)).toBe(false);
    expect(channelRules(connection("zernio", "sms" as ChannelId))).toBeNull();
    expect(channelRules(null)).toBeNull();
    expect(channelRules(connection("desconhecido"))).toBeNull();
    expect(channelCapabilities(connection("zernio", "sms" as ChannelId)))
      .toMatchObject({ channel: null, text: false, image: false, modules: false, templates: false });
  });

  it("separa WhatsApp oficial, QR, aplicação e conexão de IA", () => {
    const official = channelRules(connection())!;
    expect(official).toMatchObject({
      id: "whatsapp", enabled: true, templates: true,
      window: { kind: "customer", hours: 24, after: "template" },
    });
    expect(channelRules(connection("qr"))).toMatchObject({
      id: "whatsapp", enabled: true, window: { kind: "none" },
    });
    expect(channelRules(connection("qr", null, { platform: "whatsapp_cloud" })))
      .toMatchObject({ window: { kind: "customer", hours: 24 } });
    expect(channelRules(connection("meta"))).toMatchObject({ id: "whatsapp" });
    for (const kind of ["ai", "app", "internal"])
      expect(channelRules(connection(kind, "whatsapp"))).toBeNull();
  });

  it("não atribui WhatsApp por exclusão a conversas sem origem reconhecida", () => {
    expect(conversationChannel(legacyConversation, connection())).toBe("whatsapp");
    expect(conversationChannel({ ...legacyConversation, channel: "instagram" }, connection()))
      .toBe("instagram");
    expect(conversationChannel({ ...legacyConversation, channel: "sms" as ChannelId }, connection()))
      .toBeNull();
    expect(conversationChannel(legacyConversation, null)).toBeNull();
    expect(conversationChannel(legacyConversation, connection("ai", "whatsapp"))).toBeNull();
    expect(conversationChannel({ ...legacyConversation, connection_id: null }, connection())).toBeNull();
    for (const external_namespace of ["app:application-a", "team", "unknown", "channel:other"])
      expect(conversationChannel({ ...legacyConversation, external_namespace }, connection())).toBeNull();
  });

  it("preserva todas as capacidades antigas do WhatsApp oficial", () => {
    const direct = channelCapabilities(connection("zernio", null, { groups_enabled: true }));
    expect(direct).toMatchObject({
      text: true, document: true, image: true, video: true, audio: true,
      voice: true, sticker: false, reply: true, reaction: true, location: true,
      contacts: true, edit: false, delete: false, read: true, mentions: false,
      groups: true, group_manage: true, calls: false, video_calls: false,
      upgrade_required: false, channel: "whatsapp", account_label: "",
      multichannel: false, modules: true,
    });
    const group = channelCapabilities(connection("zernio", null, { groups_enabled: true }), "group");
    expect(group).toMatchObject({ reaction: false, location: false, contacts: false, groups: true });
  });

  it("preserva QR moderno e recursos anunciados pelo QR antigo", () => {
    expect(channelCapabilities(connection("qr", null, { protocol_version: 2 }))).toMatchObject({
      text: true, document: true, image: true, video: true, audio: true,
      voice: true, sticker: true, reply: true, reaction: true, location: true,
      contacts: true, edit: true, delete: true, read: true, mentions: true,
      groups: true, group_manage: true, calls: false, video_calls: false,
      upgrade_required: false,
    });
    expect(channelCapabilities(connection("qr", null, { protocol_version: 1, features: ["image", "reply"] })))
      .toMatchObject({ image: true, reply: true, audio: false, sticker: false, mentions: false, upgrade_required: true });
  });

  it("configuração QR malformada não cria capacidade nem quebra a leitura", () => {
    for (const config of ["{", "null", "[]", "42", '{"features":{}}']) {
      const qr = { ...connection("qr"), config };
      expect(channelRules(qr)).toMatchObject({ id: "whatsapp", enabled: true, window: { kind: "none" } });
      expect(channelCapabilities(qr)).toMatchObject({ text: true, image: false, groups: false, upgrade_required: true });
    }
  });

  it("conserva os limites de mídia distintos do oficial e do QR", () => {
    const official = channelRules(connection())!, qr = channelRules(connection("qr"))!;
    expect(official.media.image?.maxSendBytes).toBe(5 * 1024 * 1024);
    expect(official.media.video?.maxSendBytes).toBe(16 * 1024 * 1024);
    expect(official.media.document?.maxSendBytes).toBe(100 * 1024 * 1024);
    expect(qr.media.image?.maxSendBytes).toBe(20 * 1024 * 1024);
    expect(qr.media.video?.maxSendBytes).toBe(100 * 1024 * 1024);
  });

  it("distingue áudio e voz nos recursos anunciados pelo QR antigo", () => {
    for (const feature of ["voice", "audio"] as const) {
      const rules = channelRules(connection("qr", null, { protocol_version: 1, features: [feature] }))!;
      const input = { rules, window: channelWindow(rules, 0, NOW), origin: "human_media" as const, hasAttachments: true };
      expect(() => assertChannelSend({ ...input, contentType: feature })).not.toThrow();
      expect(() => assertChannelSend({ ...input, contentType: feature === "voice" ? "audio" : "voice" }))
        .toThrow(expect.objectContaining({ code: "unsupported_content" }));
      expect(rules.voice?.maxSendBytes).toBe(16 * 1024 * 1024);
      expect(rules.voice?.mimeTypes).toEqual(["audio/ogg"]);
      expect(rules.media.audio?.maxSendBytes).toBe(100 * 1024 * 1024);
    }
  });

  it("mantém módulos exclusivos do WhatsApp, sem inferir pelo contato", () => {
    expect(allowsModules("whatsapp")).toBe(true);
    for (const channel of [null, ...Object.keys(CHANNEL_REGISTRY).filter(id => id !== "whatsapp")])
      expect(allowsModules(channel as ChannelId | null)).toBe(false);
    expect(allowsModules("unknown" as ChannelId)).toBe(false);
  });
});

describe("cn-base: canais futuros e limites locais", () => {
  it("não liga Instagram/Facebook sem implementação completa", () => {
    for (const channel of ["instagram", "facebook"] as const) {
      expect(CHANNEL_REGISTRY[channel].enabled).toBe(false);
      const rules = channelRules(connection("zernio", channel))!;
      expect(rules.enabled).toBe(false);
      expect(() => assertChannelSend({ rules, window: channelWindow(rules, NOW, NOW),
        origin: "manual_text", contentType: "text", hasAttachments: false }))
        .toThrow(expect.objectContaining({ status: 503, code: "channel_not_ready" }));
    }
  });

  it("declara comentários e avaliações desligados, sem automação pública", () => {
    for (const channel of ["instagram", "facebook"] as const) {
      expect(CHANNEL_REGISTRY[channel].contexts.comment).toEqual({ enabled: false, bot: false, publicReply: true });
      expect(channelRules(connection("zernio", channel), "comment")).toMatchObject({ enabled: false,
        window: { kind: "none" }, menu: { buttons: 0, quickReplies: 0, listItems: 0 } });
    }
    expect(CHANNEL_REGISTRY.googlebusiness).toMatchObject({ enabled: false, serviceLine: false,
      contexts: { review: { enabled: false, bot: false, publicReply: true } }, window: { kind: "none" } });
    for (const channel of ["telegram", "email", "tiktok", "googlebusiness"] as const)
      expect(CHANNEL_REGISTRY[channel].enabled).toBe(false);
    expect(CHANNEL_REGISTRY.telegram).toMatchObject({ text: { maxChars: 4096 }, window: { kind: "none" } });
    expect(CHANNEL_REGISTRY.email).toMatchObject({ subject: true, initiation: "business", contexts: { direct: { bot: false } } });
    expect(CHANNEL_REGISTRY.tiktok).toMatchObject({ text: { maxChars: 6000 },
      window: { kind: "customer", hours: 48, maxMessages: 10 }, menu: { buttons: 0, quickReplies: 0, listItems: 0 } });
  });

  it("reserva callback, resposta privada de comentário e operações de avaliação", () => {
    expect(FUTURE_CHANNEL_CONTRACTS).toMatchObject({
      comment: { enabled: false, publicHumanReply: true, privateReplyCount: 1, privateReplyHours: 168 },
      review: { enabled: false, humanReply: true, replace: true, delete: true },
      telegram: { enabled: false, buttons: true, callbackMaxBytes: 64 },
      tiktok: { enabled: false, content: "text_or_image" },
    });
  });

  it("mantém o registro imutável e entrega regras independentes por conexão", () => {
    expect(() => { CHANNEL_REGISTRY.instagram.text.maxChars = 999; }).toThrow(TypeError);
    expect(() => { CHANNEL_REGISTRY.instagram.contexts.comment!.enabled = true; }).toThrow(TypeError);
    expect(() => { FUTURE_CHANNEL_CONTRACTS.comment.enabled = true; }).toThrow(TypeError);
    const first = channelRules(connection())!;
    first.media.image!.maxSendBytes = 1;
    first.contexts.direct!.enabled = false;
    const next = channelRules(connection())!;
    expect(next.media.image?.maxSendBytes).toBe(5 * 1024 * 1024);
    expect(next.contexts.direct?.enabled).toBe(true);
    expect(CHANNEL_REGISTRY.instagram.text.maxChars).toBe(640);
  });

  it("centraliza limites conservadores e não anuncia figurinhas sociais", () => {
    expect(SOCIAL_LOCAL_LIMITS).toMatchObject({ textChars: 640, imageBytes: 3 * 1024 * 1024,
      audioBytes: 8 * 1024 * 1024, videoBytes: 8 * 1024 * 1024, documentBytes: 8 * 1024 * 1024 });
    for (const channel of ["instagram", "facebook"] as const) {
      const rules = CHANNEL_REGISTRY[channel];
      expect(rules.text.maxChars).toBe(SOCIAL_LOCAL_LIMITS.textChars);
      expect(rules.media.image?.maxSendBytes).toBe(SOCIAL_LOCAL_LIMITS.imageBytes);
      expect(rules.media.document?.maxSendBytes).toBe(SOCIAL_LOCAL_LIMITS.documentBytes);
      expect(rules.media.document?.mimeTypes).toContain("application/pdf");
      expect(rules.media.sticker?.send ?? false).toBe(false);
      expect(rules).toMatchObject({ replyTo: false, templates: false, bold: "none",
        initiation: "customer_first", menu: { buttons: 3, quickReplies: 13, listItems: 0, fallback: "numbered_text" } });
    }
  });
});

describe("cn-base: janelas e origem controlada pelo servidor", () => {
  it.each(["instagram", "facebook"] as const)("%s respeita as fronteiras exatas de 24 e 168 horas", channel => {
    const rules = installedRules(channel);
    for (const age of [0, 24 * HOUR - 1])
      expect(channelWindow(rules, NOW - age, NOW)).toMatchObject({
        kind: "customer", state: "open", serverNow: NOW, canHumanText: true, canAutomation: true,
      });
    for (const age of [24 * HOUR, 168 * HOUR - 1])
      expect(channelWindow(rules, NOW - age, NOW)).toMatchObject({ state: "human_text_only",
        canHumanText: true, canAutomation: false, reason: "human_only" });
    expect(channelWindow(rules, NOW - 168 * HOUR, NOW)).toMatchObject({ state: "closed",
      canHumanText: false, canAutomation: false, reason: "window_closed" });
    expect(channelWindow(rules, NOW, NOW)).toMatchObject({
      closesAt: NOW + 24 * HOUR, humanTextClosesAt: NOW + 168 * HOUR, remainingMessages: null,
    });
  });

  it("recusa timestamp inexistente, inválido ou futuro sem renovar no retry", () => {
    const rules = installedRules();
    for (const timestamp of [0, -1, Number.NaN, Infinity, NOW + 1])
      expect(channelWindow(rules, timestamp, NOW)).toMatchObject({ state: "closed", canAutomation: false, canHumanText: false });
    const original = NOW - 24 * HOUR + 1;
    expect(channelWindow(rules, original, NOW).state).toBe("open");
    expect(channelWindow(rules, original, NOW + 1).state).toBe("human_text_only");
    expect(channelWindow(rules, original, NOW + 144 * HOUR + 1).state).toBe("closed");
  });

  it("preserva janela oficial de 24 horas/modelos e QR sem relógio", () => {
    const official = channelRules(connection())!, qr = channelRules(connection("qr"))!;
    expect(channelWindow(official, NOW - 24 * HOUR + 1, NOW).state).toBe("open");
    const closed = channelWindow(official, NOW - 24 * HOUR, NOW);
    expect(closed).toMatchObject({ state: "closed", humanTextClosesAt: null, canHumanText: false });
    expect(() => assertChannelSend({ rules: official, window: closed, origin: "automation",
      contentType: "template", hasAttachments: false })).not.toThrow();
    expect(channelWindow(qr, 0, NOW)).toMatchObject({ kind: "none", state: "open",
      closesAt: null, humanTextClosesAt: null, canHumanText: true, canAutomation: true });
  });

  it("autoriza automação na janela normal e só texto humano livre na extensão", () => {
    for (const origin of ["manual_text", "human_media", "bot", "automation"] as const)
      expect(send(23 * HOUR, origin)).not.toThrow();
    expect(send(25 * HOUR, "manual_text")).not.toThrow();
    for (const origin of ["human_media", "bot", "automation"] as const)
      expect(send(25 * HOUR, origin)).toThrow(expect.objectContaining({ code: "human_only" }));
    for (const contentType of ["image", "video", "audio", "document", "reaction", "buttons", "quick_replies"])
      expect(send(25 * HOUR, "manual_text", contentType)).toThrow(expect.objectContaining({ code: "human_only" }));
    expect(send(25 * HOUR, "manual_text", "text", true)).toThrow(expect.objectContaining({ code: "human_only" }));
    expect(send(168 * HOUR)).toThrow(expect.objectContaining({ code: "window_closed" }));
  });

  it("recusa conteúdo desconhecido ou exclusivo de WhatsApp na DM social", () => {
    for (const type of ["template", "location", "contacts", "sticker", "list", "unknown"])
      expect(send(HOUR, "manual_text", type)).toThrow(expect.objectContaining({ code: "unsupported_content" }));
  });

  it("aceita mídia declarada apenas com anexo e recusa texto+imagem ocultos na mesma entrega", () => {
    for (const type of ["image", "video", "audio", "document"]) {
      expect(send(HOUR, "human_media", type, true)).not.toThrow();
      expect(send(HOUR, "bot", type, true)).not.toThrow();
      expect(send(HOUR, "human_media", type, false)).toThrow(expect.objectContaining({ code: "unsupported_content" }));
    }
    expect(send(HOUR, "human_media", "text", true)).toThrow(expect.objectContaining({ code: "unsupported_content" }));
    expect(send(HOUR, "human_media", "image/heic", true)).toThrow(expect.objectContaining({ code: "unsupported_content" }));
  });

  it("reserva a janela de 48 horas/10 mensagens do TikTok sem ativá-lo", () => {
    const rules = { ...CHANNEL_REGISTRY.tiktok, enabled: true };
    expect(channelWindow(rules, NOW - HOUR, NOW, 9)).toMatchObject({ state: "open", remainingMessages: 1 });
    expect(channelWindow(rules, NOW - HOUR, NOW, 10)).toMatchObject({ state: "closed", remainingMessages: 0 });
    expect(channelWindow(rules, NOW - 48 * HOUR, NOW, 0).state).toBe("closed");
    expect(CHANNEL_REGISTRY.tiktok.enabled).toBe(false);
  });
});

describe("cn-base: DTOs compatíveis", () => {
  it("aceita a evidência antiga de WhatsApp e distingue o sujeito social de telefone", () => {
    const whatsapp: InboundEvidence = { provider: "qr", phone: "5511999999999", phoneJid: "5511999999999@s.whatsapp.net" };
    const social: InboundEvidence = { channel: "instagram", provider: "zernio", accountId: "business-account",
      subjectNamespace: "dm", subjectId: "opaque-subject", displayName: "João", username: "joao" };
    expect(whatsapp.channel).toBeUndefined();
    expect(whatsapp.phone).toBe("5511999999999");
    expect(social).not.toHaveProperty("phone");
    expect(social.subjectId).toBe("opaque-subject");
    // @ts-expect-error O identificador social não pode ser enviado como telefone.
    const socialWithPhone: InboundEvidence = { ...social, phone: "5511999999999" };
    // @ts-expect-error Canal social exige conta e sujeito, não apenas nome público.
    const incompleteSocial: InboundEvidence = { channel: "instagram", provider: "zernio", displayName: "João" };
    void socialWithPhone;
    void incompleteSocial;
  });

  it("mantém Conversation, CustomerRef e ficha legados sem exigir campos novos", () => {
    const ref: CustomerRef = { profileId: "profile-a", namespace: "team", state: "ready",
      contactId: "contact-a", verifiedPhone: "5511999999999", version: 1, erp: null };
    const profile: ContactProfileView = { profileId: "profile-a", contactId: "contact-a", erpContactId: null,
      depth: "simple", vocabulary: { singular: "Contato", plural: "Contatos" }, writable: true, contributions: [] };
    expect(legacyConversation).not.toHaveProperty("channel");
    expect(ref).not.toHaveProperty("verifiedChannel");
    expect(profile).not.toHaveProperty("channels");
    expect(conversationChannel(legacyConversation, connection())).toBe("whatsapp");
  });
});

describe("cn-base: ports sem efeitos parciais", () => {
  const actor: Actor = { id: "person-a", kind: "user", role: "admin", name: "Pessoa",
    profiles: ["profile-a"], scopes: [], bots: [], rate: 100, runLimit: 1 };
  const scope: SocialEventScope = { profileId: "profile-a", integrationId: "integration-a",
    connectionId: "connection-a", channel: "instagram", accountId: "business-a", providerProfileId: null };
  const evidence = { channel: "instagram", provider: "zernio", accountId: "business-a",
    subjectNamespace: "dm", subjectId: "subject-a" } as const;
  const noIo = (): Env => new Proxy({} as Env, {
    get() { throw new Error("Stub tentou acessar infraestrutura."); },
    set() { throw new Error("Stub tentou gravar estado."); },
  });
  const unavailable = { status: 503, code: "channel_not_ready" };

  it("todos os stubs recusam com 503 antes de consultar ou gravar infraestrutura", async () => {
    const p = createChannelPorts(), env = noIo();
    const attempts = [
      () => p.channelAccountsPort.discover(env, actor, "profile-a", "integration-a"),
      () => p.channelAccountsPort.importAccount(env, actor, "profile-a", {
        commandId: "command-a", integrationId: "integration-a", accountId: "business-a", channel: "instagram",
      }),
      () => p.channelAccountsPort.validateConfiguration(env, actor, "profile-a", { channel: "instagram", kind: "zernio", config: {} }),
      () => p.channelAccountsPort.removeLink(env, actor, "profile-a", { commandId: "command-a", connectionId: "connection-a" }),
      () => p.channelIdentityPort.prepareInbound(env, legacyConversation, evidence),
      () => p.channelIdentityPort.readChannels(env, actor, "profile-a", "contact-a"),
      () => p.channelIdentityPort.previewMerge(env, actor, "profile-a", "contact-a", { targetId: "contact-b" }),
      () => p.channelIdentityPort.merge(env, actor, "profile-a", "contact-a", "command-a", {
        targetId: "contact-b", sourceVersion: 1, targetVersion: 1, previewToken: "preview", fieldChoices: {},
      }),
      () => p.channelIdentityPort.undoMerge(env, actor, "profile-a", "contact-a", "command-a", { mergeId: "merge-a" }),
      () => p.channelTranscriptPort.options(env, actor, legacyConversation),
      () => p.channelTranscriptPort.preview(env, actor, legacyConversation, { destination: { kind: "self" }, range: { kind: "session" } }),
      () => p.channelTranscriptPort.send(env, actor, legacyConversation, "command-a", { previewToken: "preview" }),
      () => p.socialTransportPort.normalizeEvent({}, scope),
      () => p.socialTransportPort.prepareSend(env, { scope, conversationId: "conversation-a", threadId: "thread-a",
        commandId: "command-a", origin: "manual_text", lastCustomer: NOW, serverNow: NOW, text: "Olá", attachments: [] }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject(unavailable);
    expect(p.channelImplementationReady("whatsapp")).toBe(true);
    expect(p.channelAccountsPort.channels).toEqual([]);
    expect(p.channelIdentityPort.channels).toEqual([]);
    expect(p.socialTransportPort.channels).toEqual([]);
  });

  it("contas isoladas não importam e cada canal só fica pronto com os três adaptadores", async () => {
    const p = createChannelPorts(), untouched = createChannelPorts(), facade = p.channelAccountsPort;
    const imported = new Error("Implementação simulada alcançada.");
    const importAccount = vi.fn<ChannelAccountsPort["importAccount"]>().mockRejectedValue(imported);
    const accounts = { ...untouched.channelAccountsPort, channels: ["instagram", "facebook"] as const, importAccount };
    const identity = { ...untouched.channelIdentityPort, channels: ["instagram"] as const };
    const transport = { ...untouched.socialTransportPort, channels: ["instagram", "facebook"] as const };
    const input = { commandId: "command-a", integrationId: "integration-a", accountId: "business-a", channel: "instagram" as const };
    p.installChannelAccountsPort(accounts);
    expect(p.channelImplementationReady("instagram")).toBe(false);
    await expect(facade.importAccount(noIo(), actor, "profile-a", input)).rejects.toMatchObject(unavailable);
    expect(importAccount).not.toHaveBeenCalled();
    p.installChannelIdentityPort(identity);
    expect(p.channelImplementationReady("instagram")).toBe(false);
    p.installSocialTransportPort(transport);
    expect(p.channelImplementationReady("instagram")).toBe(true);
    expect(p.channelImplementationReady("facebook")).toBe(false);
    await expect(facade.importAccount(noIo(), actor, "profile-a", input)).rejects.toBe(imported);
    expect(importAccount).toHaveBeenCalledOnce();
    expect(facade).toBe(p.channelAccountsPort);
    expect(facade.channels).toEqual(["instagram", "facebook"]);
  });

  it("mesma implementação pode ser reinstalada; outra falha em cada port", () => {
    const p = createChannelPorts(), fixtures = createChannelPorts();
    const accounts = { ...fixtures.channelAccountsPort };
    const identity = { ...fixtures.channelIdentityPort };
    const transcript = { ...fixtures.channelTranscriptPort };
    const transport = { ...fixtures.socialTransportPort };
    p.installChannelAccountsPort(accounts);
    p.installChannelIdentityPort(identity);
    p.installChannelTranscriptPort(transcript);
    p.installSocialTransportPort(transport);
    expect(() => p.installChannelAccountsPort(accounts)).not.toThrow();
    expect(() => p.installChannelIdentityPort(identity)).not.toThrow();
    expect(() => p.installChannelTranscriptPort(transcript)).not.toThrow();
    expect(() => p.installSocialTransportPort(transport)).not.toThrow();
    expect(() => p.installChannelAccountsPort({ ...accounts })).toThrow("já registrada");
    expect(() => p.installChannelIdentityPort({ ...identity })).toThrow("já registrada");
    expect(() => p.installChannelTranscriptPort({ ...transcript })).toThrow("já registrada");
    expect(() => p.installSocialTransportPort({ ...transport })).toThrow("já registrada");
  });

  it("instalar adaptadores nunca habilita canais da segunda leva", () => {
    const p = createChannelPorts(), fixtures = createChannelPorts();
    const channels = Object.keys(CHANNEL_REGISTRY) as ChannelId[];
    p.installChannelAccountsPort({ ...fixtures.channelAccountsPort, channels });
    p.installChannelIdentityPort({ ...fixtures.channelIdentityPort, channels });
    p.installSocialTransportPort({ ...fixtures.socialTransportPort, channels });
    for (const channel of ["telegram", "tiktok", "email", "googlebusiness"] as const)
      expect(p.channelImplementationReady(channel)).toBe(false);
    expect(p.channelImplementationReady("instagram")).toBe(true);
    expect(p.channelImplementationReady("facebook")).toBe(true);
  });

  it("o adaptador social recusa WhatsApp e futuros mesmo que a implementação os anuncie", async () => {
    const p = createChannelPorts(), fixtures = createChannelPorts();
    const channels = Object.keys(CHANNEL_REGISTRY) as ChannelId[];
    const normalizeEvent = vi.fn(async (): Promise<never> => { throw new Error("Não deveria alcançar adaptador."); });
    p.installChannelAccountsPort({ ...fixtures.channelAccountsPort, channels });
    p.installChannelIdentityPort({ ...fixtures.channelIdentityPort, channels });
    p.installSocialTransportPort({ ...fixtures.socialTransportPort, channels, normalizeEvent });
    for (const channel of ["whatsapp", "tiktok", "telegram"])
      await expect(p.socialTransportPort.normalizeEvent({}, { ...scope, channel: channel as "instagram" }))
        .rejects.toMatchObject(unavailable);
    expect(normalizeEvent).not.toHaveBeenCalled();
  });

  it("a composição explícita liga somente DM social e conserva comentários desligados", async () => {
    vi.resetModules();
    try {
      const ports = await import("../src/channel-ports");
      const channels = await import("../src/channels");
      const fixtures = createChannelPorts(), supported = ["instagram", "facebook"] as const;
      ports.installChannelAccountsPort({ ...fixtures.channelAccountsPort, channels: supported });
      expect(channels.channelRules(connection("zernio", "instagram"))?.enabled).toBe(false);
      ports.installChannelIdentityPort({ ...fixtures.channelIdentityPort, channels: supported });
      ports.installSocialTransportPort({ ...fixtures.socialTransportPort, channels: supported });
      for (const channel of supported) {
        expect(channels.channelRules(connection("zernio", channel))?.enabled).toBe(true);
        expect(channels.channelRules(connection("zernio", channel), "comment")?.enabled).toBe(false);
      }
      expect(channels.channelRules(connection("qr"))?.enabled).toBe(true);
    } finally { vi.resetModules(); }
  });

  it("porta legada conserva plano WhatsApp e recusa evidência social antes do adaptador telefônico", async () => {
    vi.resetModules();
    try {
      const ports = await import("../src/customer/ports");
      await expect(ports.identityPort.prepareInbound(noIo(), legacyConversation, { provider: "qr", phone: null }))
        .resolves.toEqual({ statements: [], state: "pending", verifiedPhone: null });
      await expect(ports.identityPort.prepareInbound(noIo(), legacyConversation, evidence)).rejects.toMatchObject(unavailable);
    } finally { vi.resetModules(); }
  });

  it("invalida resolução após junção/desfazer sem I/O e não compartilha objeto de prova mutável", async () => {
    vi.resetModules();
    try {
      const ports = await import("../src/customer/ports");
      const { withReadCache } = await import("../src/db");
      const env = withReadCache({} as Env);
      const ref: CustomerRef = { profileId: "profile-a", namespace: "team", state: "ready", contactId: "contact-a",
        verifiedPhone: null, version: 1, erp: null, verifiedChannel: { identityId: "identity-a", channel: "instagram",
          accountId: "business-a", subjectNamespace: "dm", subjectId: "subject-a" } };
      const resolve = vi.fn<IdentityPort["resolve"]>().mockResolvedValue(ref);
      const noWork = async (): Promise<never> => { throw new Error("Operação não solicitada."); };
      ports.installIdentityPort({ resolve, prepareInbound: noWork, indexContact: noWork, maintain: noWork });
      const first = await ports.resolveCustomer(env, legacyConversation);
      Object.assign(first.verifiedChannel!, { subjectId: "alterado" });
      expect((await ports.resolveCustomer(env, legacyConversation)).verifiedChannel?.subjectId).toBe("subject-a");
      expect(resolve).toHaveBeenCalledOnce();
      ports.invalidateCustomerResolution(env);
      await ports.resolveCustomer(env, legacyConversation);
      expect(resolve).toHaveBeenCalledTimes(2);
      const { createChannelPorts: isolatedPorts } = await import("../src/channel-ports");
      const social = isolatedPorts(), unavailablePorts = isolatedPorts();
      const undoError = new Error("Manifesto mudou.");
      social.installChannelIdentityPort({
        ...unavailablePorts.channelIdentityPort,
        async merge() {
          ref.contactId = "contact-b";
          return { id: "merge-a", sourceId: "contact-a", targetId: "contact-b",
            sourceVersion: 2, targetVersion: 2, state: "applied", duplicate: false };
        },
        async undoMerge() { throw undoError; },
      });
      await social.channelIdentityPort.merge(env, actor, "profile-a", "contact-a", "merge-command", {
        targetId: "contact-b", sourceVersion: 1, targetVersion: 1, previewToken: "preview", fieldChoices: {},
      });
      expect((await ports.resolveCustomer(env, legacyConversation)).contactId).toBe("contact-b");
      expect(resolve).toHaveBeenCalledTimes(3);
      await expect(social.channelIdentityPort.undoMerge(env, actor, "profile-a", "contact-a", "undo-command", { mergeId: "merge-a" }))
        .rejects.toBe(undoError);
      await ports.resolveCustomer(env, legacyConversation);
      expect(resolve).toHaveBeenCalledTimes(4);
    } finally { vi.resetModules(); }
  });
});
