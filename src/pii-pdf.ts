/** Leitor conservador de PDF textual. Formatos não demonstravelmente legíveis vão à equipe. */
const MAX_TEXT = 200_000;
const MAX_STREAM = 2_000_000;
// Preserva cada byte dos streams comprimidos, sem criar um array por byte.
const latin = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return text;
};

function contentText(
  content: string,
  fonts: Map<string, boolean>,
): string | null {
  let i = 0,
    inText = false,
    font = false,
    extended = false,
    out = "",
    operands: any[] = [];
  const string = () => {
    let result = "",
      depth = 1;
    i++;
    while (i < content.length && depth) {
      const c = content[i++];
      if (c === "\\") {
        const next = content[i++];
        if (/[0-7]/.test(next || "")) {
          let oct = next;
          while (oct.length < 3 && /[0-7]/.test(content[i] || ""))
            oct += content[i++];
          result += String.fromCharCode(parseInt(oct, 8));
        } else if (next === "\r" || next === "\n") {
          if (next === "\r" && content[i] === "\n") i++;
        } else
          result +=
            (
              { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<
                string,
                string
              >
            )[next] ?? next;
      } else if (c === "(") {
        depth++;
        result += c;
      } else if (c === ")") {
        if (--depth) result += c;
      } else result += c;
    }
    if (depth || /[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/.test(result))
      throw new Error("Texto sem mapa confiável");
    return { text: result };
  };
  while (i < content.length) {
    if (/\s/.test(content[i])) {
      i++;
      continue;
    }
    if (content[i] === "%") {
      while (i < content.length && !/[\r\n]/.test(content[i])) i++;
      continue;
    }
    if (content[i] === "(") {
      operands.push(string());
      continue;
    }
    if (content[i] === "[") {
      operands.push("[");
      i++;
      continue;
    }
    if (content[i] === "]") {
      const start = operands.lastIndexOf("[");
      if (start < 0) return null;
      operands.splice(
        start,
        operands.length - start,
        operands.slice(start + 1),
      );
      i++;
      continue;
    }
    if (content[i] === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i + 1);
      if (end < 0) return null;
      let hex = content.slice(i + 1, end).replace(/\s/g, "");
      if (!/^[0-9a-f]*$/i.test(hex)) return null;
      if (hex.length % 2) hex += "0";
      operands.push({
        text: hex.replace(/../g, (pair) =>
          String.fromCharCode(parseInt(pair, 16)),
        ),
      });
      i = end + 1;
      continue;
    }
    // Dicionários inline e imagens exigem outro leitor.
    if (/[<>]/.test(content[i])) return null;
    const m = /^[^\s()[\]<>%]+/.exec(content.slice(i));
    if (!m) return null;
    const word = m[0];
    i += word.length;
    if (word.startsWith("/") || /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) {
      operands.push(word);
      continue;
    }
    if (word === "BT") {
      if (inText) return null;
      inText = true;
    } else if (word === "ET") {
      if (!inText) return null;
      inText = false;
      out += "\n";
    } else if (word === "Tf") {
      font = fonts.has(operands[0]);
      extended = fonts.get(operands[0]) === true;
      if (!font) return null;
    } else if (["Tj", "TJ", "'", '"'].includes(word)) {
      if (!inText || !font) return null;
      const value = operands.at(-1);
      const parts = word === "TJ" ? value : [value];
      if (!Array.isArray(parts)) return null;
      for (const part of parts) {
        if (part && typeof part.text === "string") {
          if (
            /[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/.test(part.text) ||
            (!extended && /[^\x00-\x7f]/.test(part.text))
          )
            return null;
          out += part.text;
        } else if (typeof part !== "string" || !/^[+-]?[\d.]+$/.test(part))
          return null;
        // Não inserir espaço no kerning: um CPF pode estar dividido entre strings.
      }
      if (word === "'" || word === '"') out += "\n";
    } else if (["Td", "TD", "T*", "Tm"].includes(word)) out += "\n";
    else if (
      ![
        "q",
        "Q",
        "cm",
        "Tc",
        "Tw",
        "Tz",
        "TL",
        "Tr",
        "Ts",
        "g",
        "G",
        "rg",
        "RG",
        "k",
        "K",
      ].includes(word)
    )
      return null;
    operands = [];
    if (out.length > MAX_TEXT) return null;
  }
  return inText || operands.length ? null : out.trim() || null;
}

/** Sem rede nem dependências; somente fontes padrão e streams simples ou FlateDecode. */
export async function extractPersonalPdf(
  bytes: Uint8Array,
): Promise<string | null> {
  try {
    if (bytes.length > 4 * 1024 * 1024) return null;
    const raw = latin(bytes);
    if (
      !raw.startsWith("%PDF-") ||
      /\/(?:Encrypt|ObjStm|XRef|XObject|Image|ToUnicode|FontFile\d*|Differences)\b/.test(
        raw,
      )
    )
      return null;
    const objects = new Map<string, string>();
    for (const m of raw.matchAll(
      /(?:^|[\r\n])(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g,
    )) {
      if (objects.has(m[1])) return null;
      objects.set(m[1], m[2]);
    }
    const fontIds = new Map<string, boolean>();
    for (const [id, obj] of objects)
      if (/\/Type\s*\/Font\b/.test(obj)) {
        if (
          !/\/Subtype\s*\/Type1\b/.test(obj) ||
          !/\/BaseFont\s*\/(?:Helvetica|Times-Roman|Courier)(?=[\s/>])/.test(
            obj,
          ) ||
          (/\/Encoding\b/.test(obj) &&
            !/\/Encoding\s*\/(?:WinAnsiEncoding|StandardEncoding)\b/.test(obj))
        )
          return null;
        fontIds.set(id, /\/Encoding\s*\/WinAnsiEncoding\b/.test(obj));
      }
    if (!fontIds.size) return null;
    const fonts = new Map<string, boolean>();
    for (const m of raw.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R\b/g))
      if (fontIds.has(m[2])) fonts.set("/" + m[1], fontIds.get(m[2])!);
    const pages = [...objects.values()].filter((o) =>
      /\/Type\s*\/Page\b/.test(o),
    );
    if (!pages.length || pages.length > 10) return null;
    const texts: string[] = [];
    for (const page of pages) {
      const contents = /\/Contents\s*(\[[^\]]+\]|\d+\s+0\s+R)/.exec(page)?.[1];
      if (!contents) return null;
      const refs = [...contents.matchAll(/(\d+)\s+0\s+R/g)];
      if (!refs.length) return null;
      let content = "";
      for (const ref of refs) {
        const obj = objects.get(ref[1]);
        if (!obj) return null;
        const start = /\bstream\r?\n/.exec(obj);
        const lengthMatch = /\/Length\s+(\d+)([^\d][^/>]*)/.exec(
          obj.slice(0, start?.index),
        );
        const length =
          lengthMatch && !/^\s+\d+\s+R\b/.test(lengthMatch[2])
            ? lengthMatch[1]
            : null;
        if (!start || !length || Number(length) > MAX_STREAM) return null;
        const begin = start.index + start[0].length;
        const stream = obj.slice(begin, begin + Number(length));
        if (
          stream.length !== Number(length) ||
          !/^\r?\n?endstream\s*$/.test(obj.slice(begin + Number(length)).trim())
        )
          return null;
        const header = obj.slice(0, start.index);
        if (
          /\/Filter\b/.test(header) &&
          !/\/Filter\s*\/FlateDecode\b/.test(header)
        )
          return null;
        if (/\/DecodeParms\b/.test(header)) return null;
        if (/\/FlateDecode\b/.test(header)) {
          const packed = Uint8Array.from(stream, (c) => c.charCodeAt(0));
          const reader = new Blob([packed])
            .stream()
            .pipeThrough(new DecompressionStream("deflate"))
            .getReader();
          let size = 0;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > MAX_STREAM) {
                await reader.cancel();
                return null;
              }
              content += latin(value);
            }
          } finally {
            reader.releaseLock();
          }
        } else content += stream;
        content += "\n";
        if (content.length > MAX_STREAM) return null;
      }
      const text = contentText(content, fonts);
      if (!text) return null;
      texts.push(text);
      if (texts.join("\n").length > MAX_TEXT) return null;
    }
    return texts.join("\n");
  } catch {
    return null;
  }
}
