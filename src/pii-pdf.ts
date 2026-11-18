import {
  PDF_LIMITS,
  PDF_INFLATE_LIMITS,
  PdfLexer,
  pdfDict,
  pdfName,
  pdfRef,
  readPdfObjects,
  type PdfValue,
} from "./pdf-reader";
import { hasUnmaskedDocument, type PiiMask } from "./pii-mask";

/** Sem OCR: somente texto cuja codificação conseguimos demonstrar. */
const MAX_TEXT = 200_000;
type Pdf = Awaited<ReturnType<typeof readPdfObjects>>;
type Font = (bytes: string) => string;
const byteString = (v: PdfValue | undefined): string => {
  if (!v || typeof v !== "object" || !("bytes" in v))
    throw new Error("String PDF esperada");
  return v.bytes;
};
const integer = (v: PdfValue | undefined): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw new Error("Inteiro PDF esperado");
  return v;
};
const code = (s: string) => {
  if (s.length < 1 || s.length > 2)
    throw new Error("Código CMap não suportado");
  return s.length === 1
    ? s.charCodeAt(0)
    : s.charCodeAt(0) * 256 + s.charCodeAt(1);
};
const fromCode = (n: number, length: number) =>
  length === 1 ? String.fromCharCode(n) : String.fromCharCode(n >> 8, n & 255);
function unicode(bytes: string): string {
  if (!bytes.length || bytes.length % 2) throw new Error("UTF-16BE inválido");
  let result = "";
  for (let i = 0; i < bytes.length; i += 2)
    result += String.fromCharCode(
      bytes.charCodeAt(i) * 256 + bytes.charCodeAt(i + 1),
    );
  if (
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd\ufffe\uffff]/u.test(
      result,
    )
  )
    throw new Error("Unicode não confiável");
  return result;
}

/** CMap bfchar/bfrange com códigos de um ou dois bytes e saída UTF-16BE. */
function cmap(text: string): Font {
  const lexer = new PdfLexer(text),
    mapping = new Map<string, string>();
  const spaces: { low: string; high: string }[] = [];
  let previous: PdfValue = null,
    total = 0;
  const put = (source: string, target: string) => {
    code(source);
    if (mapping.has(source)) throw new Error("Código CMap duplicado");
    const value = unicode(target);
    total += value.length;
    if (total > MAX_TEXT || mapping.size >= 65536)
      throw new Error("CMap excessivo");
    mapping.set(source, value);
  };
  while (lexer.at < text.length) {
    lexer.skip();
    if (lexer.at === text.length) break;
    const token = lexer.read();
    const word =
      token && typeof token === "object" && "word" in token ? token.word : "";
    if (
      [
        "usecmap",
        "begincidchar",
        "begincidrange",
        "beginnotdefchar",
        "beginnotdefrange",
      ].includes(word)
    )
      throw new Error("CMap não suportado");
    if (["beginbfchar", "beginbfrange", "begincodespacerange"].includes(word)) {
      const count = integer(previous);
      if (count > 65536) throw new Error("CMap excessivo");
      for (let i = 0; i < count; i++) {
        const low = byteString(lexer.read());
        if (word === "beginbfchar") {
          put(low, byteString(lexer.read()));
          continue;
        }
        const high = byteString(lexer.read());
        const start = code(low),
          end = code(high);
        if (low.length !== high.length || end < start)
          throw new Error("Intervalo CMap inválido");
        if (word === "begincodespacerange") {
          if (spaces.length >= 64) throw new Error("Codespacerange excessivo");
          spaces.push({ low, high });
          continue;
        }
        const target = lexer.read();
        if (Array.isArray(target)) {
          if (target.length !== end - start + 1)
            throw new Error("Lista CMap incompleta");
          for (let n = start; n <= end; n++)
            put(fromCode(n, low.length), byteString(target[n - start]));
        } else {
          let dest = byteString(target);
          for (let n = start; n <= end; n++) {
            put(fromCode(n, low.length), dest);
            if (n === end) break;
            const values = Array.from(dest, (c) => c.charCodeAt(0));
            let at = values.length - 1;
            while (at >= 0 && values[at] === 255) values[at--] = 0;
            if (at < 0) throw new Error("Intervalo Unicode excedido");
            values[at]++;
            dest = String.fromCharCode(...values);
          }
        }
      }
      const close = lexer.read();
      if (
        !close ||
        typeof close !== "object" ||
        !("word" in close) ||
        close.word !== word.replace("begin", "end")
      )
        throw new Error("CMap cortado");
    }
    previous = token;
  }
  if (!mapping.size) throw new Error("CMap vazio");
  return (bytes) => {
    let out = "";
    for (let at = 0; at < bytes.length;) {
      const candidates = [1, 2].filter((length) => {
        const key = bytes.slice(at, at + length);
        return (
          key.length === length &&
          (spaces.length
            ? spaces.some(
                ({ low, high }) =>
                  low.length === length &&
                  code(key) >= code(low) &&
                  code(key) <= code(high),
              )
            : mapping.has(key))
        );
      });
      if (candidates.length !== 1) throw new Error("Código CMap ambíguo");
      const length = candidates[0],
        value = mapping.get(bytes.slice(at, at + length));
      if (value === undefined) throw new Error("Código sem ToUnicode");
      out += value;
      if (out.length > MAX_TEXT) throw new Error("Texto excessivo");
      at += length;
    }
    return out;
  };
}

// Nomes latinos da Adobe Glyph List, inclusive os acentos usados em português.
const GLYPHS: Record<string, string> = {
  space: " ",
  nonbreakingspace: "\u00a0",
  nbspace: "\u00a0",
  exclam: "!",
  quotedbl: '"',
  numbersign: "#",
  dollar: "$",
  percent: "%",
  ampersand: "&",
  quotesingle: "'",
  quoteright: "’",
  quoteleft: "‘",
  parenleft: "(",
  parenright: ")",
  asterisk: "*",
  plus: "+",
  comma: ",",
  hyphen: "-",
  period: ".",
  slash: "/",
  colon: ":",
  semicolon: ";",
  less: "<",
  equal: "=",
  greater: ">",
  question: "?",
  at: "@",
  bracketleft: "[",
  backslash: "\\",
  bracketright: "]",
  asciicircum: "^",
  underscore: "_",
  grave: "`",
  braceleft: "{",
  bar: "|",
  braceright: "}",
  asciitilde: "~",
  exclamdown: "¡",
  cent: "¢",
  sterling: "£",
  currency: "¤",
  yen: "¥",
  brokenbar: "¦",
  section: "§",
  dieresis: "¨",
  copyright: "©",
  ordfeminine: "ª",
  guillemotleft: "«",
  logicalnot: "¬",
  registered: "®",
  macron: "¯",
  degree: "°",
  plusminus: "±",
  twosuperior: "²",
  threesuperior: "³",
  acute: "´",
  mu: "µ",
  paragraph: "¶",
  periodcentered: "·",
  cedilla: "¸",
  onesuperior: "¹",
  ordmasculine: "º",
  guillemotright: "»",
  onequarter: "¼",
  onehalf: "½",
  threequarters: "¾",
  questiondown: "¿",
  AE: "Æ",
  ae: "æ",
  OE: "Œ",
  oe: "œ",
  Oslash: "Ø",
  oslash: "ø",
  Lslash: "Ł",
  lslash: "ł",
  Eth: "Ð",
  eth: "ð",
  Thorn: "Þ",
  thorn: "þ",
  germandbls: "ß",
  dotlessi: "ı",
  multiply: "×",
  divide: "÷",
  Euro: "€",
  bullet: "•",
  ellipsis: "…",
  endash: "–",
  emdash: "—",
  quotedblleft: "“",
  quotedblright: "”",
  quotesinglbase: "‚",
  quotedblbase: "„",
  dagger: "†",
  daggerdbl: "‡",
  perthousand: "‰",
  guilsinglleft: "‹",
  guilsinglright: "›",
  trademark: "™",
  florin: "ƒ",
  fi: "ﬁ",
  fl: "ﬂ",
  fraction: "⁄",
  minus: "−",
  breve: "˘",
  dotaccent: "˙",
  ring: "˚",
  hungarumlaut: "˝",
  ogonek: "˛",
  caron: "ˇ",
  circumflex: "ˆ",
  tilde: "˜",
};
for (const [i, name] of "zero one two three four five six seven eight nine"
  .split(" ")
  .entries())
  GLYPHS[name] = String(i);
const ACCENTS: Record<string, string> = {
  acute: "\u0301",
  grave: "\u0300",
  circumflex: "\u0302",
  tilde: "\u0303",
  dieresis: "\u0308",
  ring: "\u030a",
  cedilla: "\u0327",
  caron: "\u030c",
  breve: "\u0306",
  macron: "\u0304",
  ogonek: "\u0328",
  dotaccent: "\u0307",
  hungarumlaut: "\u030b",
};
function glyph(name: string): string | undefined {
  name = name.split(".")[0];
  if (/^[A-Za-z]$/.test(name)) return name;
  if (GLYPHS[name]) return GLYPHS[name];
  const accent = /^([A-Za-z])([a-z]+)$/.exec(name);
  if (accent && ACCENTS[accent[2]]) {
    const value = (accent[1] + ACCENTS[accent[2]]).normalize("NFC");
    if (value.length === 1) return value;
  }
  if (/^uni(?:[\dA-F]{4})+$/.test(name))
    return unicode(
      name.slice(3).replace(/../g, (h) => String.fromCharCode(parseInt(h, 16))),
    );
  return undefined;
}
function baseEncoding(name: string): Map<number, string> {
  const map = new Map<number, string>();
  if (name === "WinAnsiEncoding") {
    const special = "€\u0000‚ƒ„…†‡ˆ‰Š‹Œ\u0000Ž\u0000\u0000‘’“”•–—˜™š›œ\u0000žŸ";
    for (let i = 32; i <= 255; i++) {
      const value =
        i >= 128 && i <= 159 ? special[i - 128] : String.fromCharCode(i);
      if (i !== 127 && value !== "\u0000") map.set(i, value);
    }
    // WinAnsi do PDF usa /hyphen nesta posição, ao contrário do soft hyphen de CP1252.
    map.set(173, "-");
  } else if (name === "StandardEncoding") {
    for (let i = 32; i <= 126; i++) map.set(i, String.fromCharCode(i));
    map.set(39, "’");
    map.set(96, "‘");
    const extended: Record<number, string> = {
      161: "exclamdown",
      162: "cent",
      163: "sterling",
      164: "fraction",
      165: "yen",
      166: "florin",
      167: "section",
      168: "currency",
      169: "quotesingle",
      170: "quotedblleft",
      171: "guillemotleft",
      172: "guilsinglleft",
      173: "guilsinglright",
      174: "fi",
      175: "fl",
      177: "endash",
      178: "dagger",
      179: "daggerdbl",
      180: "periodcentered",
      182: "paragraph",
      183: "bullet",
      184: "quotesinglbase",
      185: "quotedblbase",
      186: "quotedblright",
      187: "guillemotright",
      188: "ellipsis",
      189: "perthousand",
      191: "questiondown",
      193: "grave",
      194: "acute",
      195: "circumflex",
      196: "tilde",
      197: "macron",
      198: "breve",
      199: "dotaccent",
      200: "dieresis",
      202: "ring",
      203: "cedilla",
      205: "hungarumlaut",
      206: "ogonek",
      207: "caron",
      208: "emdash",
      225: "AE",
      227: "ordfeminine",
      232: "Lslash",
      233: "Oslash",
      234: "OE",
      235: "ordmasculine",
      241: "ae",
      245: "dotlessi",
      248: "lslash",
      249: "oslash",
      250: "oe",
      251: "germandbls",
    };
    for (const [n, g] of Object.entries(extended))
      map.set(Number(n), GLYPHS[g]);
  } else throw new Error("Encoding não suportado");
  return map;
}

async function readFont(pdf: Pdf, value: PdfValue): Promise<Font> {
  const dict = pdfDict(pdf.resolve(value));
  if (pdfName(dict.Subtype) === "Type3")
    throw new Error("Fonte Type3 não suportada");
  if (dict.ToUnicode) return cmap(await pdf.stream(dict.ToUnicode));
  if (!["Type1", "TrueType"].includes(pdfName(dict.Subtype) ?? ""))
    throw new Error("Fonte sem mapa confiável");
  const standard =
    /^(Helvetica(?:-Bold|-Oblique|-BoldOblique)?|Times-(Roman|Bold|Italic|BoldItalic)|Courier(?:-Bold|-Oblique|-BoldOblique)?)$/.test(
      pdfName(dict.BaseFont) ?? "",
    );
  if (!standard && !dict.FontDescriptor)
    throw new Error("Fonte desconhecida sem descritor");
  if (dict.FontDescriptor) pdfDict(pdf.resolve(dict.FontDescriptor));
  const encoding = pdf.resolve(dict.Encoding);
  const details =
    encoding && typeof encoding === "object" && "dict" in encoding
      ? encoding.dict
      : null;
  const name =
    pdfName(details ? pdf.resolve(details.BaseEncoding) : encoding) ??
    (standard ? "StandardEncoding" : "");
  const map = baseEncoding(name);
  if (details?.Differences) {
    const differences = pdf.resolve(details.Differences);
    if (!Array.isArray(differences)) throw new Error("Differences inválido");
    let at = -1;
    for (const v of differences) {
      if (typeof v === "number") at = integer(v);
      else {
        const name = pdfName(v);
        if (!name || at < 0 || at > 255)
          throw new Error("Differences inválido");
        const text = glyph(name);
        if (text === undefined) map.delete(at);
        else map.set(at, text);
        at++;
      }
      if (at > 256) throw new Error("Differences excessivo");
    }
  }
  return (bytes) => {
    let result = "";
    for (const c of bytes) {
      const text = map.get(c.charCodeAt(0));
      if (text === undefined) throw new Error("Glifo sem mapa confiável");
      if (result.length + text.length > MAX_TEXT)
        throw new Error("Texto excessivo");
      result += text;
    }
    return result;
  };
}

async function contentText(
  pdf: Pdf,
  content: string,
  resources: Record<string, PdfValue>,
): Promise<string> {
  const fonts = resources.Font ? pdfDict(pdf.resolve(resources.Font)) : {};
  const cache = new Map<string, Font>(),
    stack: { font: Font | undefined; leading: number }[] = [];
  const lexer = new PdfLexer(content);
  let font: Font | undefined,
    inText = false,
    out = "";
  let x = 0,
    y = 0,
    leading = 0;
  let matrix = [1, 0, 0, 1];
  let operands: PdfValue[] = [];
  const newline = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const space = () => {
    if (out && !/\s$/.test(out)) out += " ";
  };
  const move = (dx: number, dy: number) => {
    x += matrix[0] * dx + matrix[2] * dy;
    y += matrix[1] * dx + matrix[3] * dy;
  };
  const nextLine = () => {
    move(0, -leading);
    newline();
  };
  while (lexer.at < content.length) {
    lexer.skip();
    if (lexer.at === content.length) break;
    const token = lexer.read();
    if (!token || typeof token !== "object" || !("word" in token)) {
      if (operands.length >= 100_000) throw new Error("Operandos excessivos");
      operands.push(token);
      continue;
    }
    const word = token.word;
    if (word === "BT") {
      if (inText) throw new Error("BT duplicado");
      inText = true;
      x = y = 0;
      matrix = [1, 0, 0, 1];
    } else if (word === "ET") {
      if (!inText) throw new Error("ET sem BT");
      inText = false;
      newline();
    } else if (word === "Tf") {
      const name = pdfName(operands[0]);
      if (operands.length !== 2 || !name || !fonts[name])
        throw new Error("Fonte ausente");
      if (!cache.has(name)) cache.set(name, await readFont(pdf, fonts[name]));
      font = cache.get(name);
    } else if (["Tj", "TJ", "'", '"'].includes(word)) {
      if (!inText || !font) throw new Error("Texto sem fonte");
      if (word === "'" || word === '"') nextLine();
      const value = operands.at(-1),
        parts = word === "TJ" ? value : [value];
      if (!Array.isArray(parts)) throw new Error("Operador de texto inválido");
      for (const part of parts) {
        if (typeof part === "number" && word === "TJ") {
          // Deslocamentos largos separam palavras; kerning pequeno continua colado.
          if (part <= -200) space();
          continue;
        }
        out += font(byteString(part));
        if (out.length > MAX_TEXT) throw new Error("Texto excessivo");
      }
    } else if (word === "T*") {
      nextLine();
    } else if (["Td", "TD", "Tm", "TL"].includes(word)) {
      if (
        operands.length !== (word === "Tm" ? 6 : word === "TL" ? 1 : 2) ||
        !operands.every((v) => typeof v === "number")
      )
        throw new Error("Posição de texto inválida");
      const values = operands as number[];
      const oldX = x,
        oldY = y;
      if (word === "TL") leading = values[0];
      else if (word === "Tm") {
        matrix = values.slice(0, 4);
        [x, y] = values.slice(4);
      } else {
        if (word === "TD") leading = -values[1];
        move(values[0], values[1]);
      }
      if (y !== oldY) newline();
      else if (x !== oldX) space();
    } else if (word === "q") {
      if (stack.length >= 32) throw new Error("Estado gráfico profundo");
      stack.push({ font, leading });
    } else if (word === "Q") {
      if (!stack.length) throw new Error("Estado gráfico inválido");
      ({ font, leading } = stack.pop()!);
    } else if (word === "Do") {
      const name = pdfName(operands[0]);
      const xobjects = pdfDict(pdf.resolve(resources.XObject));
      if (
        !name ||
        pdfName(pdfDict(pdf.resolve(xobjects[name])).Subtype) !== "Image"
      )
        throw new Error("XObject não suportado");
      // Imagens são ignoradas; Form XObjects podem conter texto e exigem outro leitor.
    } else if (word === "BI") {
      if (inText || operands.length)
        throw new Error("Imagem inline em posição inválida");
      const dict: Record<string, PdfValue> = Object.create(null);
      for (;;) {
        const key = lexer.read();
        if (
          key &&
          typeof key === "object" &&
          "word" in key &&
          key.word === "ID"
        )
          break;
        const name = pdfName(key);
        if (!name || name in dict) throw new Error("Imagem inline ambígua");
        dict[name] = lexer.read();
      }
      if (!/\s/.test(content[lexer.at] ?? "x"))
        throw new Error("Imagem inline sem separador");
      if (content[lexer.at++] === "\r" && content[lexer.at] === "\n")
        lexer.at++;
      const start = lexer.at;
      const filter = pdfName(dict.F ?? dict.Filter);
      let end: number;
      if (dict.Length !== undefined) end = start + integer(dict.Length);
      else if (!filter && !dict.F && !dict.Filter) {
        const colors = {
          G: 1,
          DeviceGray: 1,
          RGB: 3,
          DeviceRGB: 3,
          CMYK: 4,
          DeviceCMYK: 4,
        }[pdfName(dict.CS ?? dict.ColorSpace) ?? ""];
        const mask = (dict.IM ?? dict.ImageMask) === true;
        const bits = mask ? 1 : integer(dict.BPC ?? dict.BitsPerComponent);
        if ((!colors && !mask) || ![1, 2, 4, 8, 16].includes(bits))
          throw new Error("Imagem inline não suportada");
        end =
          start +
          Math.ceil(
            (integer(dict.W ?? dict.Width) * (mask ? 1 : colors!) * bits) / 8,
          ) *
            integer(dict.H ?? dict.Height);
      } else if (filter === "DCT" || filter === "DCTDecode") {
        const marker = content.indexOf("\xff\xd9", start);
        if (marker < 0) throw new Error("JPEG inline cortado");
        end = marker + 2;
      } else {
        // Imagem filtrada inline termina no delimitador EI do PDF. Os bytes
        // anteriores nunca entram no léxico dos operadores de texto. Um EI
        // extra ou conteúdo malformado depois dele faz a página ser recusada.
        const marker = /[\x00\t\n\f\r ]EI(?=[\x00\t\n\f\r ]|$)/.exec(content.slice(start));
        if (!marker) throw new Error("Imagem inline cortada");
        end = start + marker.index;
      }
      if (!Number.isSafeInteger(end) || end < start || end > content.length)
        throw new Error("Imagem inline cortada");
      lexer.at = end;
      lexer.skip();
      const close = lexer.read();
      if (
        !close ||
        typeof close !== "object" ||
        !("word" in close) ||
        close.word !== "EI"
      )
        throw new Error("Fim de imagem inline inválido");
    } else if (word === "gs") {
      const name = pdfName(operands[0]);
      const states = pdfDict(pdf.resolve(resources.ExtGState));
      if (!name) throw new Error("Estado gráfico sem nome");
      const state = pdfDict(pdf.resolve(states[name]));
      if (state.Font) {
        const value = pdf.resolve(state.Font);
        if (!Array.isArray(value) || value.length !== 2)
          throw new Error("Fonte gráfica inválida");
        font = await readFont(pdf, value[0]);
      }
    } else if (
      ![
        "cm",
        "Tc",
        "Tw",
        "Tz",
        "Tr",
        "Ts",
        "g",
        "G",
        "rg",
        "RG",
        "k",
        "K",
        "m",
        "l",
        "c",
        "v",
        "y",
        "h",
        "re",
        "S",
        "s",
        "f",
        "F",
        "f*",
        "B",
        "B*",
        "b",
        "b*",
        "n",
        "W",
        "W*",
        "w",
        "J",
        "j",
        "M",
        "d",
        "ri",
        "i",
        "CS",
        "cs",
        "SC",
        "SCN",
        "sc",
        "scn",
        "sh",
        "BMC",
        "BDC",
        "EMC",
        "MP",
        "DP",
      ].includes(word)
    )
      throw new Error("Operador PDF não suportado");
    if (word === "BDC" || word === "DP") {
      const name = pdfName(operands[1]);
      if (name) {
        const properties = pdfDict(pdf.resolve(resources.Properties));
        operands.push({ dict: pdfDict(pdf.resolve(properties[name])) });
      }
    }
    if (
      operands.some(
        (v) =>
          v && typeof v === "object" && "dict" in v && "ActualText" in v.dict,
      )
    )
      throw new Error("ActualText não suportado");
    operands = [];
  }
  if (inText || stack.length || operands.length)
    throw new Error("Conteúdo PDF incompleto");
  return out.trim();
}

export async function extractPersonalPdf(
  bytes: Uint8Array,
): Promise<string | null> {
  try {
    const pdf = await readPdfObjects(bytes);
    const catalogs = [...pdf.objects.values()].filter(
      ({ value }) =>
        value &&
        typeof value === "object" &&
        "dict" in value &&
        pdfName(value.dict.Type) === "Catalog",
    );
    if (catalogs.length !== 1) return null;
    const seen = new Set<string>(),
      pages: {
        page: Record<string, PdfValue>;
        resources: Record<string, PdfValue>;
      }[] = [];
    function visit(
      ref: PdfValue,
      inherited: Record<string, PdfValue>,
      depth: number,
    ) {
      const id = pdfRef(ref);
      if (!id || seen.has(id) || depth > 32 || seen.size >= 100_000)
        throw new Error("Árvore de páginas cíclica ou profunda");
      seen.add(id);
      const page = pdfDict(pdf.resolve(ref));
      const resources = page.Resources
        ? pdfDict(pdf.resolve(page.Resources))
        : inherited;
      if (pdfName(page.Type) === "Page") {
        if (pages.length >= PDF_LIMITS.pages) throw new Error("Páginas demais");
        pages.push({ page, resources });
      } else if (pdfName(page.Type) === "Pages") {
        const kids = pdf.resolve(page.Kids);
        if (!Array.isArray(kids) || !kids.length)
          throw new Error("Árvore de páginas inválida");
        for (const kid of kids) visit(kid, resources, depth + 1);
      } else throw new Error("Página inválida");
    }
    visit(pdfDict(catalogs[0].value).Pages, {}, 0);
    if (!pages.length) return null;
    const texts: string[] = [];
    let total = 0;
    for (const { page, resources } of pages) {
      let content = "";
      const active = new Set<string>();
      async function contents(v: PdfValue, depth = 0): Promise<void> {
        if (depth > 32) throw new Error("Contents profundo");
        const id = pdfRef(v);
        if (id) {
          if (active.has(id)) throw new Error("Contents cíclico");
          active.add(id);
          const resolved = pdf.resolve(v);
          if (Array.isArray(resolved)) await contents(resolved, depth + 1);
          else content += (await pdf.stream(v)) + "\n";
          active.delete(id);
        } else if (Array.isArray(v))
          for (const part of v) await contents(part, depth + 1);
        else throw new Error("Contents inválido");
        if (content.length > PDF_INFLATE_LIMITS.bytes)
          throw new Error("Contents excessivo");
      }
      await contents(page.Contents);
      const text = await contentText(pdf, content, resources);
      // Cada página precisa ter texto: uma digitalização não pode desaparecer da leitura.
      if (!text) return null;
      total += text.length + (texts.length ? 1 : 0);
      if (total > MAX_TEXT) return null;
      texts.push(text);
    }
    return texts.join("\n");
  } catch {
    return null;
  }
}

/** O motor só usa o texto se a máscara não deixou documentos válidos expostos. */
export async function extractMaskedPersonalPdf(
  bytes: Uint8Array,
  pii: PiiMask,
): Promise<string | null> {
  const text = await extractPersonalPdf(bytes);
  if (text === null) return null;
  const masked = pii.mask(text);
  return pii.enabled && hasUnmaskedDocument(masked) ? null : masked;
}
