import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all } from "../src/db";
import type { ChannelDraft, ChannelUiData, ConversationSlotProps, MessageSlotProps } from "../web/channel-extension-contracts";
import { ChannelComposerFields, ChannelConnectionFields, ChannelContactActions, ChannelConversationHeader,
  ChannelConversationInfo, ChannelMessageMetadata, ChannelReviewsPage, channelCatalogVisible, channelConnectionChoices,
  channelReviewsAvailable, getChannelUi, prepareChannelUiAction } from "../web/channel-extensions";
import { C2_UI_EXTENSIONS, installC2Web, prepareTelegramAction } from "../web/c2/register";
import { CommentsPanel, commentTargets, prepareCommentAction, privateReplyAvailability } from "../web/c2/CommentsPanel";
import { GoogleReviewsPage, prepareReviewReply, reviewAccess, uniqueReviews } from "../web/c2/GoogleReviewsPage";
import { EmailConversationFields, EmailComposerFields, emailReplySubject, prepareEmailAction, validateEmailSubject } from "../web/c2/EmailConversationFields";
import { EmailConnectionFields, emailTestLabel, normalizeChannelEmail, prepareEmailConnection } from "../web/c2/EmailConnectionFields";
import { TelegramConnectionFields, TelegramConversationInfo, prepareTelegramConnection } from "../web/c2/TelegramConnectionFields";
import { ContactChannelActions, prepareNewEmail, readyEmailConnections } from "../web/c2/ContactChannelActions";
import { ChannelMessageMeta, emailMessageSubject, messageWarnings } from "../web/c2/ChannelMessageMeta";
import { TikTokQuota, TikTokComposerFields, prepareTikTokAction, tiktokQuotaState } from "../web/c2/TikTokQuota";
import { assertNoChannelEffects, c2Fixture, c2ZernioWebhook, denyNetwork, installSyntheticReview, quietCoordinator, reviewFixtureEvent } from "./c2-fixtures";

const now = 1_795_100_000_000;
const api = vi.fn(async () => { throw new Error("Render não deve fazer requisição."); });
const refresh = async () => undefined;
const root = "v1/profiles/area";
const props = (conversation: ChannelUiData, detail: ChannelUiData = {}): ConversationSlotProps => ({ conversation, detail, api, root, now, refresh });
const draft = (conversation: ChannelUiData, fields: ChannelUiData = {}): ChannelDraft => ({ conversation, text: "Olá, atenção ao pedido!", attachments: [], attachmentDetails: [], content: { type: "text" }, fields });
const render = (node: React.ReactNode) => renderToStaticMarkup(node);
const comment = { id: "comment-one", postId: "post-one", text: "Dúvida sobre entrega", postText: "Nossa publicação", hidden: false,
  version: 1, privateState: "available", privateExpiresAt: now + 168 * 3_600_000 };
const commentConversation = { id: "comments", channel: "instagram", chat_type: "comment", channel_extension: { metadata: { comment } } };
const email = { id: "email", channel: "email", channel_extension: { metadata: { email: { subject: "Pedido 123", sender: "pessoa@example.test", identityTrust: "unverified_sender" } } } };
const tiktok = (remainingMessages: number) => ({ id: "tiktok", channel: "tiktok", window: { kind: "customer", serverNow: now, state: "open", canHumanText: true },
  channel_extension: { metadata: { tiktok: { remainingMessages, closesAt: now + 48 * 3_600_000, conservativeQuota: true } } } });
const profiles = new Set<string>();
let network: ReturnType<typeof denyNetwork>;
beforeEach(() => { network = denyNetwork(); api.mockClear(); });
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear(); network.restore(); network.assertNone();
});

describe("c2-web: registro e ausência preservam apresentação", () => {
  it("importa sem instalar e instala todos os slots explicitamente, sem requisições", () => {
    expect(getChannelUi("telegram/direct")).toBeUndefined();
    installC2Web(); installC2Web();
    for (const descriptor of C2_UI_EXTENSIONS) expect(getChannelUi(descriptor.key)).toBe(descriptor);
    expect(api).not.toHaveBeenCalled();
  });

  it("WhatsApp, DM Instagram/Facebook, interno e aplicação têm DOM exatamente igual", () => {
    installC2Web();
    for (const conversation of [{ channel: "whatsapp" }, { channel: "instagram", chat_type: "direct" },
      { channel: "facebook", chat_type: "direct" }, { kind: "internal" }, { external_namespace: "app:one" }]) {
      const common = props(conversation);
      const slots = [React.createElement(ChannelConversationHeader, common), React.createElement(ChannelConversationInfo, common),
        React.createElement(ChannelComposerFields, { ...common, draft: draft(conversation), disabled: false, change() {} }),
        React.createElement(ChannelMessageMetadata, { ...common, content: {}, message: {}, previousMessage: null }),
        React.createElement(ChannelContactActions, { ...common, contactId: "person", contact: {}, channels: [] }),
        React.createElement(ChannelConnectionFields, { form: conversation, change: () => () => {}, api, root, refresh, disabled: false })];
      const before = render(React.createElement("main", null, "Atendimento"));
      expect(render(React.createElement("main", null, "Atendimento", ...slots))).toBe(before);
      expect(prepareChannelUiAction(draft(conversation))).toBeNull();
    }
    expect(api).not.toHaveBeenCalled();
    expect(channelCatalogVisible({}, "")).toBe(false);
    expect(channelCatalogVisible({ connected_channels: ["whatsapp", "instagram", "facebook"] }, "")).toBe(false);
    expect(channelConnectionChoices({})).toEqual([]);
    expect(channelCatalogVisible({}, "?canais=2")).toBe(true);
    expect(channelConnectionChoices({ c2_active: true }).map(row => row.kind)).toEqual(["telegram_bot", "email"]);
    expect(render(React.createElement(ChannelReviewsPage, { api, root, now, mode: "reviews", status: {} }))).toBe("");
    expect(channelReviewsAvailable({ connected_channels: ["whatsapp"] })).toBe(false);
  });
});

describe("c2-web: formulários, ações explícitas e retry", () => {
  it("o assunto editável mantém acentos, pedido e URL e proíbe injeção de cabeçalhos", () => {
    expect(emailReplySubject("Re: re: Pedido 123 — https://example.test/pedido")).toBe("Re: Pedido 123 — https://example.test/pedido");
    for (const value of ["Assunto\rBcc: x", "Assunto\nBcc: x", "Assunto\0", "x".repeat(201)]) expect(() => validateEmailSubject(value)).toThrow();
    expect(prepareEmailAction(draft(email))).toMatchObject({ type: "email.send", subject: "Re: Pedido 123" });
    const html = render(React.createElement(EmailComposerFields, { ...props(email), draft: draft(email), disabled: true, change() {} }));
    expect(html).toContain("Assunto do e-mail"); expect(html).toContain("disabled"); expect(html).toContain("Re: Pedido 123");
  });

  it("a cópia congelada conserva assunto, alvo, modo e anexos após mudança do rascunho", () => {
    installC2Web();
    const files = [{ mediaId: "file", kind: "document" as const, mimeType: "application/pdf", bytes: 123 }];
    const emailDraft = { ...draft(email, { subject: "Assunto revisado" }), attachments: ["file"], attachmentDetails: files };
    const request = { key: "pedido-idempotente", body: prepareChannelUiAction(emailDraft) };
    files[0].mediaId = "outro"; emailDraft.fields = { subject: "Outro assunto" }; emailDraft.text = "Mudou";
    expect(request).toMatchObject({ key: "pedido-idempotente", body: { type: "email.send", subject: "Assunto revisado", text: "Olá, atenção ao pedido!", attachments: [{ mediaId: "file" }] } });
    const commentDraft = draft(commentConversation, { commentId: comment.id, mode: "public" });
    const prepared = prepareChannelUiAction(commentDraft);
    commentDraft.fields = { commentId: "outro", mode: "private" };
    expect(prepared).toEqual({ type: "comment.reply", commentId: comment.id, text: commentDraft.text });
    expect(() => prepareCommentAction(draft(commentConversation))).toThrow(/Escolha/);
  });

  it("comentário tem alvo público/privado explícito e tentativa consumida visível", () => {
    const rows = commentTargets(commentConversation, { comments: [comment, { ...comment, version: 2, hidden: true, privateState: "unknown" }] });
    expect(rows).toHaveLength(1); expect(rows[0].hidden).toBe(true);
    expect(privateReplyAvailability(rows[0], now)).toMatchObject({ allowed: false });
    expect(privateReplyAvailability({ ...rows[0], privateState: "available", privateExpiresAt: now - 1 }, now).reason).toContain("168 horas");
    const html = render(React.createElement(CommentsPanel, props(commentConversation, { comments: rows })));
    expect(html).toContain("Comentário oculto"); expect(html).toContain("tentativa consumida"); expect(html).not.toContain("24 horas");
    expect(html.split("Dúvida sobre entrega")).toHaveLength(2);
    expect(render(React.createElement(CommentsPanel, props({ channel: "instagram", chat_type: "direct" })))).toBe("");
  });

  it("segredo salvo não vira valor de campo nem configuração pública", () => {
    const form = { id: "bot", kind: "telegram_bot", channel: "telegram", configured: true, bot_token: "NAO-EXIBIR", webhook_secret: "SEGREDO", config: { bot_token: "NAO-EXIBIR" } };
    const html = render(React.createElement(TelegramConnectionFields, { form, api, root, refresh, disabled: false, change: () => () => {} }));
    expect(html).toContain("configurado"); expect(html).toContain("BotFather"); expect(html).not.toContain("NAO-EXIBIR"); expect(html).not.toContain("SEGREDO");
    expect(prepareTelegramConnection(form).secrets).toEqual({});
    expect(prepareTelegramConnection({ ...form, c2_new_bot_token: "000:digitado" }).secrets).toEqual({ bot_token: "000:digitado" });
    expect(prepareTelegramConnection({ ...form, c2_new_bot_token: "000:digitado" }).config).not.toHaveProperty("bot_token");
  });

  it("e-mail tem ativação separada do bot, teste inconclusivo e guia manual", () => {
    const form = { channel: "email", address: "Pessoa.Nome+tag@EXAMPLE.TEST" };
    expect(prepareEmailConnection(form)).toEqual({ config: { address: "pessoa.nome+tag@example.test", c2_enabled: true, bot_enabled: false, auto_ack_enabled: false }, secrets: {} });
    expect(normalizeChannelEmail("Pessoa.Nome+tag@EXAMPLE.TEST")).toBe("pessoa.nome+tag@example.test");
    for (const value of ["a@b.test,b@c.test", "a@b.test\nBcc:x", "Nome <a@b.test>"]) expect(() => normalizeChannelEmail(value)).toThrow();
    expect(emailTestLabel("expired")).toContain("inconclusivo");
    const html = render(React.createElement(EmailConnectionFields, { form, api, root, refresh, disabled: false, change: () => () => {} }));
    expect(html).toContain("preserve seus MX"); expect(html).toContain("Worker"); expect(html).toContain("configuração de envio em Sistema");
  });

  it("Novo e-mail exige confirmação e prontidão; telefone compartilhado só sugere junção humana", () => {
    expect(() => prepareNewEmail("person", "connection", "pessoa@example.test", false)).toThrow();
    expect(prepareNewEmail("person", "connection", "Pessoa+tag@EXAMPLE.TEST", true)).toMatchObject({ address: "pessoa+tag@example.test", confirmed: true });
    expect(readyEmailConnections({ connections: [{ id: "email", channel: "email", status: "active" }] })).toEqual([]);
    const contactProps = { contactId: "person", contact: {}, channels: [], api, root, refresh };
    expect(render(React.createElement(ContactChannelActions, contactProps))).toBe("");
    const pending = render(React.createElement(ContactChannelActions, { ...contactProps, extensionKeys: ["email/direct"] }));
    expect(pending).toContain("Novo e-mail"); expect(pending).toContain("disabled");
    const telegram = { channel: "telegram", channel_extension: { metadata: { telegram: { blocked: false, phoneSuggestion: { masked: "+55 •••• 1234", confirmedByHuman: false } } } } };
    const html = render(React.createElement(TelegramConversationInfo, props(telegram)));
    expect(html).toContain("Telefone próprio sugerido"); expect(html).toContain("Não comprova telefone");
    expect(() => prepareTelegramAction(draft({ ...telegram, channel_extension: { metadata: { telegram: { blocked: true } } } }))).toThrow(/bloqueou/);
  });
});

describe("c2-web: conteúdo hostil, avaliações e limites", () => {
  it("HTML e cabeçalhos hostis são texto, sem imagens ou execução e sem avisos repetidos", () => {
    const hostile = '<img src="https://remote.test/tracker" onerror="alert(1)"><script>ataque()</script>';
    const content = { html: hostile, email: { subject: hostile, sender: "pessoa@example.test", from: hostile, replyTo: "outro@example.test",
      authentication: [{ method: "DMARC", result: "pass" }, { method: "DMARC", result: "pass" }], attachmentWarnings: ["attachment_too_large", "attachment_too_large"] } };
    const messageProps: MessageSlotProps = { ...props(email), content, message: { id: "msg" }, previousMessage: null };
    const html = render(React.createElement(ChannelMessageMeta, messageProps));
    expect(html).toContain("&lt;img"); expect(html).not.toContain("<img"); expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe"); expect(html).not.toContain('src="https://remote');
    expect(html).toContain("não confiada"); expect(html.split("DMARC: pass")).toHaveLength(2);
    expect(messageWarnings(content)).toHaveLength(1);
    expect(render(React.createElement(ChannelMessageMeta, { ...messageProps, previousMessage: { id: "msg", content } }))).toBe("");
    expect(emailMessageSubject({ ...messageProps, previousMessage: { id: "older", content } })).toBeNull();
    expect(emailMessageSubject({ ...messageProps, previousMessage: { id: "older", content: { email: { subject: "Anterior" } } } })).toContain("<img");
    expect(render(React.createElement(EmailConversationFields, props(email)))).toContain("Remetente não confirmado");
    const attachments = render(React.createElement(ChannelMessageMeta, { ...messageProps, content: {
      safeAttachments: [{ name: "cardápio.pdf", state: "accepted" }, { name: "arquivo.exe", state: "rejected" }],
    } }));
    expect(attachments).toContain("Anexo aceito: cardápio.pdf"); expect(attachments).toContain("Anexo recusado: arquivo.exe");
    expect(api).not.toHaveBeenCalled();
  });

  it("e-mail mostra quota e resultado indeterminado sem repetir automaticamente", () => {
    installC2Web();
    for (const [state, expected] of [["unknown", "Resultado indeterminado"], ["quota_exhausted", "limite de envios"], ["pending", "Envio pendente"]]) {
      const conversation = { ...email, channel_extension: { metadata: { ...email.channel_extension.metadata, state } } };
      expect(render(React.createElement(ChannelConversationHeader, props(conversation)))).toContain(expected);
    }
    expect(api).not.toHaveBeenCalled();
  });

  it("Google separa consulta, publicação e administração e conserva Atendimento sem canal", () => {
    const review = { id: "review", account_label: "Loja", rating: 4, state: "active", version: 3, text: "Atendimento com atenção", reply_text: "" };
    const reader = { permissions: { can_read: true, can_reply: false, is_admin: false } };
    expect(reviewAccess(reader)).toEqual({ read: true, publish: false, admin: false });
    expect(() => prepareReviewReply(review, "Obrigada!", reader)).toThrow(/permissão/);
    const admin = { permissions: { is_admin: true } };
    expect(prepareReviewReply(review, "Obrigada!", admin)).toEqual({ type: "google.reply", version: 3, text: "Obrigada!" });
    expect(() => prepareReviewReply({ ...review, reply_state: "unknown" }, "Obrigada", admin)).toThrow();
    expect(() => prepareReviewReply(review, "x".repeat(4001), admin)).toThrow(/Vinki/);
    expect(uniqueReviews([review, review, { ...review, version: 2, text: "Antigo" }])).toEqual([review]);
    const common = { api, root, now, mode: "reviews" as const };
    expect(render(React.createElement(GoogleReviewsPage, { ...common, status: {} }))).toBe("");
    const html = render(React.createElement(GoogleReviewsPage, { ...common, status: { connected_channels: ["googlebusiness"], google_reviews: { ...reader, data: [review, review], partial: true } } }));
    expect(html).toContain("Página parcial"); expect(html).toContain("não tem permissão"); expect(html).not.toContain("Publicar resposta"); expect(html).not.toContain("Conceder publicação");
    const adminHtml = render(React.createElement(GoogleReviewsPage, { ...common, status: { connected_channels: ["googlebusiness"], google_reviews: { ...admin, data: [review] } } }));
    expect(adminHtml).toContain("Conceder publicação"); expect(adminHtml).toContain("Revisei o texto");
    expect(api).not.toHaveBeenCalled();
  });

  it("TikTok usa quota do servidor e não envia metade quando texto e imagem exigem duas vagas", () => {
    const conversation = tiktok(1);
    const file = { mediaId: "image", kind: "image" as const, mimeType: "image/png", bytes: 100 };
    const two = { ...draft(conversation), attachments: ["image"], attachmentDetails: [file], pendingAttachments: [file] };
    expect(tiktokQuotaState(conversation, now, 2)).toMatchObject({ remaining: 1, canSend: false });
    expect(() => prepareTikTokAction(two)).toThrow(/2 vagas/);
    expect(prepareTikTokAction(draft(conversation))).toMatchObject({ type: "message.send" });
    expect(() => prepareTikTokAction(draft(tiktok(0)))).toThrow();
    expect(tiktokQuotaState(tiktok(1), now + 48 * 3_600_000)).toMatchObject({ open: false });
    expect(tiktokQuotaState({ channel: "tiktok" }, now).canSend).toBe(false);
    const html = render(React.createElement(TikTokQuota, props(conversation)));
    expect(html).toContain("Restam 1 de 10 mensagens"); expect(html).toContain("não zera a contagem");
    const compose = render(React.createElement(TikTokComposerFields, { ...props(conversation), draft: two, disabled: false, change() {} }));
    expect(compose).toContain("Nenhuma parte será enviada");
    expect(render(React.createElement(TikTokQuota, props({ channel: "whatsapp" })))).toBe("");
  });
});

describe("c2-web: ingresso real e projeção sem efeitos forjados", () => {
  it("recusa assinatura errada antes de efeitos e não projeta avaliação nova", async () => {
    const fixture = await c2Fixture(); profiles.add(fixture.profile); await installSyntheticReview(fixture);
    const page = (data: unknown) => render(React.createElement(GoogleReviewsPage, { api, root, now, mode: "reviews", status: {
      connected_channels: ["googlebusiness"], google_reviews: { permissions: { can_read: true }, data },
    } }));
    const before = page(await all(env, "SELECT * FROM reviews WHERE profile_id=?", fixture.profile));
    expect((await c2ZernioWebhook(fixture, reviewFixtureEvent(fixture), "00")).status).toBe(403);
    await assertNoChannelEffects(fixture.profile);
    expect(page(await all(env, "SELECT * FROM reviews WHERE profile_id=?", fixture.profile))).toBe(before);
  }, 30_000);

  it("repetição concorrente produz uma avaliação, sem balões ou avisos extras", async () => {
    const fixture = await c2Fixture(); profiles.add(fixture.profile); await installSyntheticReview(fixture);
    const event = reviewFixtureEvent(fixture);
    const responses = await Promise.all([c2ZernioWebhook(fixture, event), c2ZernioWebhook(fixture, event)]);
    expect(responses.map(response => response.status)).toEqual([202, 202]);
    const rows = await all(env, "SELECT * FROM reviews WHERE profile_id=?", fixture.profile);
    expect(rows).toHaveLength(1); expect(rows[0].version).toBe(1);
    for (const table of ["messages", "conversations", "contacts", "outbox"]) expect(await all(env, `SELECT id FROM ${table} WHERE profile_id=?`, fixture.profile)).toEqual([]);
    const html = render(React.createElement(GoogleReviewsPage, { api, root, now, mode: "reviews", status: {
      connected_channels: ["googlebusiness"], google_reviews: { data: rows, permissions: { can_read: true } },
    } }));
    expect(html.split("Atendimento com atenção.")).toHaveLength(2);
  }, 30_000);
});
