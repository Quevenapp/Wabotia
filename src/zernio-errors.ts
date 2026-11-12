type ZernioFailure = {
  status: 400 | 502;
  code: "zernio_rejected" | "zernio_unknown";
  message: string;
};

const hidden = "[credencial omitida]";

function redact(message: string, secrets: readonly unknown[]): string {
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== "string" || !secret) continue;
    variants.add(secret);
    variants.add(JSON.stringify(secret).slice(1, -1));
    try {
      variants.add(encodeURIComponent(secret));
      variants.add(new URLSearchParams({ value: secret }).toString().slice(6));
    } catch {
      // An ill-formed Unicode secret can still be removed in its original form.
    }
  }
  for (const variant of [...variants].sort((a, b) => b.length - a.length))
    message = message.replaceAll(variant, hidden);
  return message
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"<>]+/gi, hidden)
    .replace(/\b(?:sk|zrk)_[a-zA-Z0-9_-]{6,}\b/g, hidden)
    .replace(
      /\b(?:api[-_ ]?key|access[-_ ]?token|token|secret|password|webhook[-_ ]?secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      hidden,
    )
    .replace(/(?:https?:\/\/|www\.)[^\s<>"']+/gi, "[endereço omitido]");
}

function safeMessage(value: unknown, secrets: readonly unknown[]): string {
  if (typeof value !== "string") return "";
  const message = redact(value, secrets)
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Stripping markup can join fragments into an echoed credential or URL.
  // Redact again before exposing the normalized text to an operator.
  return redact(message, secrets);
}

function identifier(
  value: unknown,
  pattern: RegExp,
  secrets: readonly unknown[],
): string {
  return typeof value === "string" &&
    pattern.test(value) &&
    safeMessage(value, secrets) === value
    ? value
    : "";
}

/**
 * Zernio's documented envelope has top-level error/code/param fields.
 * Pass the credentials used for the request to remove any echoed values.
 * Never copy structured details, provider payloads, or retry advice for an
 * uncertain write into the operator's message.
 */
export function normalizeZernioError(
  httpStatus: number,
  payload: unknown,
  secrets: readonly unknown[],
): ZernioFailure {
  const result =
    payload && typeof payload === "object"
      ? (payload as Record<string, any>)
      : {};
  const providerCode = identifier(result.code, /^[a-zA-Z0-9_]{1,80}$/, secrets);
  const parameter = identifier(
    result.param,
    /^[a-zA-Z_][a-zA-Z0-9_.\[\]-]{0,79}$/,
    secrets,
  );
  const context = `HTTP ${httpStatus}${providerCode ? `, código ${providerCode}` : ""}${parameter ? `, campo ${parameter}` : ""}`;
  const uncertain =
    httpStatus >= 500 ||
    !!result.unconfirmedWrite ||
    result.privateReplyOutcome === "unknown";
  if (uncertain)
    return {
      status: 502,
      code: "zernio_unknown",
      message: `A Zernio não confirmou a operação (${context}). Consulte a entrega antes de repetir.`,
    };

  const candidate = [result.error, result.message, result.error?.message].find(
    (value) => typeof value === "string" && value.trim(),
  );
  const detail = safeMessage(candidate, secrets);
  const bounded = detail.length > 320 ? `${detail.slice(0, 320)}…` : detail;
  return {
    status: 400,
    code: "zernio_rejected",
    message: `Zernio recusou a operação (${context}). ${bounded || "Confira os campos e as permissões da integração."}`,
  };
}
