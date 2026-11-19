import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec } from "../src/db";
import { copyTelegramMedia, prepareTelegramUpload, TELEGRAM_DOWNLOAD_MAX, TELEGRAM_MEDIA_POLICY, telegramMediaId, validateTelegramAttachment } from "../src/c2/telegram-media";
import { readTelegramUpdate, TELEGRAM_FIXTURES, telegramCall, telegramDeliveryResult, telegramGetMe, telegramSetWebhook } from "../src/c2/telegram-provider";
import type { TelegramInboundMedia } from "../src/c2/telegram-provider";
import { c2Fixture, countingEnv, denyNetwork, quietCoordinator } from "./c2-fixtures";

// Somente respostas sintéticas. Formato do plano; a conferir com a conta real.
const token = "123456:token_sintetico_privado";
const profiles = new Set<string>();
let network: ReturnType<typeof denyNetwork>;
beforeEach(() => { network = denyNetwork(); });
afterEach(async () => { for (const profile of profiles) await quietCoordinator(profile); profiles.clear(); network.restore(); network.assertNone(); }, 60_000);
async function fixture() { const f = await c2Fixture("telegram"); profiles.add(f.profile); return f; }
const pdf = (bytes: number | null = 3): TelegramInboundMedia => ({ kind: "document", fileId: "arquivo_sintetico", bytes, mimeType: "application/pdf", name: "documento.pdf" });
const ok = (result: unknown) => Response.json({ ok: true, result });

describe("Telegram: mídia privada e transporte", () => {
  it("canal não usado: lista vazia não lê D1, R2 nem credencial e não acessa rede", async () => {
    const counted = countingEnv(env);
    const result = await copyTelegramMedia(counted.env, { profileId: "unused", connectionId: "unused" }, "unused", [], "");
    expect(result).toEqual({ attachments: [], statements: [], unavailable: false, warnings: [] });
    expect(counted.count).toMatchObject({ calls: 0, statements: 0 });
  }, 30_000);

  it("valida tamanho anunciado antes de consultar arquivo ou baixar", async () => {
    const counted = countingEnv(env);
    const result = await copyTelegramMedia(counted.env, { profileId: "unused", connectionId: "unused" }, "large", [pdf(TELEGRAM_DOWNLOAD_MAX + 1)], token);
    expect(result).toMatchObject({ attachments: [], statements: [], unavailable: true, warnings: ["attachment_too_large"] });
    expect(counted.count.calls).toBe(0);
    expect(() => validateTelegramAttachment({ mediaId: "x", kind: "image", mimeType: "image/png", bytes: 10_000_001 })).toThrow();
    expect(() => validateTelegramAttachment({ mediaId: "x", kind: "document", mimeType: "application/pdf", bytes: 50_000_001 })).toThrow();
    expect(() => validateTelegramAttachment({ mediaId: "x", kind: "document", mimeType: "text/html", bytes: 10 })).toThrow();
    expect(TELEGRAM_MEDIA_POLICY.image!.maxSendBytes).toBeLessThanOrEqual(10_000_000);
  }, 30_000);

  it("copia para R2 privado e devolve INSERT para o lote; repetição reutiliza o mesmo arquivo", async () => {
    const f = await fixture(), order: string[] = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      const method = String(url).endsWith("/getFile") ? "getFile" : "download";
      order.push(method);
      return method === "getFile" ? ok({ file_path: "documents/file.pdf", file_size: 3, ignored: token })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "application/pdf", "Content-Length": "3" } });
    }) as typeof fetch;
    const options = { fetcher, beforeFetch: async () => { order.push("guard"); } };
    const first = await copyTelegramMedia(env, { profileId: f.profile, connectionId: f.line }, "700001:10", [pdf()], token, options);
    expect(order).toEqual(["guard", "getFile", "guard", "download"]);
    expect(first.attachments).toEqual([await telegramMediaId(f.line, "700001:10", 0, pdf().fileId)]);
    expect(first.unavailable).toBe(false);
    expect(await all(env, "SELECT id FROM media WHERE profile_id=?", f.profile)).toHaveLength(0);
    await batch(env, first.statements);
    const second = await copyTelegramMedia(env, { profileId: f.profile, connectionId: f.line }, "700001:10", [pdf()], token, options);
    expect(second.attachments).toEqual(first.attachments);
    expect(second.statements).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const stored = await all(env, "SELECT * FROM media WHERE profile_id=?", f.profile);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify({ first, second, stored })).not.toContain(token);
    expect(JSON.stringify(stored)).not.toContain("api.telegram.org");
    const object = await env.MEDIA.get(`${f.profile}/${first.attachments[0]}`);
    expect(object?.size).toBe(3);
    const edited = await copyTelegramMedia(env, { profileId: f.profile, connectionId: f.line }, "700001:10", [{ ...pdf(), fileId: "arquivo_editado_sintetico" }], token, options);
    expect(edited.attachments[0]).not.toBe(first.attachments[0]);
    expect(await env.MEDIA.head(`${f.profile}/${first.attachments[0]}`)).not.toBeNull();
  }, 60_000);

  it("mede bytes reais mesmo sem Content-Length e rejeita excesso sem persistir mídia", async () => {
    const f = await fixture();
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/getFile")) return ok({ file_path: "documents/file.pdf" });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new Uint8Array(10_000_001)); controller.enqueue(new Uint8Array(10_000_001)); controller.close();
      } }), { headers: { "Content-Type": "application/pdf" } });
    }) as typeof fetch;
    const result = await copyTelegramMedia(env, { profileId: f.profile, connectionId: f.line }, "large-stream", [pdf(null)], token, { fetcher });
    expect(result).toMatchObject({ attachments: [], statements: [], unavailable: true, warnings: ["attachment_too_large"] });
    expect(await all(env, "SELECT id FROM media WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await env.MEDIA.head(`${f.profile}/${await telegramMediaId(f.line, "large-stream", 0, pdf().fileId)}`)).toBeNull();
  }, 60_000);

  it("recusa MIME divergente, redirecionamento e caminho que poderia escapar do host", async () => {
    const f = await fixture();
    for (const variant of ["mime", "redirect", "path"]) {
      const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("/getFile")
        ? ok({ file_path: variant === "path" ? "../../segredo" : "documents/file.pdf", file_size: 3 })
        : variant === "redirect" ? new Response(null, { status: 302, headers: { Location: "https://unexpected.example/file" } })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "text/html" } })) as typeof fetch;
      const result = await copyTelegramMedia(env, { profileId: f.profile, connectionId: f.line }, variant, [pdf()], token, { fetcher });
      expect(result).toMatchObject({ attachments: [], statements: [], unavailable: true });
      expect(fetcher).toHaveBeenCalledTimes(variant === "path" ? 1 : 2);
      expect(JSON.stringify(result)).not.toContain(token);
    }
  }, 60_000);

  it("upload usa objeto privado e reconfere área, MIME e bytes", async () => {
    const f = await fixture(), id = await telegramMediaId(f.line, "upload", 0), key = `${f.profile}/${id}`;
    await env.MEDIA.put(key, new Uint8Array([1, 2, 3]));
    await exec(env, "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,'application/pdf',3,?,'test',1)", id, f.profile, "ação.pdf", key);
    const attachment = { mediaId: id, kind: "document" as const, mimeType: "application/pdf", bytes: 3 };
    const upload = await prepareTelegramUpload(env, f.profile, attachment);
    expect(upload.method).toBe("sendDocument");
    expect(upload.formData.get("document")).toBeInstanceOf(File);
    expect((upload.formData.get("document") as File).name).toBe("ação.pdf");
    await expect(prepareTelegramUpload(env, "outra-area", attachment)).rejects.toThrow();
    await expect(prepareTelegramUpload(env, f.profile, { ...attachment, bytes: 4 })).rejects.toThrow();
  }, 60_000);

  it("429 comprovado respeita retry_after e timeout/5xx de envio ficam indeterminados sem repetir", async () => {
    const time = vi.spyOn(Date, "now").mockReturnValue(1000);
    const rate = await telegramCall(token, "sendMessage", { chat_id: "700001", text: "Olá" }, { now: 1000,
      fetcher: vi.fn(async () => Response.json({ ok: false, error_code: 429, description: token, parameters: { retry_after: 7 } }, { status: 429 })) as typeof fetch });
    time.mockRestore();
    expect(rate).toEqual({ kind: "retry", code: "rate_limited", notBefore: 8000 });
    const fetcher = vi.fn(async () => { throw new Error(`timeout https://api.telegram.org/bot${token}/sendMessage`); }) as typeof fetch;
    const timeout = await telegramCall(token, "sendMessage", {}, { fetcher });
    expect(timeout).toEqual({ kind: "unknown", code: "provider_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const failed = await telegramCall(token, "sendMessage", {}, { fetcher: vi.fn(async () => new Response(token, { status: 502 })) as typeof fetch });
    expect(failed.kind).toBe("unknown");
    expect(JSON.stringify({ rate, timeout, failed })).not.toContain(token);
  }, 30_000);

  it("sanitiza resposta de getMe, webhook e entrega; guard revogado impede chamada", async () => {
    const get = await telegramGetMe(token, { fetcher: vi.fn(async () => ok({ id: 900001, is_bot: true, username: "bot_sintetico", token, description: token })) as typeof fetch });
    expect(get).toEqual({ kind: "ok", result: { id: "900001", is_bot: true, username: "bot_sintetico" } });
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.allowed_updates).toEqual(["message", "edited_message", "callback_query", "my_chat_member"]);
      expect(request.secret_token).toBe("segredo-sintetico");
      return ok(true);
    }) as typeof fetch;
    const webhook = await telegramSetWebhook(token, "https://example.test/webhooks/telegram-bot/id", "segredo-sintetico", { fetcher });
    expect(webhook).toEqual({ kind: "ok", result: { ok: true } });
    const delivery = telegramDeliveryResult(await telegramCall(token, "sendMessage", {}, { fetcher: vi.fn(async () => ok({ message_id: 34, text: token, chat: { token } })) as typeof fetch }));
    expect(delivery).toEqual({ kind: "sent", externalId: "34" });
    expect(JSON.stringify({ get, webhook, delivery })).not.toContain(token);
    const unused = vi.fn(async () => ok(true)) as typeof fetch;
    await expect(telegramCall(token, "sendMessage", {}, { fetcher: unused, beforeFetch: async () => { throw new Error("revogado"); } })).rejects.toThrow("revogado");
    expect(unused).not.toHaveBeenCalled();
  }, 30_000);

  it("leitor é puro, remove URL privada e mantém callback inválido para ack", () => {
    const input = structuredClone(TELEGRAM_FIXTURES.message);
    input.message.text = `Veja https://api.telegram.org/file/bot${token}/documents/file.pdf`;
    const event = readTelegramUpdate(input);
    expect(event?.kind).toBe("message.received");
    expect(JSON.stringify(event)).not.toContain(token);
    expect(readTelegramUpdate({ ...input, business_connection: { id: "no" } })).toBeNull();
    const callback = structuredClone(TELEGRAM_FIXTURES.callback);
    callback.callback_query.data = "x".repeat(65);
    expect(readTelegramUpdate(callback)?.callback).toMatchObject({ id: "query-sintetica", data: "" });
    callback.callback_query.message.chat.id = 700002;
    expect(readTelegramUpdate(callback)).toMatchObject({ kind: "callback", unsupported: true, callback: { id: "query-sintetica", data: "" } });
    expect(readTelegramUpdate(callback)?.subjectId).toBeUndefined();
    expect(readTelegramUpdate(TELEGRAM_FIXTURES.ownContact)?.contact).toMatchObject({ userId: "700001", phone: "+5511999990000" });
    const group = { ...input, message: { ...input.message, chat: { id: -700001, type: "group" } } };
    expect(readTelegramUpdate(group)).toMatchObject({ kind: "group.ignored", text: "", media: [] });
  }, 30_000);
});
