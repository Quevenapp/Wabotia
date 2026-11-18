/** Detecção sem E/S; também serve para o futuro texto transcrito de áudio. */
export type PiiKind = "CPF" | "CNPJ" | "TEL" | "EMAIL" | "CEP";
export interface PiiMatch {
  kind: PiiKind;
  value: string;
  start: number;
  end: number;
}
const digits = (value: string) => value.replace(/\D/g, "");
const ddds = new Set(
  "11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99".split(
    " ",
  ),
);
function validDocument(value: string) {
  if (/^(\d)\1+$/.test(value)) return false;
  const n = value.length;
  if (n !== 11 && n !== 14) return false;
  for (let size = n - 2; size < n; size++) {
    const sum = [...value.slice(0, size)].reduce(
      (s, c, i) =>
        s + Number(c) * (n === 11 ? size + 1 - i : ((size - 1 - i) % 8) + 2),
      0,
    );
    const check = (sum * 10) % 11;
    if (Number(value[size]) !== (check === 10 ? 0 : check)) return false;
  }
  return true;
}

/** Formatos explícitos ou números plausíveis; pedidos, dinheiro e datas não são documentos. */
export function detectPii(text: string): PiiMatch[] {
  const found: PiiMatch[] = [];
  const add = (
    kind: PiiKind,
    pattern: RegExp,
    accept: (s: string, before: string) => boolean = () => true,
  ) => {
    for (const m of text.matchAll(pattern)) {
      const start = m.index!,
        end = start + m[0].length;
      if (found.some((x) => start < x.end && end > x.start)) continue;
      if (
        kind !== "EMAIL" &&
        (/[\p{L}\p{N}_]/u.test(text[start - 1] || "") ||
          /[\p{L}\p{N}_]/u.test(text[end] || ""))
      )
        continue;
      const before = text.slice(Math.max(0, start - 45), start);
      if (
        kind !== "EMAIL" &&
        /(?:R\$\s*|(?:pedido|protocolo|ordem|código|codigo)\s*(?:n[º°o.]?\s*)?[:#-]?\s*)$/i.test(
          before,
        )
      )
        continue;
      if (accept(m[0], before)) found.push({ kind, value: m[0], start, end });
    }
  };
  // E-mail primeiro: os números no endereço não são outro documento.
  add(
    "EMAIL",
    /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/gi,
  );
  add(
    "CNPJ",
    /\b(?:\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})\b/g,
    (s, before) =>
      s.includes("/") || /cnpj\s*[:=]?\s*$/i.test(before) || validDocument(s),
  );
  add(
    "CPF",
    /\b(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})\b/g,
    (s, before) =>
      s.includes(".") || /cpf\s*[:=]?\s*$/i.test(before) || validDocument(s),
  );
  add(
    "TEL",
    /(?:\+?55[ .-]?)?(?:\([1-9]\d\)[ .-]?|[1-9]\d[ .-]?)(?:9\d{4}|[2-5]\d{3})[ -]?\d{4}\b/g,
    (s) => {
      let n = digits(s);
      if (n.length === 12 || n.length === 13) n = n.slice(2);
      return (n.length === 10 || n.length === 11) && ddds.has(n.slice(0, 2));
    },
  );
  // Sem DDD, somente com indicação de telefone, para não confundir números de pedido.
  add("TEL", /\b(?:9\d{4}|[2-5]\d{3})-?\d{4}\b/g, (_s, before) =>
    /(?:tel(?:efone)?|celular|whats(?:app)?)\s*[:=]?\s*$/i.test(before),
  );
  add(
    "CEP",
    /\b\d{5}-\d{3}\b|\b\d{8}\b/g,
    (s, before) => s.includes("-") || /cep\s*[:=]?\s*$/i.test(before),
  );
  return found.sort((a, b) => a.start - b.start);
}

export const maskPersonalEnabled = (config: any, remoteProfile: string) =>
  config?.bot_options?.[remoteProfile]?.mask_personal !== false;

export type PiiMask = ReturnType<typeof createPiiMask>;
/** Mapa privado de uma execução: nunca serializar nem guardar em uso, eventos ou logs. */
export function createPiiMask(enabled = true) {
  const values = new Map<string, string>();
  const markers = new Map<string, string>();
  const counts: Partial<Record<PiiKind, number>> = {};
  const reserved = new Set<string>();
  const token = /\[(?:CPF|CNPJ|TEL|EMAIL|CEP)_\d+\]/g;
  const reserve = (text: string) => {
    for (const m of text.matchAll(token)) reserved.add(m[0]);
  };
  const mask = (text: string): string => {
    if (!enabled) return text;
    reserve(text);
    let last = 0,
      out = "";
    for (const m of detectPii(text)) {
      let canonical = m.kind === "EMAIL" ? m.value : digits(m.value);
      if (m.kind === "TEL" && canonical.length >= 12)
        canonical = canonical.slice(2);
      const key = `${m.kind}:${canonical}`;
      let marker = markers.get(key);
      if (!marker) {
        do {
          marker = `[${m.kind}_${(counts[m.kind] = (counts[m.kind] || 0) + 1)}]`;
        } while (reserved.has(marker));
        markers.set(key, marker);
        values.set(marker, m.value);
      }
      out += text.slice(last, m.start) + marker;
      last = m.end;
    }
    return out + text.slice(last);
  };
  const restore = (text: string) =>
    enabled ? text.replace(token, (m) => values.get(m) ?? m) : text;
  const walk = (
    value: any,
    fn: (s: string, key: string) => string,
    key = "",
  ): any => {
    if (typeof value === "string") return fn(value, key);
    if (typeof value === "number") {
      const text = String(value),
        changed = fn(text, key);
      return changed === text ? value : changed;
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, fn, key));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, walk(v, fn, k)]),
      );
    return value;
  };
  const maskField = (text: string, key: string): string => {
    // Resultados das ferramentas costumam chegar como JSON dentro de texto.
    if (/^\s*[\[{]/.test(text)) {
      try {
        return JSON.stringify(maskValue(JSON.parse(text)));
      } catch {
        /* Texto comum. */
      }
    }
    const hint =
      (
        {
          cpf: "CPF ",
          cnpj: "CNPJ ",
          cep: "CEP ",
          phone: "telefone ",
          telefone: "telefone ",
          celular: "celular ",
          pedido: "pedido ",
          protocolo: "protocolo ",
          order_number: "pedido ",
          protocol_number: "protocolo ",
          valor: "R$ ",
          amount: "R$ ",
        } as Record<string, string>
      )[key.toLowerCase()] || "";
    return mask(hint + text).slice(hint.length);
  };
  const maskValue = (value: any): any => {
    if (!enabled) return value;
    reserve(JSON.stringify(value) ?? "");
    return walk(value, maskField);
  };
  const restoreValue = (value: any) => walk(value, restore);
  // Restaura JSON estruturalmente: valores com aspas não podem quebrar a resposta.
  const restoreText = (text: string) => {
    if (!enabled) return text;
    try {
      return JSON.stringify(restoreValue(JSON.parse(text)));
    } catch {
      return restore(text);
    }
  };
  const maskInput = (text: string) => {
    if (!enabled) return text;
    reserve(text);
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data))
        return JSON.stringify(maskValue(data));
      const { sources, ...rest } = data;
      return JSON.stringify({
        ...maskValue(rest),
        ...(Array.isArray(sources)
          ? {
              sources: sources.map((s: any) =>
                s.document_id === "specialist" || s.id === "atendimento"
                  ? maskValue(s)
                  : s,
              ),
            }
          : sources !== undefined
            ? { sources: maskValue(sources) }
            : {}),
      });
    } catch {
      return mask(text);
    }
  };
  return {
    enabled,
    mask,
    maskValue,
    maskInput,
    restore,
    restoreText,
    restoreValue,
  };
}
