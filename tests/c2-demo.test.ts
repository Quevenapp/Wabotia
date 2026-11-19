import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createC2Demo, c2DemoHandler, C2_DEMO_SCENARIOS, C2_DEMO_FIXTURE_NOTE, resetC2Demo } from "../web/c2/demo";
import { dispatchChannelDemo, registerChannelDemo } from "../web/channel-extensions";
import type { ChannelDemoRequest } from "../web/channel-extension-contracts";

const NOW = Date.UTC(2026, 10, 19, 12);
const ROOT = "v1/profiles/demo";
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value as Row;
const rows = (value: unknown): Row[] => value as Row[];
type Demo = ReturnType<typeof createC2Demo>;
function read(demo: Demo, path: string, method = "GET", body?: unknown, key?: string, legacy?: ChannelDemoRequest["legacy"]): Row {
  const response = demo.request(ROOT + path, method, body, key, legacy);
  if (!response.handled) throw new Error("Rota não atendida: " + path);
  return object(response.data);
}
const send = (demo: Demo, id: string, action: Row, key = "send") => read(demo, `/conversations/demo-c2-${id}/message-actions`, "POST", { action: "channel", channel_action: action }, key);
const metadata = (demo: Demo, id: string) => object(object(read(demo, `/conversations/demo-c2-${id}`).channel_extension).metadata);

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Rede inesperada na demonstração c2."); }));
  vi.stubGlobal("location", { search: "?demo=1", origin: "https://demo.invalid" });
  resetC2Demo();
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("entrada explícita e cenários da segunda leva", () => {
  it("canal não usado passa sem alterar dados ou invocar o legado", () => {
    const legacy = vi.fn(() => ({ original: "Atendimento" }));
    const unused = createC2Demo("none", () => NOW);
    for (const path of ["/status", "/conversations", "/connections", "/c2/reviews", "/modules"])
      expect(unused.request(ROOT + path, "GET", undefined, undefined, legacy)).toEqual({ handled: false });
    expect(unused.snapshot().conversations).toEqual([]);
    expect(unused.snapshot().reviews).toEqual([]);
    expect(legacy).not.toHaveBeenCalled();
    registerChannelDemo(c2DemoHandler);
    const request: ChannelDemoRequest = { path: ROOT + "/status", method: "GET", body: undefined, key: undefined,
      query: new URLSearchParams("demo=1"), legacy };
    expect(dispatchChannelDemo(request)).toEqual({ handled: false });
    expect(dispatchChannelDemo({ ...request, query: new URLSearchParams("demo=1&canais=2") }).handled).toBe(true);
  });

  it("todas as fixtures são sintéticas e nenhuma depende de rede ou credencial", () => {
    expect(C2_DEMO_FIXTURE_NOTE).toContain("a conferir com a conta real");
    for (const scenario of C2_DEMO_SCENARIOS) {
      const demo = createC2Demo(scenario, () => NOW);
      const snapshot = demo.snapshot();
      expect(JSON.stringify(snapshot)).not.toMatch(/bot_token|webhook_secret|raw_html|api\.telegram\.org/);
      if (!["none", "google-disabled"].includes(scenario)) expect(demo.request(ROOT + "/status").handled).toBe(true);
      expect(demo.request(ROOT + "/modules")).toEqual({ handled: false });
    }
  });

  it("Google sozinho preserva os canais de conversa e Atendimento", () => {
    const demo = createC2Demo("google-only", () => NOW);
    const oldStatus = { connected_channels: ["whatsapp"], conversation_channels: ["whatsapp"],
      settings: { original: true }, conversations: [{ state: "human", count: 2 }] };
    const status = read(demo, "/status", "GET", undefined, undefined, () => oldStatus);
    expect(status.connected_channels).toEqual(["whatsapp", "googlebusiness"]);
    expect(status.conversation_channels).toEqual(["whatsapp"]);
    expect(status.multichannel).toBeUndefined();
    expect(status.settings).toEqual(oldStatus.settings);
    expect(demo.snapshot().conversations).toEqual([]);
    expect(rows(read(demo, "/c2/reviews").data)).toHaveLength(1);
    expect(rows(read(demo, "/c2/reviews").data)[0].reply_state).toBeUndefined();
    expect(createC2Demo("google-disabled").request(ROOT + "/c2/reviews")).toEqual({ handled: false });
  });

  it("filtros e paginação incluem somente o canal selecionado", () => {
    const demo = createC2Demo("all", () => NOW);
    const first = read(demo, "/conversations?channel=telegram&limit=1");
    const next = read(demo, `/conversations?channel=telegram&limit=1&cursor=${encodeURIComponent(String(first.next_cursor))}`);
    expect(rows(first.data)[0].channel).toBe("telegram");
    expect(rows(next.data)[0].id).not.toBe(rows(first.data)[0].id);
    expect(() => read(demo, `/conversations?channel=email&cursor=${encodeURIComponent(String(first.next_cursor))}`)).toThrow(/outro filtro/);
  });
});

describe("comentários e entrega idempotente", () => {
  it("separa publicação e autor sem juntar contato ou misturar balões", () => {
    const two = createC2Demo("comments-two-authors", () => NOW).snapshot();
    expect(two.conversations).toHaveLength(2);
    expect(new Set(two.conversations.map(row => row.contact_id)).size).toBe(2);
    expect(new Set(two.conversations.map(row => row.channel_extension.metadata.comment?.postId)).size).toBe(1);
    const posts = createC2Demo("comments-two-posts", () => NOW).snapshot();
    expect(new Set(posts.conversations.map(row => row.contact_id)).size).toBe(1);
    expect(new Set(posts.conversations.map(row => row.channel_extension.metadata.comment?.postId)).size).toBe(2);
  });

  it("evento concorrente repetido não duplica mensagem nem aviso de anexo", async () => {
    const demo = createC2Demo("telegram-large-media", () => NOW);
    const event = { id: "repeated", conversationId: "demo-c2-telegram-large-media", messageId: "large:2",
      text: "Anexo recusado; texto preservado.", created: NOW, content: { telegram: { warning: "attachment_too_large" } } };
    const result = await Promise.all([Promise.resolve(demo.applyEvent(event)), Promise.resolve(demo.applyEvent(event))]);
    expect(result).toEqual([{ duplicate: false }, { duplicate: true }]);
    const received = rows(read(demo, "/conversations/demo-c2-telegram-large-media").messages).filter(row => row.id === "large:2");
    expect(received).toHaveLength(1);
    expect(String(received[0].content).match(/attachment_too_large/g)).toHaveLength(1);
  });

  it("publicação exige ação explícita e preserva alvo, modo e texto no retry", () => {
    const demo = createC2Demo("comments-two-authors", () => NOW);
    const action = { type: "comment.reply", commentId: "comment:comments-two-authors", text: "Olá! Abrimos às 9h." };
    const first = send(demo, "comments-two-authors", action);
    expect(send(demo, "comments-two-authors", { ...action })).toEqual({ ...first, duplicate: true });
    expect(() => send(demo, "comments-two-authors", { ...action, text: "Texto alterado" })).toThrow(/outro pedido/);
    expect(() => send(demo, "comments-two-authors", { type: "message.send", text: "Implícita" }, "implicit")).toThrow(/alvo/);
    expect(demo.snapshot().receipts).toHaveLength(1);
    expect(rows(read(demo, "/conversations/demo-c2-comments-two-authors").messages).filter(row => row.direction === "outbound")).toHaveLength(1);
  });

  it("privada expirada/falha não ganha outra tentativa e sugestão não publica", () => {
    for (const scenario of ["comment-private-failed", "comment-private-expired"] as const) {
      const demo = createC2Demo(scenario, () => NOW);
      expect(() => send(demo, scenario, { type: "comment.private", commentId: `comment:${scenario}`, text: "Olá" })).toThrow();
      expect(demo.snapshot().receipts).toEqual([]);
    }
    const demo = createC2Demo("comment-hidden", () => NOW);
    const before = demo.snapshot().messages;
    expect(send(demo, "comment-hidden", { type: "comment.suggest", commentId: "comment:comment-hidden", text: "" }).status).toBe("suggestion");
    expect(demo.snapshot().messages).toEqual(before);
    send(demo, "comment-hidden", { type: "comment.visibility", commentId: "comment:comment-hidden", hidden: false }, "show");
    expect(object(metadata(demo, "comment-hidden").comment).hidden).toBe(false);
  });
});

describe("Google, e-mail e TikTok", () => {
  it("Google exige concessão, versão e reautorização do retry; sugestão não publica", () => {
    const denied = createC2Demo("google-forbidden", () => NOW);
    expect(object(read(denied, "/c2/reviews").permissions).can_reply).toBe(false);
    expect(() => read(denied, "/c2/reviews/demo-c2-google-forbidden/reply", "PUT", { version: 1, text: "Obrigada" }, "one")).toThrow(/permissão/);
    const demo = createC2Demo("google-new", () => NOW);
    const path = "/c2/reviews/demo-c2-google-new/reply";
    expect(() => read(demo, path, "PUT", { version: 2, text: "Obrigada" }, "wrong")).toThrow(/mudou/);
    const before = demo.snapshot().reviews;
    read(demo, "/c2/reviews/demo-c2-google-new/suggestion", "POST", { version: 1 }, "suggest");
    expect(demo.snapshot().reviews).toEqual(before);
    const result = read(demo, path, "PUT", { version: 1, text: "Obrigada" }, "reply");
    expect(result.status).toBe("pending");
    expect(read(demo, path, "PUT", { text: "Obrigada", version: 1 }, "reply")).toEqual({ ...result, duplicate: true });
    expect(() => read(demo, path, "PUT", { version: 1, text: "Outra resposta" }, "second")).toThrow(/resposta anterior/);
    expect(() => read(demo, path, "DELETE", { version: 1 }, "delete")).toThrow(/resposta anterior/);
    demo.setPublishAllowed(false);
    expect(() => read(demo, path, "PUT", { version: 1, text: "Obrigada" }, "reply")).toThrow(/permissão/);
    expect(demo.snapshot().conversations).toEqual([]);
    const unknown = createC2Demo("google-unknown", () => NOW);
    expect(() => read(unknown, "/c2/reviews/demo-c2-google-unknown/reply", "PUT", { version: 1, text: "Outra resposta" }, "second")).toThrow(/reconciliação/);
    expect(unknown.snapshot().receipts).toEqual([]);
  });

  it("página parcial não apaga avaliação e concessão administrativa é idempotente", () => {
    const demo = createC2Demo("google-partial", () => NOW);
    expect(read(demo, "/c2/reviews").partial).toBe(true);
    expect(read(demo, "/c2/reviews/sync", "POST", {}, "sync")).toMatchObject({ status: "pending", historical_import: false });
    read(demo, "/c2/review-publishers/pessoa", "PUT", {}, "grant");
    read(demo, "/c2/review-publishers/pessoa", "PUT", {}, "grant");
    expect(rows(read(demo, "/c2/reviews").publishers)).toHaveLength(1);
    expect(demo.snapshot().reviews[0].state).toBe("active");
  });

  it("e-mail automático, devolução e bloqueado ficam sem conversa; cabeçalhos não autenticam pessoa", () => {
    for (const scenario of ["email-automatic", "email-bounce", "email-blocked", "email-quarantine"] as const) {
      const snapshot = createC2Demo(scenario, () => NOW).snapshot();
      expect(snapshot.conversations).toEqual([]);
      expect(snapshot.inbox).toHaveLength(1);
    }
    const demo = createC2Demo("email-forged-auth", () => NOW);
    const email = object(metadata(demo, "email-forged-auth").email);
    expect(email.identityTrust).toBe("unverified_sender");
    expect(email.authentication).toContainEqual({ method: "dmarc", result: "pass" });
    expect(email.from).not.toBe(email.sender);
    const html = createC2Demo("email-hostile-html", () => NOW).snapshot();
    expect(JSON.stringify(html.messages)).not.toMatch(/<script|<img|raw_html|https?:\/\//);
  });

  it("e-mail preserva assunto no retry, rejeita cabeçalho injetado e não repete envio indeterminado", () => {
    const demo = createC2Demo("email-text", () => NOW);
    const action = { type: "email.send", text: "Olá!", subject: "Re: Pedido 123 · https://example.test" };
    const result = send(demo, "email-text", action);
    expect(send(demo, "email-text", action)).toEqual({ ...result, duplicate: true });
    expect(() => send(demo, "email-text", { ...action, subject: "Assunto alterado" })).toThrow(/outro pedido/);
    expect(() => send(demo, "email-text", { ...action, subject: "Assunto\r\nBcc: intruso@example.test" }, "injection")).toThrow(/assunto/);
    expect(send(demo, "email-text", { ...action, subject: "" }, "empty-subject").status).toBe("sent");
    expect(() => send(demo, "email-text", { ...action, subject: null }, "invalid-subject")).toThrow(/assunto/);
    expect(() => send(demo, "email-text", { ...action, text: null }, "invalid-text")).toThrow(/texto/);
    const unknown = createC2Demo("email-unknown", () => NOW);
    const before = unknown.snapshot().messages;
    expect(send(unknown, "email-unknown", action).status).toBe("unknown");
    expect(send(unknown, "email-unknown", action).duplicate).toBe(true);
    expect(unknown.snapshot().messages).toEqual(before);
  });

  it("Novo e-mail confirma endereço, preserva +tag e não junta ficha silenciosamente", () => {
    const demo = createC2Demo("email-test-received", () => NOW);
    const body = { contactId: "ficha-original", connectionId: "demo-c2-connection-email", address: "Pessoa+Loja@Example.Test", confirmed: true };
    expect(() => read(demo, "/c2/conversations/email", "POST", { ...body, confirmed: false }, "bad")).toThrow(/Confirme/);
    const result = read(demo, "/c2/conversations/email", "POST", body, "new");
    expect(read(demo, "/c2/conversations/email", "POST", body, "new")).toEqual({ ...result, duplicate: true });
    const snapshot = demo.snapshot();
    expect(snapshot.conversations).toHaveLength(1);
    expect(snapshot.conversations[0].contact_id).not.toBe(body.contactId);
    expect(snapshot.conversations[0].channel_extension.metadata.email?.sender).toBe("pessoa+loja@example.test");
    expect(Object.values(snapshot.messages).flat()).toEqual([]);
  });

  it("teste de recebimento mostra recebido ou inconclusivo, sem abrir atendimento", () => {
    for (const [scenario, state] of [["email-test-received", "received"], ["email-test-inconclusive", "expired"]] as const) {
      const demo = createC2Demo(scenario, () => NOW);
      expect(read(demo, "/c2/connections/demo-c2-connection-email/setup").test_state).toBe(state);
      expect(demo.snapshot().conversations).toEqual([]);
    }
  });

  it("TikTok reserva tudo ou nada; décima permitida, décima primeira recusada e eco não conta de novo", () => {
    const demo = createC2Demo("tiktok-nine", () => NOW);
    const text = { type: "message.send", text: "Olá!" };
    expect(() => send(demo, "tiktok-nine", { ...text, attachments: [{ mediaId: "image", kind: "image", mimeType: "image/png", bytes: 10 }] }, "two")).toThrow(/todas as entregas/);
    expect(object(metadata(demo, "tiktok-nine").tiktok).remainingMessages).toBe(1);
    const result = send(demo, "tiktok-nine", text);
    expect(object(metadata(demo, "tiktok-nine").tiktok).remainingMessages).toBe(0);
    expect(send(demo, "tiktok-nine", text)).toEqual({ ...result, duplicate: true });
    expect(() => send(demo, "tiktok-nine", text, "eleventh")).toThrow(/vagas/);
    expect(demo.applyEvent({ id: "echo", conversationId: "demo-c2-tiktok-nine", messageId: String(result.provider_message_id), text: "Olá!", created: NOW, external: true }).duplicate).toBe(true);
    expect(rows(read(demo, "/conversations/demo-c2-tiktok-nine").messages).filter(row => row.direction === "outbound")).toHaveLength(1);
    const external = createC2Demo("tiktok-external", () => NOW);
    expect(object(metadata(external, "tiktok-external").tiktok).remainingMessages).toBe(0);
  });

  it("TikTok texto e imagem geram duas entregas ordenadas e retry conserva ambas", () => {
    const demo = createC2Demo("tiktok-two-deliveries", () => NOW);
    const action = { type: "message.send", text: "Veja a imagem a seguir.",
      attachments: [{ mediaId: "image-synthetic", kind: "image", mimeType: "image/png", bytes: 10 }] };
    const result = send(demo, "tiktok-two-deliveries", action, "two");
    expect(result.delivery_ids).toHaveLength(2);
    expect(send(demo, "tiktok-two-deliveries", action, "two")).toEqual({ ...result, duplicate: true });
    const outbound = rows(read(demo, "/conversations/demo-c2-tiktok-two-deliveries").messages).filter(row => row.direction === "outbound");
    expect(outbound.map(row => row.kind)).toEqual(["text", "image"]);
    expect(outbound.map(row => row.id)).toEqual(result.delivery_ids);
    expect(outbound[0].text).toBe(action.text);
    expect(JSON.parse(String(outbound[1].attachments))).toEqual(["image-synthetic"]);
    expect(object(metadata(demo, "tiktok-two-deliveries").tiktok).remainingMessages).toBe(0);
    for (const message of outbound) expect(demo.applyEvent({ id: `echo:${message.id}`, conversationId: "demo-c2-tiktok-two-deliveries",
      messageId: String(message.id), text: String(message.text), created: NOW, external: true }).duplicate).toBe(true);
    expect(rows(read(demo, "/conversations/demo-c2-tiktok-two-deliveries").messages).filter(row => row.direction === "outbound")).toHaveLength(2);
  });
});
