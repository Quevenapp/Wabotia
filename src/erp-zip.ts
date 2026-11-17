// ZIP gravado aos poucos, para a exportação da empresa ir ao R2 sem o pacote
// inteiro na memória (createErpUpload em src/erp-storage.ts). O formato é o do
// createZip do Fagoo (platform.mjs: deflate-raw, nomes em UTF-8, ZIP32),
// com uma diferença: a entrada escrita em fatias (`entry`) leva o CRC e os
// tamanhos depois dos dados (descritor de dados, bit 3), porque só se sabem
// no fim. Leitores de ZIP aceitam os dois jeitos.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
/** CRC-32 contínuo: comece com 0 e passe o anterior a cada fatia. */
export function crc32(bytes: Uint8Array, previous = 0) {
  let c = ~previous >>> 0;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Para onde vão os bytes do ZIP, em ordem (ErpUpload.write). */
export type ZipSink = (bytes: Uint8Array) => Promise<void>;

interface Central {
  name: Uint8Array;
  flags: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

const UTF8 = 0x0800;
const DESCRIPTOR = 0x0008;

function fields(length: number, values: [number, number, 2 | 4][]) {
  const view = new DataView(new ArrayBuffer(length));
  for (const [at, value, size] of values)
    if (size === 4) view.setUint32(at, value >>> 0, true);
    else view.setUint16(at, value & 0xffff, true);
  return new Uint8Array(view.buffer);
}

export function createZipStream(sink: ZipSink, date = new Date()) {
  const time =
    ((date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2)) &
    0xffff;
  const day =
    (((date.getUTCFullYear() - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate()) &
    0xffff;
  const central: Central[] = [];
  let offset = 0;
  let open = false;
  const emit = async (bytes: Uint8Array) => {
    offset += bytes.length;
    await sink(bytes);
  };
  const local = (
    name: Uint8Array,
    flags: number,
    crc: number,
    compressed: number,
    size: number,
  ) =>
    fields(30, [
      [0, 0x04034b50, 4],
      [4, 20, 2],
      [6, flags, 2],
      [8, 8, 2],
      [10, time, 2],
      [12, day, 2],
      [14, crc, 4],
      [18, compressed, 4],
      [22, size, 4],
      [26, name.length, 2],
      [28, 0, 2],
    ]);
  const guard = () => {
    if (open) throw new Error("zip_entry_open");
  };

  return {
    /** Bytes do ZIP até aqui (o `size` do createZip do Fagoo). */
    get size() {
      return offset;
    },
    /** Uma entrada inteira já na memória (como o add do Fagoo). */
    async add(name: string, bytes: Uint8Array) {
      guard();
      const nameBytes = new TextEncoder().encode(name);
      const data = new Uint8Array(
        await new Response(
          new Blob([bytes as Uint8Array<ArrayBuffer>])
            .stream()
            .pipeThrough(new CompressionStream("deflate-raw")),
        ).arrayBuffer(),
      );
      const crc = crc32(bytes);
      const at = offset;
      await emit(local(nameBytes, UTF8, crc, data.length, bytes.length));
      await emit(nameBytes);
      await emit(data);
      central.push({
        name: nameBytes,
        flags: UTF8,
        crc,
        compressed: data.length,
        size: bytes.length,
        offset: at,
      });
      return data.length;
    },
    /**
     * Uma entrada escrita em fatias (um conjunto de dados página por página):
     * cada fatia é comprimida e vai para o sink sem esperar o resto.
     */
    async entry(name: string) {
      guard();
      open = true;
      const nameBytes = new TextEncoder().encode(name);
      const at = offset;
      const flags = UTF8 | DESCRIPTOR;
      await emit(local(nameBytes, flags, 0, 0, 0));
      await emit(nameBytes);
      const compressor = new CompressionStream("deflate-raw");
      const writer = compressor.writable.getWriter();
      let crc = 0;
      let size = 0;
      let compressed = 0;
      const reader = compressor.readable.getReader();
      const pump = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          compressed += value.length;
          await emit(value);
        }
      })();
      // Um erro no sink aparece no próximo write ou no close.
      pump.catch(() => {});
      return {
        async write(bytes: Uint8Array) {
          if (!bytes.length) return;
          crc = crc32(bytes, crc);
          size += bytes.length;
          await Promise.race([
            writer.write(bytes as Uint8Array<ArrayBuffer>),
            pump.then(() => {}),
          ]);
        },
        async close() {
          await writer.close();
          await pump;
          await emit(
            fields(16, [
              [0, 0x08074b50, 4],
              [4, crc, 4],
              [8, compressed, 4],
              [12, size, 4],
            ]),
          );
          central.push({
            name: nameBytes,
            flags,
            crc,
            compressed,
            size,
            offset: at,
          });
          open = false;
          return compressed;
        },
      };
    },
    /** O diretório central e o fim do ZIP. */
    async finish() {
      guard();
      const start = offset;
      for (const e of central) {
        await emit(
          fields(46, [
            [0, 0x02014b50, 4],
            [4, 20, 2],
            [6, 20, 2],
            [8, e.flags, 2],
            [10, 8, 2],
            [12, time, 2],
            [14, day, 2],
            [16, e.crc, 4],
            [20, e.compressed, 4],
            [24, e.size, 4],
            [28, e.name.length, 2],
            [42, e.offset, 4],
          ]),
        );
        await emit(e.name);
      }
      await emit(
        fields(22, [
          [0, 0x06054b50, 4],
          [8, central.length, 2],
          [10, central.length, 2],
          [12, offset - start, 4],
          [16, start, 4],
        ]),
      );
    },
  };
}
