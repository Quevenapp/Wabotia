import { createHmac, timingSafeEqual } from "node:crypto";
export function verifyWebhook(
  secret,
  headers,
  rawBody,
  now = Math.floor(Date.now() / 1000),
) {
  const timestamp = headers.get("Wabotia-Timestamp") || "",
    received = headers.get("Wabotia-Signature") || "";
  if (!/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300)
    return null;
  const expected =
    "v1=" +
    createHmac("sha256", secret)
      .update(timestamp + ".")
      .update(rawBody)
      .digest("hex");
  const a = Buffer.from(expected),
    b = Buffer.from(received);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const event = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  return String(event.id) === headers.get("Wabotia-Event-Id") ? event : null;
}
// Passe os bytes originais antes de qualquer parser JSON.
// Em uma transação no seu banco, insira event.id com índice UNIQUE e registre o trabalho
// numa fila/outbox. Responda 2xx após confirmar a transação. Duplicatas já persistidas
// também recebem 2xx. Não use um Set em memória para deduplicação em produção.
