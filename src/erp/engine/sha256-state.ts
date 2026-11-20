// SHA-256 incremental com estado exportável: o hash de uma tabela do backup
// atravessa várias partes e várias invocações (o checkpoint durável guarda o
// estado entre uma e outra). O node:crypto não exporta o estado intermediário.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.

/** Estado durável: as oito palavras, o resto ainda sem bloco (hex) e o total de bytes. */
export interface Sha256State {
  h: number[];
  tail: string;
  length: number;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const toHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex) || hex.length > 126) throw new Error("Estado de hash inválido.");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export class Sha256 {
  private h: Uint32Array;
  private buffer = new Uint8Array(64);
  private filled = 0;
  private total = 0;
  private w = new Uint32Array(64);

  constructor(state?: Sha256State | null) {
    if (!state) { this.h = Uint32Array.from(INITIAL); return; }
    if (!Array.isArray(state.h) || state.h.length !== 8 || !Number.isSafeInteger(state.length) || state.length < 0)
      throw new Error("Estado de hash inválido.");
    this.h = Uint32Array.from(state.h);
    const tail = fromHex(state.tail);
    if (tail.length !== state.length % 64) throw new Error("Estado de hash inválido.");
    this.buffer.set(tail);
    this.filled = tail.length;
    this.total = state.length;
  }

  /** O que vai ao checkpoint. */
  state(): Sha256State {
    return { h: Array.from(this.h), tail: toHex(this.buffer.subarray(0, this.filled)), length: this.total };
  }

  update(data: Uint8Array | string): this {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.total += bytes.length;
    let offset = 0;
    if (this.filled) {
      const take = Math.min(64 - this.filled, bytes.length);
      this.buffer.set(bytes.subarray(0, take), this.filled);
      this.filled += take;
      offset = take;
      if (this.filled < 64) return this;
      this.block(this.buffer, 0);
      this.filled = 0;
    }
    for (; offset + 64 <= bytes.length; offset += 64) this.block(bytes, offset);
    if (offset < bytes.length) {
      this.buffer.set(bytes.subarray(offset), 0);
      this.filled = bytes.length - offset;
    }
    return this;
  }

  /** Hex do resumo; não altera o estado (o checkpoint pode continuar depois). */
  digest(): string {
    const copy = new Sha256(this.state());
    const bits = copy.total * 8;
    const pad = new Uint8Array(((copy.filled < 56 ? 56 : 120) - copy.filled) + 8);
    pad[0] = 0x80;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(pad.length - 4, bits >>> 0);
    copy.update(pad);
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, copy.h[i]);
    return toHex(out);
  }

  private block(bytes: Uint8Array, offset: number) {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (k + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + k) | 0;
  }
}
