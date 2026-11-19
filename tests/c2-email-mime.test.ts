import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_REGISTRY, channelRules } from "../src/channels";
import { createChannelExtensionRegistry } from "../src/channel-extension-registry";
import { EMAIL_PARSE_LIMIT, EMAIL_RAW_LIMIT, emailHtmlToText, emailReferences, normalizeEmailAddress,
  normalizeEmailMessageId, parseEmailMime, safeEmailFilename, sanitizeEmailSubject } from "../src/c2/email-mime";

const envelope = { sender: "pessoa+tag@example.test", recipient: "caixa@example.test" };
const encode = (value: string) => new TextEncoder().encode(value);
const mail = (body: string, headers = "", contentType = "text/plain; charset=utf-8") => encode(
  `From: Pessoa <pessoa+tag@example.test>\r\nTo: caixa@example.test\r\nSubject: Olá, pedido 123 https://example.test/pedido\r\nMessage-ID: <entrada@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: ${contentType}\r\n${headers}\r\n${body}`,
);
function multipart(parts: string[], headers = "") {
  return mail(parts.map(part => `--parte\r\n${part}\r\n`).join("") + "--parte--\r\n", headers, "multipart/mixed; boundary=parte");
}
function attachment(name = "recibo.pdf", type = "application/pdf", data = "JVBERi0xLjQ=") {
  return `Content-Type: ${type}\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${data}`;
}
let network: ReturnType<typeof vi.spyOn>;
let unexpected: number;
beforeEach(() => {
  unexpected = 0;
  network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    unexpected++;
    throw new Error("Rede inesperada na fixture MIME.");
  });
});
afterEach(() => { network.mockRestore(); expect(unexpected).toBe(0); });

describe("c2-email: MIME hostil sem I/O", () => {
  it("canal não usado: o parser não instala extensão nem altera política de canais antigos", async () => {
    const registry = createChannelExtensionRegistry();
    const connection = { id: "linha", profile_id: "area", kind: "zernio", channel: "whatsapp" as const, config: "{}" };
    const before = channelRules(connection);
    await parseEmailMime(mail("Olá"), envelope);
    expect(channelRules(connection)).toEqual(before);
    expect(registry.channelExtensionReady("email/direct")).toBe(false);
    expect(CHANNEL_REGISTRY.email.enabled).toBe(false);
  });

  it("lê multipart, charset e acentos sem perder texto ou anexo", async () => {
    const parsed = await parseEmailMime(multipart([
      "Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nOl=E1, informa=E7=E3o sobre a=E7=E3o.",
      attachment("recibo.pdf"),
    ]), envelope);
    expect(parsed.text).toBe("Olá, informação sobre ação.");
    expect(parsed.subject).toContain("pedido 123 https://example.test/pedido");
    expect(parsed.attachments).toMatchObject([{ name: "recibo.pdf", mimeType: "application/pdf", kind: "document", size: 8 }]);
    expect(parsed.messageId).toBe("<entrada@example.test>");
    expect(parsed.classification).toBe("human");
  });

  it("prefere alternativa textual e não retorna HTML bruto", async () => {
    const raw = mail("--alt\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nTexto aprovado\r\n--alt\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<script>ataque()</script><p>Outro texto</p>\r\n--alt--", "", "multipart/alternative; boundary=alt");
    const parsed = await parseEmailMime(raw, envelope);
    expect(parsed.text).toBe("Texto aprovado");
    expect(parsed).not.toHaveProperty("html");
    expect(parsed).not.toHaveProperty("headers");
  });

  it("converte HTML com parser passivo, sem scripts, CSS, CID ou recursos remotos", async () => {
    const html = '<!doctype html><html><head><style>body{background:url(https://hostil.test/css)}</style><script>segredo()</script></head><body><p>Ol&aacute;, a&ccedil;&atilde;o &amp; caf&#233;</p><img src="https://hostil.test/pixel"><img src="cid:javascript:atacar"><iframe src="https://hostil.test"></iframe><svg><script>ataque()</script><text>invisível</text></svg><div hidden>oculto</div><a href="javascript:alert(1)">Apenas texto</a></body></html>';
    const parsed = await parseEmailMime(mail(html, "", "text/html; charset=utf-8"), envelope);
    expect(parsed.text).toContain("Olá, ação & café");
    expect(parsed.text).toContain("Apenas texto");
    for (const forbidden of ["segredo", "hostil.test", "javascript", "invisível", "oculto", "<script", "background"]) expect(parsed.text).not.toContain(forbidden);
    expect(parsed.attachments).toEqual([]);
  });

  it("HTML malformado e entidades viram somente texto", async () => {
    const text = await emailHtmlToText('<p title=">">Olá<br>mundo &lt;script&gt;texto&lt;/script&gt;</p><!-- sem fim');
    expect(text).toContain("Olá");
    expect(text).toContain("mundo <script>texto</script>");
    expect(text).not.toContain("title");
    expect(text).not.toContain("sem fim");
  });

  it("remove vários atributos sem invalidar o iterador do parser", async () => {
    const text = await emailHtmlToText('<p id="identificador" class="classe" style="background:url(https://hostil.test/css)" onclick="ataque()"><a href="https://hostil.test/link" title="não expor" data-payload="segredo">Ação &amp; café</a></p>');
    expect(text).toBe("Ação & café");
  });

  it("limita quantidade e rejeita tipos ativos com aviso, preservando texto", async () => {
    const parsed = await parseEmailMime(multipart([
      "Content-Type: text/plain\r\n\r\nTexto preservado",
      attachment("ataque.html", "text/html", "PHNjcmlwdD4="),
      ...Array.from({ length: 33 }, (_, index) => attachment(`recibo-${index}.pdf`)),
    ]), envelope);
    expect(parsed.text).toBe("Texto preservado");
    expect(parsed.attachments).toHaveLength(31);
    expect(parsed.attachmentWarnings).toContain("Os anexos após o limite de 32 arquivos foram recusados.");
    expect(parsed.attachmentWarnings).toContain("Anexo 1: tipo não permitido.");
    expect(parsed.attachments.some(item => item.mimeType === "text/html")).toBe(false);
  });

  it("recusa tamanho por tipo medindo bytes decodificados", async () => {
    const data = "A".repeat(4 * Math.ceil((5 * 1024 * 1024 + 1) / 3));
    const parsed = await parseEmailMime(multipart([
      "Content-Type: text/plain\r\n\r\nTexto preservado", attachment("foto.jpg", "image/jpeg", data),
    ]), envelope);
    expect(parsed.text).toBe("Texto preservado");
    expect(parsed.attachments).toEqual([]);
    expect(parsed.attachmentWarnings).toContain("Anexo 1: tamanho acima do limite local.");
  }, 30_000);

  it("limita envelope efetivo, partes MIME, cabeçalhos e HTML", async () => {
    await expect(parseEmailMime(new Uint8Array(EMAIL_RAW_LIMIT + 1), envelope)).rejects.toMatchObject({ code: "email_too_large" });
    await expect(parseEmailMime(new Uint8Array(EMAIL_PARSE_LIMIT + 1), envelope)).rejects.toMatchObject({ code: "email_parse_limit" });
    await expect(parseEmailMime(multipart(Array.from({ length: 97 }, () => "Content-Type: text/plain\r\n\r\nx")), envelope)).rejects.toMatchObject({ code: "email_mime_invalid" });
    await expect(parseEmailMime(mail("texto", `X-Long: ${"a".repeat(65_536)}\r\n`), envelope)).rejects.toMatchObject({ code: "email_mime_invalid" });
    await expect(emailHtmlToText("a".repeat(1_048_577))).rejects.toMatchObject({ code: "email_html_too_large" });
  }, 30_000);

  it("normaliza endereço sem remover +tag/pontos; recusa múltiplos endereços e CRLF", () => {
    expect(normalizeEmailAddress("Pessoa.Com+Tag@EXAMPLE.TEST")).toBe("pessoa.com+tag@example.test");
    expect(normalizeEmailAddress("pessoa@exémplo.test")).toBe("pessoa@xn--exmplo-cva.test");
    expect(normalizeEmailAddress("", { allowEmpty: true })).toBe("");
    for (const value of ["a@example.test,b@example.test", "a@example.test\r\nBcc:b@example.test", "Pessoa <a@example.test>", "a@https://example.test", "a@@example.test", "a..b@example.test", "d'angelo@example.test"]) expect(() => normalizeEmailAddress(value)).toThrow();
    expect(safeEmailFilename("../../pasta\\recibo\r\n.pdf")).toBe("recibo__.pdf");
    expect(() => sanitizeEmailSubject("Pedido 4\r\nBcc: b@example.test", true)).toThrow();
    expect(sanitizeEmailSubject("Pedido 4 https://example.test/4", true)).toBe("Pedido 4 https://example.test/4");
  });

  it("mantém agrupamento no envelope; From, Reply-To e autenticação são apenas informação", async () => {
    const raw = encode("From: Banco <outra@example.test>\r\nReply-To: desvio@example.test\r\nAuthentication-Results: falso; spf=pass; dkim=pass; dmarc=pass\r\nMessage-ID: <teste@example.test>\r\n\r\nMinha conta");
    const parsed = await parseEmailMime(raw, envelope);
    expect(parsed).toMatchObject({ from: "outra@example.test", replyTo: "desvio@example.test", identityTrust: "unverified_sender", verifiedChannel: null });
    expect(parsed.authentication).toEqual([{ method: "spf", result: "pass" }, { method: "dkim", result: "pass" }, { method: "dmarc", result: "pass" }]);
    expect(envelope.sender).toBe("pessoa+tag@example.test");
  });

  it.each([
    ["Auto-Submitted: auto-replied\r\n", "automatic"],
    ["Auto-Submitted: no\r\nAuto-Submitted: auto-generated\r\n", "automatic"],
    ["List-Unsubscribe: <https://example.test/sair>\r\n", "list"],
    ["Precedence: bulk\r\n", "list"],
    ["Return-Path: <>\r\n", "bounce"],
    ["X-Autoreply: yes\r\n", "automatic"],
  ])("classifica automático antes da abertura: %s", async (header, classification) => {
    const parsed = await parseEmailMime(mail("Mensagem automática", header), envelope);
    expect(parsed.classification).toBe(classification);
  });

  it("identifica envelope vazio, relatórios de entrega e mensagens humanas Auto-Submitted=no", async () => {
    expect((await parseEmailMime(mail("Devolução"), { ...envelope, sender: "" })).classification).toBe("bounce");
    expect((await parseEmailMime(mail("Relatório", "", 'multipart/report; report-type=delivery-status; boundary="report"'), envelope)).classification).toBe("bounce");
    expect((await parseEmailMime(mail("Olá", "Auto-Submitted: no\r\n"), envelope)).classification).toBe("human");
  });

  it("teste correto, errado ou malformado nunca vira mensagem humana", async () => {
    const token = "a".repeat(64);
    const valid = await parseEmailMime(encode(`Subject: Wabotia: teste de recebimento ${token}\r\n\r\nTeste`), envelope);
    expect(valid).toMatchObject({ classification: "probe", probeToken: token });
    const wrong = await parseEmailMime(encode("Subject: Wabotia: teste de recebimento errado\r\n\r\nTeste"), envelope);
    expect(wrong.classification).toBe("probe");
    expect(wrong.probeToken).toBeUndefined();
    const header = await parseEmailMime(mail("teste", `X-Wabotia-Email-Probe: ${token}\r\n`), envelope);
    expect(header.probeToken).toBe(token);
  });

  it("IDs divergentes vão para quarentena e não são escolhidos arbitrariamente", async () => {
    const parsed = await parseEmailMime(mail("Texto", "Message-ID: <outro@example.test>\r\n"), envelope);
    expect(parsed.quarantineReason).toBe("email_message_id_conflict");
    expect(parsed.messageId).toBeNull();
    expect(normalizeEmailMessageId("<a@example.test>\r\nBcc: b@example.test")).toBeNull();
    expect(normalizeEmailMessageId("<a@@example.test>")).toBeNull();
  });

  it("encadeamento tem no máximo 50 referências e 8 KiB", () => {
    const many = emailReferences(Array.from({ length: 70 }, (_, index) => `<${index}@example.test>`).join(" "));
    expect(many).toHaveLength(50);
    const large = emailReferences(Array.from({ length: 70 }, (_, index) => `<${index}${"a".repeat(200)}@example.test>`).join(" "));
    expect(encode(large.join(" ")).byteLength).toBeLessThanOrEqual(8192);
    expect(emailReferences("<a@example.test> <a@example.test> texto inválido <b@example.test>")).toEqual(["<a@example.test>", "<b@example.test>"]);
  });
});
