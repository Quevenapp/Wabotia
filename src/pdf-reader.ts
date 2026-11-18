/** Tetos compartilhados pelo contador e pela extração, sem dependências de Node. */
export const PDF_LIMITS = {
  files: 1,
  bytes: 4 * 1024 * 1024,
  pages: 10,
} as const;
export const PDF_INFLATE_LIMITS = {
  streams: 64,
  bytes: 8 * 1024 * 1024,
} as const;

export function pdfLatin(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return text;
}

/** FlateDecode com teto de saída; erro, truncamento ou excesso devolvem null. */
export async function inflateBounded(
  data: Uint8Array<ArrayBuffer>,
  max: number,
): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = new Blob([data])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"))
      .getReader();
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        size += step.value.length;
        if (size > max) {
          await reader.cancel().catch(() => {});
          return null;
        }
        parts.push(step.value);
      }
    } finally {
      reader.releaseLock();
    }
  } catch {
    return null;
  }
  if (!size) return null;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export type PdfValue =
  | number
  | boolean
  | null
  | PdfValue[]
  | PdfDict
  | { name: string }
  | { bytes: string }
  | { ref: string }
  | { word: string };
export type PdfDict = { dict: Record<string, PdfValue> };
export const pdfName = (v: PdfValue | undefined): string | undefined =>
  v && typeof v === "object" && "name" in v ? v.name : undefined;
export function pdfDict(v: PdfValue | undefined): Record<string, PdfValue> {
  if (!v || typeof v !== "object" || !("dict" in v))
    throw new Error("Dicionário PDF inválido");
  return v.dict;
}
export const pdfRef = (v: PdfValue | undefined): string | undefined =>
  v && typeof v === "object" && "ref" in v ? v.ref : undefined;

/** Léxico comum a objetos, conteúdos e CMaps. Strings mantêm os bytes originais. */
export class PdfLexer {
  at = 0;
  constructor(readonly text: string) {}
  skip() {
    for (;;) {
      while (/[\x00\t\n\f\r ]/.test(this.text[this.at] ?? "x")) this.at++;
      if (this.text[this.at] !== "%") break;
      while (this.at < this.text.length && !/[\r\n]/.test(this.text[this.at]))
        this.at++;
    }
  }
  read(depth = 0): PdfValue {
    if (depth > 32) throw new Error("Profundidade PDF excedida");
    this.skip();
    const c = this.text[this.at++];
    if (c === "[") {
      const values: PdfValue[] = [];
      for (;;) {
        this.skip();
        if (this.text[this.at] === "]") {
          this.at++;
          return values;
        }
        if (values.length >= 100_000) throw new Error("Lista PDF excessiva");
        values.push(this.read(depth + 1));
      }
    }
    if (c === "<" && this.text[this.at] === "<") {
      this.at++;
      const dict: Record<string, PdfValue> = Object.create(null);
      for (;;) {
        this.skip();
        if (this.text.slice(this.at, this.at + 2) === ">>") {
          this.at += 2;
          return { dict };
        }
        const key = pdfName(this.read(depth + 1));
        if (!key || key in dict) throw new Error("Chave PDF ambígua");
        dict[key] = this.read(depth + 1);
      }
    }
    if (c === "<") {
      const end = this.text.indexOf(">", this.at);
      if (end < 0) throw new Error("Hexadecimal PDF cortado");
      let hex = this.text.slice(this.at, end).replace(/\s/g, "");
      if (!/^[\da-f]*$/i.test(hex)) throw new Error("Hexadecimal PDF inválido");
      if (hex.length % 2) hex += "0";
      this.at = end + 1;
      return {
        bytes: hex.replace(/../g, (pair) =>
          String.fromCharCode(parseInt(pair, 16)),
        ),
      };
    }
    if (c === "(") {
      let bytes = "",
        nesting = 1;
      while (this.at < this.text.length) {
        const ch = this.text[this.at++];
        if (ch === "\\") {
          const next = this.text[this.at++];
          if (/[0-7]/.test(next ?? "x")) {
            let oct = next;
            while (oct.length < 3 && /[0-7]/.test(this.text[this.at] ?? "x"))
              oct += this.text[this.at++];
            bytes += String.fromCharCode(parseInt(oct, 8) & 255);
          } else if (next === "\r" || next === "\n") {
            if (next === "\r" && this.text[this.at] === "\n") this.at++;
          } else
            bytes +=
              (
                { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<
                  string,
                  string
                >
              )[next] ?? next;
        } else if (ch === "(") {
          if (++nesting > 32) throw new Error("String PDF profunda");
          bytes += ch;
        } else if (ch === ")") {
          if (!--nesting) return { bytes };
          bytes += ch;
        } else if (ch === "\r") {
          if (this.text[this.at] === "\n") this.at++;
          bytes += "\n";
        } else bytes += ch;
      }
      throw new Error("String PDF cortada");
    }
    this.at--;
    const token = /^[^\x00\s()[\]<>/%]+/.exec(
      this.text.slice(this.at + (c === "/" ? 1 : 0)),
    )?.[0];
    if (!token) throw new Error("Token PDF inválido");
    this.at += token.length + (c === "/" ? 1 : 0);
    if (c === "/")
      return {
        name: token.replace(/#([\da-f]{2})/gi, (_, h) =>
          String.fromCharCode(parseInt(h, 16)),
        ),
      };
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
      const ref = /^\s+(\d+)\s+R\b/.exec(this.text.slice(this.at));
      if (/^\d+$/.test(token) && ref) {
        this.at += ref[0].length;
        return { ref: `${Number(token)} ${Number(ref[1])}` };
      }
      const num = Number(token);
      if (!Number.isFinite(num)) throw new Error("Número PDF inválido");
      return num;
    }
    if (token === "null") return null;
    if (token === "true" || token === "false") return token === "true";
    return { word: token };
  }
}

type PdfObject = { value: PdfValue; packed?: string };
/** Tabela de objetos e orçamento único para ObjStm, CMap e Contents. */
export async function readPdfObjects(bytes: Uint8Array) {
  if (bytes.length > PDF_LIMITS.bytes) throw new Error("PDF grande demais");
  const raw = pdfLatin(bytes);
  if (
    !raw.startsWith("%PDF-") ||
    /\/Encrypt\b/.test(raw) ||
    /%%EOF\s*\S/.test(raw)
  )
    throw new Error("PDF cifrado ou ambíguo");
  const objects = new Map<string, PdfObject>();
  const marker = /\b(\d+)\s+(\d+)\s+obj\b/g;
  for (let m; (m = marker.exec(raw));) {
    const id = `${Number(m[1])} ${Number(m[2])}`;
    if (objects.has(id) || objects.size >= 100_000)
      throw new Error("Objetos PDF ambíguos");
    const lexer = new PdfLexer(raw);
    lexer.at = marker.lastIndex;
    const value = lexer.read();
    lexer.skip();
    let packed: string | undefined;
    if (raw.startsWith("stream", lexer.at)) {
      const start = /^stream(?:\r\n|\n|\r)/.exec(raw.slice(lexer.at));
      if (!start) throw new Error("Stream PDF inválido");
      lexer.at += start[0].length;
      const length = pdfDict(value).Length;
      let end: number;
      if (
        typeof length === "number" &&
        Number.isSafeInteger(length) &&
        length >= 0
      )
        end = lexer.at + length;
      else if (pdfRef(length)) {
        // O objeto Length pode vir depois, inclusive comprimido. Validado antes do uso.
        end = raw.indexOf("endstream", lexer.at);
        if (raw[end - 1] === "\n") end--;
        if (raw[end - 1] === "\r") end--;
      } else throw new Error("Length PDF inválido");
      if (end < lexer.at || end > raw.length)
        throw new Error("Stream PDF cortado");
      packed = raw.slice(lexer.at, end);
      lexer.at = end;
      lexer.skip();
      if (!raw.startsWith("endstream", lexer.at))
        throw new Error("Length PDF incorreto");
      lexer.at += 9;
      lexer.skip();
    }
    if (!raw.startsWith("endobj", lexer.at))
      throw new Error("Objeto PDF cortado");
    marker.lastIndex = lexer.at + 6;
    objects.set(id, { value, packed });
  }
  function resolve(v: PdfValue | undefined): PdfValue | undefined {
    const seen = new Set<string>();
    for (let id; (id = pdfRef(v));) {
      if (seen.has(id) || seen.size >= 32 || !objects.has(id))
        throw new Error("Referência PDF cíclica ou ausente");
      seen.add(id);
      v = objects.get(id)!.value;
    }
    return v;
  }
  let budget: number = PDF_INFLATE_LIMITS.bytes,
    streams = 0;
  const decoded = new Map<string, string>();
  async function stream(ref: PdfValue): Promise<string> {
    const id = pdfRef(ref);
    if (!id) throw new Error("Stream sem referência");
    if (decoded.has(id)) return decoded.get(id)!;
    const object = objects.get(id);
    if (!object || object.packed === undefined)
      throw new Error("Stream ausente");
    const dict = pdfDict(object.value);
    if (resolve(dict.Length) !== object.packed.length || "DecodeParms" in dict)
      throw new Error("Stream ambíguo");
    let filter = resolve(dict.Filter);
    if (Array.isArray(filter) && filter.length === 1)
      filter = resolve(filter[0]);
    if (filter !== undefined && pdfName(filter) !== "FlateDecode")
      throw new Error("Filtro não suportado");
    if (++streams > PDF_INFLATE_LIMITS.streams)
      throw new Error("Streams demais");
    const data =
      filter === undefined
        ? object.packed
        : await inflateBounded(
            Uint8Array.from(object.packed, (c) => c.charCodeAt(0)),
            budget,
          );
    if (data === null || data.length > budget)
      throw new Error("Descompressão inválida ou excessiva");
    budget -= data.length;
    const text = typeof data === "string" ? data : pdfLatin(data);
    decoded.set(id, text);
    return text;
  }
  for (const [id, object] of [...objects]) {
    if (
      !object.value ||
      typeof object.value !== "object" ||
      !("dict" in object.value)
    )
      continue;
    const dict = object.value.dict;
    if (pdfName(dict.Type) !== "ObjStm") continue;
    const filter = resolve(dict.Filter);
    if (
      pdfName(
        Array.isArray(filter) && filter.length === 1
          ? resolve(filter[0])
          : filter,
      ) !== "FlateDecode"
    )
      throw new Error("ObjStm sem FlateDecode");
    const count = resolve(dict.N),
      first = resolve(dict.First);
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > 100_000 ||
      typeof first !== "number" ||
      !Number.isSafeInteger(first) ||
      first < 0
    )
      throw new Error("Cabeçalho ObjStm inválido");
    const text = await stream({ ref: id });
    if (first > text.length) throw new Error("ObjStm cortado");
    const header = new PdfLexer(text.slice(0, first));
    const entries: { id: string; offset: number }[] = [];
    for (let n = 0; n < count; n++) {
      const num = header.read(),
        offset = header.read();
      if (
        typeof num !== "number" ||
        !Number.isSafeInteger(num) ||
        num <= 0 ||
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        first + offset >= text.length ||
        (n === 0 ? offset !== 0 : offset <= entries[n - 1].offset)
      )
        throw new Error("Índice ObjStm inválido");
      entries.push({ id: `${num} 0`, offset });
    }
    header.skip();
    if (header.at !== first) throw new Error("Índice ObjStm ambíguo");
    for (let n = 0; n < entries.length; n++) {
      const entry = entries[n];
      if (objects.has(entry.id) || objects.size >= 100_000)
        throw new Error("Objeto comprimido duplicado");
      const lexer = new PdfLexer(
        text.slice(
          first + entry.offset,
          n + 1 < entries.length ? first + entries[n + 1].offset : undefined,
        ),
      );
      const value = lexer.read();
      lexer.skip();
      if (lexer.at !== lexer.text.length)
        throw new Error("Objeto comprimido ambíguo");
      objects.set(entry.id, { value });
    }
  }
  // A tabela já foi montada pelos objetos: XRef (inclusive com Predictor)
  // não precisa ser decodificado. Contents e ObjStm continuam passando por stream().
  return { objects, resolve, stream };
}
