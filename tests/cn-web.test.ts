import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptOptions, TranscriptPreview, WindowState } from "../src/channel-contracts";
import type { AppState } from "../web/app/AppContext";
import type { Row } from "../web/lib/api";
import { Avatar } from "../web/ui/Avatar";
import { ChannelFilter } from "../web/conversations/ConversationList";
import { Composer } from "../web/conversations/Composer";
import { channelConversation, channelSendPolicy, headerSubtitle } from "../web/conversations/model";
import { conversationListKey, createConversationListGate } from "../web/conversations/useConversationList";
import { channelLabel, channelNotificationTitle, channelPresentation, conversationChannel, conversationChannels, isMultichannel } from "../web/channels";
import { windowInfo } from "../web/lib/window";
import { createTranscriptSender, transcriptAction, transcriptPreviewRequest, transcriptResultText, transcriptSendRequest } from "../web/conversations/EmailTranscriptDialog";

vi.mock("../web/app/AppContext", () => ({ useApp: () => app, useAppEvents: () => {} }));
vi.mock("opus-recorder", () => ({ default: class {} }));

const now = 1_795_100_000_000;
const hour = 3_600_000;
const app = {
  now, root: "v1/profiles/area", me: { id: "person" }, status: {}, settings: {},
  lineKinds: { wa: "zernio", qr: "qr", ig: "zernio" }, team: [], names: {}, bots: [],
  api: vi.fn(), demo: false,
} as unknown as AppState;
const caps = { text: true, image: true, video: true, audio: true, voice: true,
  document: true, sticker: true, reaction: true, reply: true, edit: true, calls: true, modules: true };
const serverWindow = (state: WindowState["state"] = "open"): WindowState => ({
  kind: "customer", state, serverNow: now, closesAt: state === "open" ? now + hour : now - hour,
  humanTextClosesAt: state === "closed" ? now : now + 143 * hour,
  canHumanText: state !== "closed", canAutomation: state === "open", remainingMessages: null,
  reason: state === "closed" ? "Aguarde uma nova mensagem do contato." : null,
});
const social = (state: WindowState["state"] = "open") => ({ id: "ig", connection_id: "ig", channel: "instagram",
  account_label: "@loja", state: "human", owner: "person", window: serverWindow(state), multichannel: true });
const options: TranscriptOptions = {
  available: true, reason: null, destinations: ["self", "contact", "custom"], ranges: ["session", "dates"],
  limits: { maxMessages: 2000, maxTextChars: 50_000, maxHtmlChars: 200_000, actorPer24Hours: 10, profilePer24Hours: 50, previewTtlMs: 600_000 },
};
const preview: TranscriptPreview = {
  recipient: "cliente@example.test", period: { from: now - hour, to: now }, messageCount: 3,
  size: { textChars: 100, htmlChars: 240 }, warnings: [], requiresConfirmation: true,
  requiresCustomerRequest: true, previewToken: "signed-preview", expiresAt: now + 600_000,
};
const noop = () => {};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Rede inesperada no teste de canais web."); }));
  app.status = {};
});
afterEach(() => vi.unstubAllGlobals());

describe("cn-web — apresentação compatível e canais conhecidos", () => {
  it("só WhatsApp e servidor antigo conservam avatar, filtro e subtítulo", () => {
    const before = renderToStaticMarkup(React.createElement(Avatar, { name: "Ana", badge: "mine" }));
    const after = renderToStaticMarkup(React.createElement(Avatar, { name: "Ana", badge: "mine", channel: "whatsapp", multichannel: false }));
    expect(after).toBe(before);
    expect(after).not.toContain("channel-badge");
    expect(renderToStaticMarkup(React.createElement(ChannelFilter, { channels: ["whatsapp"], value: "", onChange: noop }))).toBe("");
    expect(conversationChannels({})).toEqual([]);
    expect(isMultichannel({ conversation_channels: ["whatsapp"] })).toBe(false);
    const old = { connection_id: "wa", state: "human", owner: "person", last_customer: now - hour };
    expect(conversationChannel(old, app.lineKinds)).toBe("whatsapp");
    expect(headerSubtitle(old, app)).toBe("Com você");
    expect(channelPresentation(old, {}, app.lineKinds).subtitle).toBe("");
    expect(channelSendPolicy(old, caps, now, app.lineKinds)).toMatchObject({ legacy: true, text: true, media: true, modules: true });
    expect(windowInfo(old, app.lineKinds, now)).toMatchObject({ closed: false, remainingMs: 23 * hour });
    expect(windowInfo({ ...old, connection_id: "qr" }, app.lineKinds, now)).toBeNull();
  });

  it("multicanal tem selo, filtro acima dos estados e conta sem perder o estado", () => {
    const html = renderToStaticMarkup(React.createElement(Avatar, { name: "Ana", badge: "mine", channel: "instagram", multichannel: true }));
    expect(html).toContain("avatar-multichannel");
    expect(html).toContain('aria-label="Instagram"');
    expect(html).toContain('aria-label="Com você"');
    const filter = renderToStaticMarkup(React.createElement(ChannelFilter, { channels: ["whatsapp", "instagram", "facebook"], value: "instagram", onChange: noop }));
    expect(filter).toContain("Filtrar conversas por canal");
    expect(filter).toContain("Facebook");
    expect(headerSubtitle(social(), app)).toBe("Com você · Instagram · @loja");
    expect(channelConversation({ conversation: { state: "waiting" }, channel: "facebook", account_label: "Loja", capabilities: { text: true } }))
      .toMatchObject({ state: "waiting", channel: "facebook", account_label: "Loja" });
  });

  it("canal desconhecido, interno e aplicação não viram WhatsApp", () => {
    for (const row of [{ channel: "new-network", connection_id: "wa" }, { kind: "ai", connection_id: "wa" },
      { channel: "whatsapp", connection_kind: "ai" }, { external_namespace: "app:one", connection_id: "wa" }, {}]) {
      expect(conversationChannel(row, app.lineKinds)).not.toBe("whatsapp");
      expect(channelSendPolicy(row, caps, now, app.lineKinds).text).toBe(false);
      expect(windowInfo(row, app.lineKinds, now)).toBeNull();
    }
    expect(channelLabel("new-network")).toBe("Canal desconhecido");
    expect(conversationChannels({ conversation_channels: ["whatsapp", "telegram", "googlebusiness", "email", "tiktok"] })).toEqual(["whatsapp"]);
  });

  it("notificação prefixa uma vez, conserva WhatsApp isolado e prévia mínima", () => {
    expect(channelNotificationTitle("Ana", "instagram", true)).toBe("Instagram · Ana");
    expect(channelNotificationTitle("Instagram · Ana", "instagram", true)).toBe("Instagram · Ana");
    expect(channelNotificationTitle("Ana", "whatsapp", false)).toBe("Ana");
    expect(channelNotificationTitle("Ana", "instagram", true, true)).toBe("Wabotia");
  });
});

describe("cn-web — janela e campo de resposta", () => {
  it("a extensão libera somente texto humano e bloqueia automação, módulos, mídia e reações", () => {
    const policy = channelSendPolicy(social("human_text_only"), caps, now, app.lineKinds);
    expect(policy).toMatchObject({ text: true, humanTextOnly: true, media: false, automation: false, modules: false });
    for (const key of ["image", "video", "audio", "voice", "document", "reaction", "reply", "edit", "calls"])
      expect(policy.capabilities[key]).toBe(false);
    expect(windowInfo(social("human_text_only"), app.lineKinds, now)).toMatchObject({ state: "human_text_only", closed: false, remainingMs: 143 * hour });
    const html = renderToStaticMarkup(React.createElement(Composer, {
      detail: { conversation: social("human_text_only"), capabilities: caps }, windowClosed: false,
      quote: null, setQuote: noop, edit: null, setEdit: noop, refresh: async () => {}, onSent: noop, onMenu: noop, onTicket: noop,
    }));
    expect(html).toContain("Responder pelo Instagram");
    expect(html).toContain("somente texto escrito por uma pessoa");
    expect(html).not.toContain('aria-label="Gravar mensagem de voz"');
  });

  it("168 h, ausência de janela social e capacidade negada deixam o envio fechado", () => {
    expect(channelSendPolicy(social("closed"), caps, now, app.lineKinds)).toMatchObject({ text: false, media: false, automation: false });
    expect(channelSendPolicy({ channel: "instagram" }, caps, now).text).toBe(false);
    expect(channelSendPolicy(social(), { text: false }, now).text).toBe(false);
    expect(channelSendPolicy(social(), {}, now).text).toBe(false);
    const end = social("human_text_only");
    expect(channelSendPolicy(end, caps, Number(end.window.humanTextClosesAt)).text).toBe(false);
    expect(channelSendPolicy(social(), caps, now + hour).text).toBe(false);
    const html = renderToStaticMarkup(React.createElement(Composer, {
      detail: { conversation: social("closed"), capabilities: caps }, windowClosed: true,
      quote: null, setQuote: noop, edit: null, setEdit: noop, refresh: async () => {}, onSent: noop, onMenu: noop, onTicket: noop,
    }));
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).toContain("Aguarde uma nova mensagem");
  });

  it("canal sem prazo não recebe relógio e servidor prevalece sobre last_customer", () => {
    expect(windowInfo({ channel: "whatsapp", window: { kind: "none", state: "open" } }, {}, now)).toBeNull();
    expect(windowInfo({ ...social("closed"), last_customer: now }, {}, now)?.closed).toBe(true);
  });
});

describe("cn-web — paginação e respostas atrasadas", () => {
  it("canal, área e autorização participam da chave e invalidam páginas anteriores", async () => {
    const key = (channel: string, generation = 1) => conversationListKey("v1/profiles/a", generation, "all", "", "", channel);
    expect(key("instagram")).not.toBe(key("facebook"));
    expect(key("instagram", 2)).not.toBe(key("instagram"));
    const gate = createConversationListGate();
    gate.update(key("instagram"));
    const initial = gate.begin(key("instagram"));
    const page = gate.capture(key("instagram"));
    let resolve!: (rows: Row[]) => void;
    const pending = new Promise<Row[]>((done) => { resolve = done; });
    let shown: Row[] = [];
    const read = pending.then((rows) => { if (gate.current(page)) shown = rows; });
    gate.update(key("facebook"));
    expect(gate.current(initial)).toBe(false);
    const current = gate.begin(key("facebook"));
    shown = [{ id: "fb", channel: "facebook" }];
    resolve([{ id: "ig", channel: "instagram" }]);
    await read;
    expect(shown.map((row) => row.id)).toEqual(["fb"]);
    expect(gate.current(current)).toBe(true);
    gate.invalidate();
    expect(gate.current(current)).toBe(false);
  });
});

describe("cn-web — transcrição autorizada e confirmada", () => {
  it("sem permissão/servidor antigo não exibe ação; sem configuração explica destino", () => {
    expect(transcriptAction()).toMatchObject({ visible: false, enabled: false });
    expect(transcriptAction({ ...options, available: false, reason: "permission_denied" })).toMatchObject({ visible: false, enabled: false });
    expect(transcriptAction({ ...options, available: false, reason: "email_not_configured" })).toMatchObject({ visible: true, enabled: false, reason: "Configure o envio em Gestão → Sistema → E-mail." });
    expect(transcriptAction(options)).toMatchObject({ visible: true, enabled: true });
  });

  it("contato e endereço digitado exigem confirmação completa, pedido do cliente e prévia válida", () => {
    expect(() => transcriptSendRequest(preview, "errado@example.test", true, now, "contact")).toThrow(/endereço completo/);
    expect(() => transcriptSendRequest(preview, preview.recipient, false, now, "contact")).toThrow(/cliente solicitou/);
    expect(() => transcriptSendRequest(preview, preview.recipient, true, preview.expiresAt, "contact")).toThrow(/expirou/);
    expect(transcriptSendRequest(preview, preview.recipient, true, now, "contact")).toEqual({ previewToken: preview.previewToken, confirmedRecipient: preview.recipient, customerRequested: true });
    const custom = { ...preview, requiresCustomerRequest: false, requiresConfirmation: false };
    expect(() => transcriptSendRequest(custom, "", false, now, "custom")).toThrow(/endereço completo/);
    expect(transcriptSendRequest(custom, "", false, now, "self")).toEqual({ previewToken: preview.previewToken });
  });

  it("intervalo legado obriga datas e recusa destino/intervalo não autorizado", () => {
    const values = { destination: "self" as const, address: "", range: "session" as const, from: "", to: "" };
    expect(transcriptPreviewRequest(values, options)).toEqual({ destination: { kind: "self" }, range: { kind: "session" } });
    expect(() => transcriptPreviewRequest(values, { ...options, ranges: ["dates"] })).toThrow(/intervalo/);
    expect(() => transcriptPreviewRequest({ ...values, range: "dates" }, options)).toThrow(/intervalo válido/);
    const dates = transcriptPreviewRequest({ ...values, range: "dates", from: "2026-11-18T09:00:00Z", to: "2026-11-19T09:00:00Z" }, options);
    expect(dates.range).toEqual({ kind: "dates", from: Date.parse("2026-11-18T09:00:00Z"), to: Date.parse("2026-11-19T09:00:00Z") });
    expect(() => transcriptPreviewRequest({ ...values, destination: "custom", address: "a@example.test,b@example.test" }, options)).toThrow(/único/);
    expect(() => transcriptPreviewRequest({ ...values, destination: "custom", address: "a@example.test" }, { ...options, destinations: ["self"] })).toThrow(/não autorizado/);
  });

  it("dois cliques na mesma intenção mostram um resultado e indeterminado não reenvia", async () => {
    const result = { id: "email-1", status: "unknown" as const, to_masked: "c***@example.test", duplicate: false };
    const api = vi.fn(async () => result);
    const send = createTranscriptSender(api, "v1/profiles/a/conversations/c/email", () => "stable-key");
    const body = { previewToken: "preview" };
    expect(await Promise.all([send(body), send(body)])).toEqual([result, result]);
    expect(await send(body)).toEqual(result);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("v1/profiles/a/conversations/c/email", "POST", body, undefined, "stable-key");
    expect(transcriptResultText(result)).toContain("Não haverá reenvio automático");
    expect(transcriptResultText({ ...result, status: "sent", duplicate: true })).toContain("já havia sido registrado");
  });
});
