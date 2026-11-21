// ZIP sem compressão (método 0), montado em partes: o mesmo formato do pacote
// do contador do Bling (src/erp/bling/cutover-package.ts). Cada parte é uma
// sequência de "cabeçalho local + arquivo"; o fecho grava o índice, o
// diretório central e o fim do diretório. Juntas na ordem, as partes formam
// um ZIP que qualquer computador abre. Sem dependência nova.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.

const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Arquivo já gravado numa parte: nome, conferência, tamanho e onde começa no ZIP. */
export interface ZipEntry { name: string; crc: number; size: number; offset: number; date: string }

/** Limites do formato sem ZIP64. */
export const ZIP_MAX_ENTRIES = 65_000;
export const ZIP_MAX_BYTES = 0xffff_0000;

function dosDate(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return (0 << 9) | (1 << 5) | 1;
  return ((Math.min(2107, Math.max(1980, y)) - 1980) << 9) | (m << 5) | d;
}

export function localHeader(entry: ZipEntry): Uint8Array {
  const name = encoder.encode(entry.name), out = new Uint8Array(30 + name.length), v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
  v.setUint16(10, 0, true); v.setUint16(12, dosDate(entry.date), true); v.setUint32(14, entry.crc, true);
  v.setUint32(18, entry.size, true); v.setUint32(22, entry.size, true); v.setUint16(26, name.length, true); v.setUint16(28, 0, true);
  out.set(name, 30);
  return out;
}

export function centralHeader(entry: ZipEntry): Uint8Array {
  const name = encoder.encode(entry.name), out = new Uint8Array(46 + name.length), v = new DataView(out.buffer);
  v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0x0800, true); v.setUint16(10, 0, true);
  v.setUint16(12, 0, true); v.setUint16(14, dosDate(entry.date), true); v.setUint32(16, entry.crc, true); v.setUint32(20, entry.size, true);
  v.setUint32(24, entry.size, true); v.setUint16(28, name.length, true); v.setUint32(42, entry.offset, true);
  out.set(name, 46);
  return out;
}

export function endOfDirectory(count: number, size: number, offset: number): Uint8Array {
  const out = new Uint8Array(22), v = new DataView(out.buffer);
  v.setUint32(0, 0x06054b50, true); v.setUint16(8, count, true); v.setUint16(10, count, true); v.setUint32(12, size, true); v.setUint32(16, offset, true);
  return out;
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/** Uma parte em montagem: acrescenta arquivos a partir do deslocamento atual do ZIP. */
export class ZipPart {
  readonly entries: ZipEntry[] = [];
  private readonly chunks: Uint8Array[] = [];
  private readonly names: Set<string>;
  offset: number;
  size = 0;
  constructor(offset: number, usedNames: Iterable<string> = []) { this.offset = offset; this.names = new Set(usedNames); }
  /** Grava o arquivo e devolve o nome usado (outro, se o nome já existe no pacote). */
  add(name: string, bytes: Uint8Array, date: string): string {
    let unique = name, n = 2;
    while (this.names.has(unique)) unique = name.replace(/(\.[A-Za-z0-9]+)?$/, (ext) => `-${n++}${ext}`);
    this.names.add(unique);
    const entry: ZipEntry = { name: unique, crc: crc32(bytes), size: bytes.length, offset: this.offset, date };
    const header = localHeader(entry);
    this.chunks.push(header, bytes);
    this.entries.push(entry);
    this.offset += header.length + bytes.length;
    this.size += header.length + bytes.length;
    return unique;
  }
  bytes(): Uint8Array { return concat(this.chunks); }
}

/** O fecho: um último arquivo (o índice), o diretório central de tudo e o fim do diretório. */
export function zipClosing(previous: readonly ZipEntry[], offset: number, last: { name: string; bytes: Uint8Array; date: string }): { bytes: Uint8Array; entries: number } {
  const index: ZipEntry = { name: last.name, crc: crc32(last.bytes), size: last.bytes.length, offset, date: last.date };
  const header = localHeader(index);
  const all = [...previous, index];
  const directory = concat(all.map(centralHeader));
  const directoryOffset = offset + header.length + last.bytes.length;
  return { bytes: concat([header, last.bytes, directory, endOfDirectory(all.length, directory.length, directoryOffset)]), entries: all.length };
}

/** Lê os nomes e o conteúdo de um ZIP sem compressão (testes e conferência). */
export function readStoredZip(bytes: Uint8Array): { name: string; data: Uint8Array }[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= 0; i--) if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("ZIP sem fim de diretório");
  const count = v.getUint16(end + 10, true), dirOffset = v.getUint32(end + 16, true);
  const out: { name: string; data: Uint8Array }[] = [];
  let at = dirOffset;
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error("diretório inválido");
    const size = v.getUint32(at + 20, true), nameLength = v.getUint16(at + 28, true), local = v.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (v.getUint32(local, true) !== 0x04034b50) throw new Error("cabeçalho local inválido: " + name);
    const localName = v.getUint16(local + 26, true), extra = v.getUint16(local + 28, true);
    const start = local + 30 + localName + extra;
    const data = bytes.subarray(start, start + size);
    if (crc32(data) !== v.getUint32(at + 16, true)) throw new Error("CRC não confere: " + name);
    out.push({ name, data });
    at += 46 + nameLength;
  }
  return out;
}
