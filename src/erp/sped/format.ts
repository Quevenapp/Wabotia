// Formatos dos campos dos arquivos fiscais: linha com barras verticais (SPED),
// valor com vírgula e casas fixas, data DDMMAAAA, texto limpo; registro de
// posições fixas (SINTEGRA); e o texto final em ISO-8859-1 com CR LF, como o
// validador oficial (PVA) e o validador do SINTEGRA leem.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.

/** Texto do campo: sem barra vertical, sem quebra de linha nem controle, espaços simples. */
export function clean(value: string | null | undefined, max?: number): string {
  if (value == null) return "";
  // Barra vertical separa campos; controle (inclusive quebra de linha) quebraria o registro.
  const t = String(value).replace(/\|/g, " ").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  return max ? t.slice(0, max).trim() : t;
}
export const onlyDigits = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "");

/** Centavos → "1234,56" (sem separador de milhar). */
export function money(cents: number, decimals = 2): string {
  const v = Math.round(Number(cents) || 0), neg = v < 0, a = Math.abs(v);
  const int = Math.floor(a / 100), frac = String(a % 100).padStart(2, "0");
  const out = decimals === 2 ? `${int},${frac}` : decimals === 0 ? String(Math.round(a / 100)) : `${int},${(frac + "0".repeat(decimals)).slice(0, decimals)}`;
  return neg ? `-${out}` : out;
}

/** Decimal em texto ("1.5", "12.3456789") → casas fixas com vírgula ("1,50"), arredondando metade para cima. */
export function decimal(value: string | number | null | undefined, decimals: number): string {
  const text = typeof value === "number" ? String(value) : (value ?? "0");
  const m = /^(-)?(\d+)(?:[.,](\d+))?$/.exec(text.trim());
  if (!m) return decimals ? `0,${"0".repeat(decimals)}` : "0";
  const frac = (m[3] ?? "") + "0".repeat(decimals + 1);
  let n = BigInt(m[2] + frac.slice(0, decimals));
  if (Number(frac[decimals]) >= 5) n += 1n;
  const digits = n.toString().padStart(decimals + 1, "0");
  const out = decimals ? `${digits.slice(0, -decimals)},${digits.slice(-decimals)}` : digits;
  return m[1] && n !== 0n ? `-${out}` : out;
}

/** Decimal em texto → inteiro escalado (para somar sem erro de ponto flutuante). */
export function scaled(value: string | null | undefined, decimals: number): bigint {
  const m = /^(-)?(\d+)(?:[.,](\d+))?$/.exec(String(value ?? "0").trim());
  if (!m) return 0n;
  const frac = (m[3] ?? "") + "0".repeat(decimals + 1);
  let n = BigInt(m[2] + frac.slice(0, decimals));
  if (Number(frac[decimals]) >= 5) n += 1n;
  return m[1] ? -n : n;
}
export const unscaled = (n: bigint, decimals: number): string => {
  const neg = n < 0n, digits = (neg ? -n : n).toString().padStart(decimals + 1, "0");
  return (neg ? "-" : "") + (decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits);
};

/** AAAA-MM-DD → DDMMAAAA. */
export const ddmmyyyy = (day: string | null | undefined) => day ? `${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(0, 4)}` : "";
/** AAAA-MM-DD → AAAAMMDD. */
export const yyyymmdd = (day: string | null | undefined) => day ? day.slice(0, 10).replace(/-/g, "") : "";
/** AAAA-MM-DD → MMAAAA. */
export const mmyyyy = (day: string) => `${day.slice(5, 7)}${day.slice(0, 4)}`;

/** Uma linha do SPED: |REG|campo|...|. */
export const spedLine = (fields: readonly (string | number | null | undefined)[]) => `|${fields.map((f) => f == null ? "" : String(f)).join("|")}|`;

/** Sem acento (SINTEGRA: só ASCII). */
export const ascii = (value: string | null | undefined) => (value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, " ");

/** Campo de posições fixas: N à direita com zeros; X à esquerda com brancos; D AAAAMMDD. */
export function fixedField(type: "N" | "X" | "D", size: number, value: string | number | null | undefined, decimals = 0): string {
  if (type === "N") {
    let digits: string;
    if (typeof value === "number" && decimals) digits = String(Math.round(Math.abs(value)));
    else digits = onlyDigits(value == null ? "" : String(value));
    return digits.slice(-size).padStart(size, "0");
  }
  if (type === "D") return (onlyDigits(String(value ?? "")) || "0".repeat(8)).slice(0, 8).padEnd(8, "0");
  return ascii(value == null ? "" : String(value)).replace(/\s+/g, " ").slice(0, size).padEnd(size, " ");
}

/** Texto em ISO-8859-1: o que não existe nessa tabela vira a letra sem acento ou "?". */
export function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 3);
  let n = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 256) { out[n++] = code; continue; }
    const plain = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    const map: Record<string, string> = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "...", "€": "E" };
    const sub = map[ch] ?? (plain.length && plain.codePointAt(0)! < 256 ? plain : "?");
    for (const c of sub) out[n++] = c.codePointAt(0)! & 0xff;
  }
  return out.slice(0, n);
}
/** Lê ISO-8859-1 (testes e conferência). */
export function fromLatin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}
