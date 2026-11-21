// Imagem (logotipo da empresa) no PDF do servidor: o escritor do painel
// (web/erp/app/lib/pdf-writer.ts) não tem imagens, então este arquivo monta o
// mesmo PDF 1.4 com um XObject de imagem. JPEG vai como está (DCTDecode);
// PNG de 8 bits é decodificado, a transparência vira fundo branco e os pixels
// vão comprimidos (FlateDecode). Sem rede: CompressionStream do runtime.
import { MM, PdfPage } from "../../../web/erp/app/lib/pdf-writer.ts";

export interface PdfImage { width: number; height: number; colors: 1 | 3; filter: "DCTDecode" | "FlateDecode"; data: Uint8Array }

/** Página com a imagem "Im1" desenhada em (x, y) mm, com largura e altura em mm. */
export function drawImage(page: PdfPage, x: number, y: number, w: number, h: number) {
  const num = (value: number) => (Math.round(value * 100) / 100).toString();
  page.ops.push(`q ${num(w * MM)} 0 0 ${num(h * MM)} ${num(x * MM)} ${num((page.height - y - h) * MM)} cm /Im1 Do Q`);
}

function jpeg(bytes: Uint8Array): PdfImage | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!, length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    // SOF0..SOF15 (menos DHT, JPG e DAC): altura, largura e componentes.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = (bytes[i + 5]! << 8) | bytes[i + 6]!, width = (bytes[i + 7]! << 8) | bytes[i + 8]!, components = bytes[i + 9]!;
      if (!width || !height || (components !== 1 && components !== 3)) return null;
      return { width, height, colors: components as 1 | 3, filter: "DCTDecode", data: bytes };
    }
    i += 2 + length;
  }
  return null;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function png(bytes: Uint8Array): Promise<PdfImage | null> {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (signature.some((value, index) => bytes[index] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette: Uint8Array | null = null, alpha: Uint8Array | null = null;
  const parts: Uint8Array[] = [];
  while (i + 8 <= bytes.length) {
    const length = view.getUint32(i), kind = String.fromCharCode(...bytes.subarray(i + 4, i + 8)), body = bytes.subarray(i + 8, i + 8 + length);
    if (kind === "IHDR") { width = view.getUint32(i + 8); height = view.getUint32(i + 12); depth = body[8]!; type = body[9]!; interlace = body[12]!; }
    else if (kind === "PLTE") palette = body;
    else if (kind === "tRNS") alpha = body;
    else if (kind === "IDAT") parts.push(body);
    else if (kind === "IEND") break;
    i += 12 + length;
  }
  if (!width || !height || depth !== 8 || interlace !== 0 || width * height > 4_000_000 || ![0, 2, 3, 4, 6].includes(type)) return null;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type]!;
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.length; }
  const raw = await inflate(joined), stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  // Desfaz os filtros de linha do PNG (None, Sub, Up, Average, Paeth).
  const pixels = new Uint8Array(height * stride);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]!, line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    for (let k = 0; k < stride; k++) {
      const left = k >= channels ? pixels[row * stride + k - channels]! : 0, up = row ? pixels[(row - 1) * stride + k]! : 0;
      const upLeft = row && k >= channels ? pixels[(row - 1) * stride + k - channels]! : 0;
      const paeth = () => { const p = left + up - upLeft, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upLeft); return a <= b && a <= c ? left : b <= c ? up : upLeft; };
      const add = filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth() : 0;
      pixels[row * stride + k] = (line[k]! + add) & 0xff;
    }
  }
  const gray = type === 0 || type === 4, colors = gray ? 1 : 3;
  const out = new Uint8Array(width * height * colors);
  const blend = (value: number, a: number) => Math.round((value * a + 255 * (255 - a)) / 255);
  for (let p = 0; p < width * height; p++) {
    const s = p * channels;
    if (type === 3) {
      const index = pixels[s]!, a = alpha && index < alpha.length ? alpha[index]! : 255;
      if (!palette || index * 3 + 2 >= palette.length) return null;
      for (let c = 0; c < 3; c++) out[p * 3 + c] = blend(palette[index * 3 + c]!, a);
    } else if (gray) out[p] = type === 4 ? blend(pixels[s]!, pixels[s + 1]!) : pixels[s]!;
    else for (let c = 0; c < 3; c++) out[p * 3 + c] = type === 6 ? blend(pixels[s + c]!, pixels[s + 3]!) : pixels[s + c]!;
  }
  return { width, height, colors, filter: "FlateDecode", data: await deflate(out) };
}

/** JPEG ou PNG (8 bits) pronto para o PDF; outro formato ou arquivo com defeito: null. */
export async function pdfImage(bytes: Uint8Array): Promise<PdfImage | null> {
  try { return jpeg(bytes) ?? await png(bytes); } catch { return null; }
}

const FONT_NAMES = { F1: "Helvetica", F2: "Helvetica-Bold", F3: "Courier" } as const;
const latin1 = (bytes: Uint8Array) => { let out = ""; for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return out; };
const ascii = (text: string) => [...text].map(char => { const code = char.charCodeAt(0); return code < 32 || code > 126 || "()\\".includes(char) ? "?" : char; }).join("");

/** O PDF das páginas, com a imagem como recurso de todas (mesma estrutura do pdfDocument do painel). */
export function pdfDocumentWithImage(pages: readonly PdfPage[], image: PdfImage | null, { title = "Documento", producer = "Wabotia" } = {}): Uint8Array {
  const num = (value: number) => (Math.round(value * 100) / 100).toString();
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const catalog = add(""), tree = add("");
  const fonts = Object.values(FONT_NAMES).map(name => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`));
  const img = image ? add(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /${image.colors === 1 ? "DeviceGray" : "DeviceRGB"} /BitsPerComponent 8 /Filter /${image.filter} /Length ${image.data.length} >>\nstream\n${latin1(image.data)}\nendstream`) : 0;
  const resources = `<< /Font << /F1 ${fonts[0]} 0 R /F2 ${fonts[1]} 0 R /F3 ${fonts[2]} 0 R >>${img ? ` /XObject << /Im1 ${img} 0 R >>` : ""} >>`;
  const kids: number[] = [];
  for (const page of pages) {
    const content = page.ops.join("\n"), stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${num(page.width * MM)} ${num(page.height * MM)}] /Resources ${resources} /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${ascii(title)}) /Producer (${ascii(producer)}) >>`);
  // Tudo em latin1 (um caractere por byte): o comprimento do texto é o deslocamento em bytes.
  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
