import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelDemo, demoChannelWindow, FUTURE_DEMO_CHANNELS } from "../web/lib/demo-channels";
import { demoApi } from "../web/lib/demo";

const NOW = Date.UTC(2026, 10, 19, 12);
const HOUR = 3_600_000;
const ROOT = "v1/profiles/demo";
const conversation = ROOT + "/conversations/demo-cn-ig-open";
type Demo = ReturnType<typeof createChannelDemo>;
function read(demo: Demo, path: string, method = "GET", body?: unknown, key?: string): any {
  const response = demo.request(path, method, body, key);
  if (!response.handled) throw new Error("Rota sintética não atendida: " + path);
  return response.data;
}
const preview = (demo: Demo, destination: object = { kind: "self" }) =>
  read(demo, conversation + "/email/preview", "POST", { destination, range: { kind: "session" } });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Rede inesperada na demonstração"); }));
  vi.stubGlobal("location", { search: "?demo=1", origin: "https://demo.invalid" });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("demonstração multicanal sintética", () => {
  it("só WhatsApp conserva status, lista, capacidades e módulos da vitrine anterior", async () => {
    const status = await demoApi(ROOT + "/status");
    const list = await demoApi(ROOT + "/conversations");
    const detail = await demoApi(ROOT + "/conversations/demo-1");
    const modules = await demoApi(ROOT + "/modules");
    vi.stubGlobal("location", { search: "?demo=1&channels=whatsapp" });
    expect(await demoApi(ROOT + "/status")).toMatchObject({ settings: status.settings, modules: status.modules });
    expect(await demoApi(ROOT + "/conversations")).toEqual(list);
    expect((await demoApi(ROOT + "/conversations/demo-1")).capabilities).toEqual(detail.capabilities);
    expect(await demoApi(ROOT + "/modules")).toEqual(modules);
    expect(status.multichannel).toBeUndefined();
    expect(status.conversation_channels).toBeUndefined();
    expect(list.data.every((row: any) => row.channel === undefined)).toBe(true);
    expect(createChannelDemo("legacy", () => NOW).request(ROOT + "/status")).toEqual({ handled: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("multicanal se encaixa sem alterar a configuração ou os cenários dos módulos", async () => {
    const previous = await demoApi(ROOT + "/status");
    const modules = await demoApi(ROOT + "/modules");
    vi.stubGlobal("location", { search: "?demo=1&channels=multichannel" });
    const status = await demoApi(ROOT + "/status");
    expect(status.multichannel).toBe(true);
    expect(status.conversation_channels).toEqual(["whatsapp", "instagram", "facebook"]);
    expect(status.settings).toEqual(previous.settings);
    expect(status.modules).toEqual(previous.modules);
    expect(await demoApi(ROOT + "/modules")).toEqual(modules);
    expect(status.connections.some((row: any) => row.channel === "instagram" && row.account_label === "@loja_demo")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cobre DM antes de 24 h, com 25 h e no limite de 168 h, sem liberar automação na extensão", () => {
    const demo = createChannelDemo("multichannel", () => NOW);
    const open = read(demo, conversation);
    const human = read(demo, ROOT + "/conversations/demo-cn-ig-human");
    const closed = read(demo, ROOT + "/conversations/demo-cn-fb-closed");
    expect(open.window).toMatchObject({ state: "open", canHumanText: true, canAutomation: true });
    expect(human.window).toMatchObject({ state: "human_text_only", canHumanText: true, canAutomation: false });
    expect(closed.window).toMatchObject({ state: "closed", canHumanText: false, canAutomation: false });
    expect(demoChannelWindow(NOW - 24 * HOUR, NOW).state).toBe("human_text_only");
    expect(demoChannelWindow(NOW - 168 * HOUR, NOW).state).toBe("closed");
    expect(demoChannelWindow(0, NOW).state).toBe("closed");
    expect(open.capabilities).toMatchObject({ modules: false, templates: false, reply: false, can_initiate: false });
    expect(read(demo, ROOT + "/conversations/demo-cn-wa").capabilities.modules).toBe(true);
  });

  it("duas conversas compartilham a ficha, mas conservam contas, mensagens e janelas próprias", () => {
    const demo = createChannelDemo("multichannel", () => NOW);
    const instagram = read(demo, conversation);
    const whatsapp = read(demo, ROOT + "/conversations/demo-cn-wa");
    expect(instagram.contact.id).toBe(whatsapp.contact.id);
    expect(instagram.conversation.phone).toBeNull();
    expect(instagram.other_conversations).toHaveLength(1);
    expect(instagram.other_conversations[0]).toMatchObject({ id: "demo-cn-wa", channel: "whatsapp" });
    expect(instagram.messages.every((message: any) => message.conversation_id === instagram.conversation.id)).toBe(true);
    expect(instagram.window.closesAt).not.toBe(whatsapp.window.closesAt);
    expect(instagram.conversation.external_id).not.toMatch(/^\d+$/);
  });

  it("filtra antes de paginar e recusa cursor de outro canal", () => {
    const demo = createChannelDemo("multichannel", () => NOW);
    const first = read(demo, ROOT + "/conversations?channel=instagram&limit=1");
    expect(first.data).toHaveLength(1);
    expect(first.data[0].channel).toBe("instagram");
    expect(first.next_cursor).toBeTruthy();
    const next = read(demo, ROOT + "/conversations?channel=instagram&limit=1&cursor=" + encodeURIComponent(first.next_cursor));
    expect(next.data[0].id).not.toBe(first.data[0].id);
    expect(next.data[0].channel).toBe("instagram");
    expect(() => read(demo, ROOT + "/conversations?channel=facebook&cursor=" + encodeURIComponent(first.next_cursor)))
      .toThrow(/outro filtro/);
    expect(() => read(demo, ROOT + "/conversations?channel=desconhecido")).toThrow(/não habilitado/);
  });

  it("evento repetido, inclusive concorrente, produz uma mensagem e uma linha de conversa", async () => {
    const demo = createChannelDemo("multichannel", () => NOW);
    const before = demo.snapshot();
    const result = await Promise.all([Promise.resolve(demo.applyEvent(demo.mediaEvent)), Promise.resolve(demo.applyEvent(demo.mediaEvent))]);
    expect(result.every((item) => item.duplicate)).toBe(true);
    const after = demo.snapshot();
    expect(after.events).toEqual(before.events);
    expect(after.conversations).toHaveLength(before.conversations.length);
    expect(after.conversations.filter((row) => row.id === "demo-cn-fb-media")).toHaveLength(1);
    const detail = read(demo, ROOT + "/conversations/demo-cn-fb-media");
    const unavailable = detail.messages.filter((message: any) => message.id === demo.mediaEvent.messageId);
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].text).toContain("Anexo indisponível");
    expect(unavailable[0].attachments).toBe("[]");
    expect(JSON.stringify(detail)).not.toContain("https://");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("declara canais futuros sem permitir importação, formulário ou conexão utilizável", () => {
    const demo = createChannelDemo("multichannel", () => NOW);
    expect(FUTURE_DEMO_CHANNELS).toHaveLength(6);
    expect(FUTURE_DEMO_CHANNELS.every((item) => !item.enabled)).toBe(true);
    const status = read(demo, ROOT + "/status");
    for (const channel of ["tiktok", "googlebusiness", "telegram", "email"]) {
      expect(status.connected_channels).not.toContain(channel);
      expect(demo.request(ROOT + "/connections", "POST", { channel })).toEqual({ handled: false });
    }
  });
});

describe("prévia e recibos de e-mail na demonstração", () => {
  it("prévia só considera mensagens públicas e exige confirmação do contato e pedido do cliente", () => {
    const demo = createChannelDemo("multichannel", () => NOW);
    const approved = preview(demo, { kind: "contact" });
    expect(approved).toMatchObject({ recipient: "marina@example.test", messageCount: 1,
      requiresConfirmation: true, requiresCustomerRequest: true, expiresAt: NOW + 600_000 });
    expect(JSON.stringify(approved)).not.toContain("Nota interna:");
    expect(demo.snapshot().receipts).toHaveLength(0);
    expect(() => read(demo, conversation + "/email", "POST", { previewToken: approved.previewToken }, "send-1"))
      .toThrow(/endereço/);
    expect(() => read(demo, conversation + "/email", "POST", { previewToken: approved.previewToken, confirmedRecipient: approved.recipient }, "send-1"))
      .toThrow(/solicitou/);
    expect(read(demo, conversation + "/email", "POST", { previewToken: approved.previewToken,
      confirmedRecipient: approved.recipient, customerRequested: true }, "send-1")).toMatchObject({ status: "sent", duplicate: false });
  });

  it("destino digitado exige confirmação; intervalo inválido ou vazio é recusado", () => {
    const demo = createChannelDemo("multichannel", () => NOW);
    const approved = preview(demo, { kind: "custom", address: "copia@example.test" });
    expect(approved).toMatchObject({ requiresConfirmation: true, requiresCustomerRequest: false });
    expect(approved.warnings.join(" ")).toContain("mascarados");
    expect(() => read(demo, conversation + "/email", "POST", { previewToken: approved.previewToken }, "custom"))
      .toThrow(/endereço/);
    for (const range of [{ kind: "dates", from: NOW, to: NOW - 1 }, { kind: "dates", from: NOW + 1, to: NOW + 2 }])
      expect(() => read(demo, conversation + "/email/preview", "POST", { destination: { kind: "self" }, range })).toThrow();
    const dates = read(demo, conversation + "/email/preview", "POST", {
      destination: { kind: "self" }, range: { kind: "dates", from: NOW - 2 * HOUR, to: NOW },
    });
    expect(dates.messageCount).toBe(1);
  });

  it("falta de permissão e configuração aparecem nos DTOs e recusam envio", () => {
    for (const scenario of ["email-forbidden", "email-unavailable"] as const) {
      const demo = createChannelDemo(scenario, () => NOW);
      const options = read(demo, conversation).email_transcript;
      expect(options.available).toBe(false);
      if (scenario === "email-forbidden") expect(options.destinations).toEqual([]);
      else expect(options.reason).toContain("Gestão → Sistema → E-mail");
      expect(() => preview(demo)).toThrow();
      expect(() => read(demo, conversation + "/email", "POST", { previewToken: "fake" }, "send")).toThrow();
      expect(demo.snapshot().receipts).toEqual([]);
    }
  });

  it("histórico sem sessão delimitada exige datas, sem exportar toda a conversa silenciosamente", () => {
    const demo = createChannelDemo("multichannel", () => NOW);
    const path = ROOT + "/conversations/demo-cn-email-dates";
    expect(read(demo, path).email_transcript.ranges).toEqual(["dates"]);
    expect(() => read(demo, path + "/email/preview", "POST", {
      destination: { kind: "self" }, range: { kind: "session" },
    })).toThrow(/intervalo/);
    expect(read(demo, path + "/email/preview", "POST", { destination: { kind: "self" },
      range: { kind: "dates", from: NOW - 7 * HOUR, to: NOW },
    }).messageCount).toBe(1);
  });

  it("envio repetido com a mesma chave devolve o mesmo resultado sem nova reserva", async () => {
    const demo = createChannelDemo("multichannel", () => NOW);
    const approved = preview(demo);
    const body = { previewToken: approved.previewToken };
    const results = await Promise.all([Promise.resolve(read(demo, conversation + "/email", "POST", body, "same-key")),
      Promise.resolve(read(demo, conversation + "/email", "POST", body, "same-key"))]);
    expect(results[0]).toMatchObject({ status: "sent", duplicate: false });
    expect(results[1]).toEqual({ ...results[0], duplicate: true });
    expect(demo.snapshot().receipts).toHaveLength(1);
    expect(() => read(demo, conversation + "/email", "POST", { ...body, customerRequested: true }, "same-key"))
      .toThrow(/outro envio/);
    expect(() => read(demo, conversation + "/email", "POST", body)).toThrow(/chave/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("expiração pede nova prévia e os estados incertos não provocam reenvio", () => {
    let now = NOW;
    const expiring = createChannelDemo("multichannel", () => now);
    const approved = preview(expiring);
    now += 600_000;
    expect(() => read(expiring, conversation + "/email", "POST", { previewToken: approved.previewToken }, "expired"))
      .toThrow(/expirou/);
    for (const [scenario, status] of [["email-unknown", "unknown"], ["email-failed", "failed"], ["email-queued", "queued"]] as const) {
      const demo = createChannelDemo(scenario, () => NOW);
      const body = { previewToken: preview(demo).previewToken };
      const first = read(demo, conversation + "/email", "POST", body, "one");
      const repeat = read(demo, conversation + "/email", "POST", body, "one");
      expect(first.status).toBe(status);
      expect(repeat).toEqual({ ...first, duplicate: true });
      expect(demo.snapshot().receipts).toHaveLength(1);
    }
  });
});
