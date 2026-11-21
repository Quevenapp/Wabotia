// Conciliação (contas puras, sem banco): leitura do OFX e das planilhas do
// banco e da adquirente, o modelo de colunas (mapeamento), o identificador
// estável da linha sem FITID, bandeira e modalidade do cartão, a taxa
// contratada e as notas de confiança das sugestões. Só sintaxe TypeScript
// apagável: os testes do Node e a tela importam este arquivo.

/** Arquivo recusado: o código vai para a rota, que diz o que fazer. */
export class ReconciliationFileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
const fail = (code: string, message: string): never => {
  throw new ReconciliationFileError(code, message);
};

export const FILE_MAX_CHARS = 2 * 1024 * 1024;
export const FILE_MAX_LINES = 5000;
export const CARD_MAX_LINES = 20000;

// ---------------------------------------------------------------------------
// Texto, datas e valores

/** Minúsculas, sem acento, espaços simples (para comparar nomes e descrições). */
export function plain(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const validDay = (y: number, m: number, d: number) => {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === iso ? iso : null;
};

export type DateFormat = "dmy" | "ymd" | "mdy";
/** "21/11/2026", "21-11-26", "2026-11-21", "20261121", "21/11/2026 10:32" → "2026-11-21" (ou null). */
export function parseDay(value: unknown, format: DateFormat = "dmy"): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(text);
  if (m) return validDay(+m[1], +m[2], +m[3]);
  m = /^(\d{4})(\d{2})(\d{2})(?:\d{6})?(?:\.\d+)?(?:\[.*\])?$/.exec(text);
  if (m) return validDay(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:[ T].*)?$/.exec(text);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return format === "mdy" ? validDay(year, +m[1], +m[2]) : validDay(year, +m[2], +m[1]);
  }
  return null;
}

/**
 * Valor em centavos exatos (BigInt), sem ponto flutuante: "R$ -1.234,56",
 * "1234.56", "(12,00)", "12,00 D", "12,00-". decimal "auto" decide pela
 * última vírgula ou ponto. null se não for um valor.
 */
export function parseCents(value: unknown, decimal: "," | "." | "auto" = "auto"): bigint | null {
  let text = String(value ?? "").trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  const suffix = /\s*([CD])$/i.exec(text);
  if (suffix) { if (suffix[1].toUpperCase() === "D") negative = true; text = text.slice(0, suffix.index); }
  text = text.replace(/R\$|BRL/gi, "").replace(/\s+/g, "");
  if (text.endsWith("-")) { negative = !negative; text = text.slice(0, -1); }
  if (text.startsWith("-")) { negative = !negative; text = text.slice(1); }
  else if (text.startsWith("+")) text = text.slice(1);
  if (!/^[0-9.,]+$/.test(text) || !/[0-9]/.test(text)) return null;
  let sep = decimal;
  if (sep === "auto") {
    const lastComma = text.lastIndexOf(","), lastDot = text.lastIndexOf(".");
    if (lastComma < 0 && lastDot < 0) sep = ",";
    else if (lastComma > lastDot) sep = ",";
    else {
      // Só ponto: "1.234" (milhar, como no Brasil) ou "12.34" (decimal)? Três dígitos depois do ponto = milhar.
      const after = text.length - lastDot - 1;
      sep = after === 3 ? "," : ".";
    }
  }
  const thousands = sep === "," ? "." : ",";
  const cleaned = text.split(thousands).join("");
  const parts = cleaned.split(sep);
  if (parts.length > 2) return null;
  const [whole, fraction = ""] = parts;
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction) || (!whole && !fraction)) return null;
  if (fraction.length > 2 && /[1-9]/.test(fraction.slice(2))) return null;
  const cents = BigInt(whole || "0") * 100n + BigInt((fraction.slice(0, 2) || "0").padEnd(2, "0"));
  if (cents > 999999999999999n) return null;
  return negative && cents !== 0n ? -cents : cents;
}

/** Percentual "1,99%", "1.99" ou "0,0199" (fração) → centésimos de ponto percentual (199). */
export function parseRateBp(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  const percent = raw.includes("%");
  const text = raw.replace("%", "").trim();
  if (!text || !/^[0-9.,]+$/.test(text)) return null;
  const n = Number(text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text);
  if (!Number.isFinite(n) || n < 0) return null;
  // Sem "%" e abaixo de 0,1: veio como fração (0,0199 = 1,99%).
  const pct = !percent && n < 0.1 ? n * 100 : n;
  const bp = Math.round(pct * 100);
  return bp > 10000 ? null : bp;
}

/** Centavos com vírgula: 123456 → "1.234,56". */
export function brl(cents: bigint | number | string): string {
  const v = BigInt(cents);
  const abs = v < 0n ? -v : v;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${v < 0n ? "-" : ""}${whole},${(abs % 100n).toString().padStart(2, "0")}`;
}

export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const dayDiff = (a: string, b: string) => Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

// ---------------------------------------------------------------------------
// OFX

export interface BankLine {
  fitid: string;
  posted_on: string;
  /** Centavos com sinal, em texto (entrada positiva, saída negativa). */
  amount_cents: string;
  memo: string | null;
  trntype: string | null;
}
export interface BankFile {
  period_from: string;
  period_to: string;
  lines: BankLine[];
  /** Saldo do banco no fim de cada dia (o que o arquivo permite saber). */
  balances: { day: string; balance_cents: string }[];
  bank_id: string | null;
  account: string | null;
}

const decodeEntities = (value: string) =>
  value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_m, code: string) =>
    code[0] === "#" ? String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1)))
      : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[code.toLowerCase()]);
function leaf(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block);
  if (!match) return null;
  const value = decodeEntities(match[1]).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return value || null;
}

/** O OFX usa ponto decimal; alguns bancos brasileiros mandam vírgula (sem ponto). */
const ofxDecimal = (v: string | null) => (v && v.includes(",") && !v.includes(".") ? "," : ".");

/** Identificador da linha sem FITID: data, valor e descrição, numerados no arquivo (o mesmo arquivo de novo acha os mesmos). */
export function syntheticFitid(posted: string, amount: string, memo: string | null, seen: Map<string, number>): string {
  const key = `${posted}|${amount}|${plain(memo).slice(0, 120)}`;
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  return `sem-id:${key}|${n}`.slice(0, 255);
}

/** Extrato OFX (SGML 1.x ou XML 2.x): lançamentos, período e saldo final (LEDGERBAL). */
export function parseOfx(text: string): BankFile {
  if (typeof text !== "string" || !text.trim()) fail("file_empty", "O arquivo está vazio.");
  if (text.length > FILE_MAX_CHARS) fail("file_too_large", "O arquivo passa de 2 MB. Exporte um período menor no banco.");
  const start = /<OFX>/i.exec(text);
  if (!start) fail("ofx_invalid", "O arquivo não parece um extrato OFX. Exporte de novo no banco escolhendo OFX (ou use a planilha).");
  const ofx = text.slice(start!.index);
  const blocks = [...ofx.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi)].map((m) => m[1]);
  if (blocks.length > FILE_MAX_LINES) fail("file_too_many", `O extrato tem mais de ${FILE_MAX_LINES} lançamentos. Exporte um período menor.`);
  const seen = new Map<string, number>(), ids = new Set<string>();
  const lines: BankLine[] = [];
  blocks.forEach((block, index) => {
    const posted = parseDay(leaf(block, "DTPOSTED"), "ymd") ?? fail("ofx_date", `Data inválida no lançamento ${index + 1} do OFX.`);
    const amount = parseCents(leaf(block, "TRNAMT"), ofxDecimal(leaf(block, "TRNAMT"))) ?? fail("ofx_amount", `Valor inválido no lançamento ${index + 1} do OFX.`);
    if (amount === 0n) return;
    const memo = (leaf(block, "MEMO") ?? leaf(block, "NAME"))?.slice(0, 255) ?? null;
    const trntype = leaf(block, "TRNTYPE")?.toUpperCase() ?? null;
    let fitid = leaf(block, "FITID");
    if (!fitid || fitid.length > 255) fitid = syntheticFitid(posted, amount.toString(), memo, seen);
    // FITID repetido no mesmo arquivo (alguns bancos repetem): a segunda vira identificador próprio.
    if (ids.has(fitid)) fitid = syntheticFitid(posted, amount.toString(), memo, seen);
    ids.add(fitid);
    lines.push({ fitid, posted_on: posted, amount_cents: amount.toString(), memo, trntype: trntype && /^[A-Z]{1,20}$/.test(trntype) ? trntype : null });
  });
  const days = lines.map((l) => l.posted_on).sort();
  const dtStart = parseDay(leaf(ofx, "DTSTART"), "ymd"), dtEnd = parseDay(leaf(ofx, "DTEND"), "ymd");
  const first: string | undefined = dtStart ?? days[0], last: string | undefined = dtEnd ?? days.at(-1);
  if (!first || !last) fail("file_no_lines", "O extrato não tem lançamentos nem período.");
  const [from, to] = first! <= last! ? [first!, last!] : [last!, first!];
  const ledgerBlock = /<LEDGERBAL>([\s\S]*?)(?:<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|$)/i.exec(ofx)?.[1] ?? "";
  const ledger = parseCents(leaf(ledgerBlock, "BALAMT"), ofxDecimal(leaf(ledgerBlock, "BALAMT")));
  const asOf = parseDay(leaf(ledgerBlock, "DTASOF"), "ymd") ?? to!;
  const balances = ledger === null ? [] : balancesFromEnd(lines, ledger, asOf);
  return { period_from: from!, period_to: to!, lines, balances, bank_id: leaf(ofx, "BANKID"), account: leaf(ofx, "ACCTID") };
}

/** Saldo do fim de cada dia com lançamento, a partir do saldo final informado na data dele. */
export function balancesFromEnd(lines: readonly BankLine[], end: bigint, asOf: string): { day: string; balance_cents: string }[] {
  const byDay = new Map<string, bigint>();
  for (const l of lines) byDay.set(l.posted_on, (byDay.get(l.posted_on) ?? 0n) + BigInt(l.amount_cents));
  const days = [...new Set([...byDay.keys(), asOf])].filter((d) => d <= asOf).sort().reverse();
  const out: { day: string; balance_cents: string }[] = [];
  let balance = end;
  for (const day of days) {
    out.push({ day, balance_cents: balance.toString() });
    balance -= byDay.get(day) ?? 0n;
  }
  return out.reverse();
}

// ---------------------------------------------------------------------------
// Planilha (CSV)

/** Separador mais provável na primeira linha com conteúdo: ponto e vírgula, tabulação ou vírgula. */
export function detectSeparator(text: string): ";" | "," | "\t" {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10).join("\n");
  const count = (c: string) => sample.split(c).length - 1;
  const best = ([";", "\t", ","] as const).map((c) => [c, count(c)] as const).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ";";
}

/** Linhas e células do CSV (aspas, aspas dobradas, quebras dentro das aspas). Sem linhas vazias. */
export function parseCsv(text: string, separator?: string): string[][] {
  if (typeof text !== "string" || !text.trim()) fail("file_empty", "O arquivo está vazio.");
  if (text.length > FILE_MAX_CHARS) fail("file_too_large", "O arquivo passa de 2 MB. Exporte um período menor.");
  const sep = separator ?? detectSeparator(text);
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const body = text.replace(/^﻿/, "");
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"') {
        if (body[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell.trim() === "") { quoted = true; cell = ""; }
    else if (c === sep) { row.push(cell.trim()); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(cell.trim()); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell.trim());
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

export const BANK_FIELDS = ["date", "description", "amount", "credit", "debit", "balance", "id", "type"] as const;
export type BankField = (typeof BANK_FIELDS)[number];
export const CARD_FIELDS = ["sold_on", "expected_on", "brand", "product", "installment", "installments", "gross", "fee", "net", "rate", "nsu", "authorization", "description"] as const;
export type CardField = (typeof CARD_FIELDS)[number];

/** Nomes de coluna que os bancos e as adquirentes mais usam (sem acento, minúsculas). */
const ALIASES: Record<BankField | CardField, readonly string[]> = {
  date: ["data", "data lancamento", "data do lancamento", "data movimento", "data do movimento", "dt lancamento", "dt movimento", "data mov", "dt mov", "date"],
  description: ["descricao", "historico", "lancamento", "descricao do lancamento", "memo", "detalhes", "complemento", "estabelecimento", "observacao"],
  amount: ["valor", "valor r", "valor rs", "montante", "valor do lancamento", "amount"],
  credit: ["credito", "entrada", "entradas", "valor credito", "creditos"],
  debit: ["debito", "saida", "saidas", "valor debito", "debitos"],
  balance: ["saldo", "saldo r", "saldo rs", "saldo do dia", "saldo final"],
  id: ["documento", "n documento", "numero documento", "id", "identificador", "fitid", "doc"],
  type: ["tipo", "natureza", "c d", "d c"],
  sold_on: ["data da venda", "data venda", "data de venda", "data da transacao", "data transacao", "data de autorizacao", "data autorizacao", "data"],
  expected_on: ["data de pagamento", "data pagamento", "data prevista", "previsao de pagamento", "data prevista de pagamento", "data do credito", "data de credito",
    "data do recebimento", "data de recebimento", "vencimento", "data de vencimento"],
  brand: ["bandeira", "bandeira cartao", "bandeira do cartao", "brand"],
  product: ["produto", "modalidade", "tipo de transacao", "tipo transacao", "forma de pagamento", "tipo de venda", "meio de pagamento", "tipo"],
  installment: ["parcela", "n parcela", "numero da parcela", "parcela atual"],
  installments: ["quantidade de parcelas", "qtd parcelas", "qtde parcelas", "total de parcelas", "parcelas", "plano", "numero de parcelas"],
  gross: ["valor bruto", "valor da venda", "valor venda", "valor original", "valor da transacao", "valor transacao", "valor bruto da parcela", "bruto", "valor"],
  fee: ["valor da taxa", "taxa r", "valor taxa", "taxa", "tarifa", "valor descontado", "desconto", "mdr", "valor mdr", "taxas"],
  net: ["valor liquido", "liquido", "valor liquido da parcela", "valor a receber", "valor recebido"],
  rate: ["taxa", "taxa mdr", "mdr", "percentual", "taxa aplicada"],
  nsu: ["nsu", "nsu doc", "cv nsu", "nsu cv", "numero nsu", "nsu host", "codigo da transacao", "id da transacao", "stone id", "doc"],
  authorization: ["codigo de autorizacao", "cod autorizacao", "autorizacao", "codigo autorizacao", "numero da autorizacao", "auth"],
};

/** Modelos prontos das adquirentes mais comuns: os mesmos sinônimos, com o nome pronto (a pessoa confere a prévia antes de importar). */
export const ACQUIRERS: Readonly<Record<string, string>> = Object.freeze({
  cielo: "Cielo", rede: "Rede", stone: "Stone", getnet: "Getnet", pagseguro: "PagBank (PagSeguro)", mercadopago: "Mercado Pago",
  safrapay: "SafraPay", sumup: "SumUp", infinitepay: "InfinitePay", ton: "Ton", outra: "Outra adquirente",
});

/** Modelo de colunas salvo: o nome do cabeçalho (ou "#3" para a 3ª coluna) de cada campo, e as opções da leitura. */
export interface Mapping {
  columns: Partial<Record<string, string>>;
  separator?: ";" | "," | "\t";
  decimal?: "," | "." | "auto";
  date_format?: DateFormat;
  /** Saída positiva no arquivo (alguns bancos invertem o sinal). */
  invert?: boolean;
}

const sameHeader = (a: string, b: string) => plain(a) === plain(b);

/** Linha de cabeçalho (até a 20ª) e o índice de cada campo, pelo modelo ou pelos sinônimos. */
export function locateColumns(rows: string[][], fields: readonly string[], mapping?: Mapping): { header: number; index: Partial<Record<string, number>> } {
  const wanted = mapping?.columns ?? {};
  let best = { header: -1, index: {} as Partial<Record<string, number>>, score: 0 };
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const row = rows[r];
    const index: Partial<Record<string, number>> = {};
    const used = new Set<number>();
    let score = 0;
    for (const field of fields) {
      const chosen = wanted[field];
      if (chosen) {
        const position = /^#\d+$/.test(chosen) ? Number(chosen.slice(1)) - 1 : row.findIndex((cell) => sameHeader(cell, chosen));
        if (position >= 0 && position < Math.max(row.length, 1) + 50) { index[field] = position; used.add(position); score += 3; }
      }
    }
    for (const field of fields) {
      if (index[field] !== undefined || wanted[field]) continue;
      const aliases = ALIASES[field as BankField | CardField] ?? [];
      // O sinônimo mais específico primeiro: "valor liquido" não é "valor".
      const position = aliases.map((alias) => row.findIndex((cell, i) => !used.has(i) && plain(cell) === alias)).find((i) => i >= 0);
      if (position !== undefined) { index[field] = position; used.add(position); score += 1; }
    }
    if (score > best.score) best = { header: r, index, score };
  }
  return { header: best.header, index: best.index };
}

const cellAt = (row: string[], index: number | undefined) => (index === undefined ? "" : (row[index] ?? "").trim());

/** Extrato do banco em planilha: lançamentos (com FITID do arquivo ou estável) e o saldo por dia quando há coluna de saldo. */
export function parseBankCsv(text: string, mapping?: Mapping): BankFile & { header: string[]; mapped: Partial<Record<string, number>> } {
  const rows = parseCsv(text, mapping?.separator);
  const { header, index } = locateColumns(rows, BANK_FIELDS, mapping);
  if (header < 0 || index.date === undefined || (index.amount === undefined && index.credit === undefined && index.debit === undefined))
    fail("csv_columns", "Não achei as colunas de data e valor na planilha. Diga qual coluna é a data e qual é o valor (ou crédito e débito) e importe de novo.");
  const decimal = mapping?.decimal ?? "auto", format = mapping?.date_format ?? "dmy";
  const seen = new Map<string, number>(), ids = new Set<string>();
  const lines: BankLine[] = [];
  const balanceRows: { day: string; balance: bigint; order: number }[] = [];
  const data = rows.slice(header + 1);
  if (data.length > FILE_MAX_LINES * 2) fail("file_too_many", `A planilha tem mais de ${FILE_MAX_LINES} lançamentos. Exporte um período menor.`);
  data.forEach((row, n) => {
    const posted = parseDay(cellAt(row, index.date), format);
    // Linhas de saldo anterior, totais e rodapés não têm data válida: ficam de fora.
    if (!posted) return;
    const description = cellAt(row, index.description) || null;
    if (/^saldo\b/.test(plain(description)) && index.amount !== undefined && index.balance === undefined && !cellAt(row, index.credit) && !cellAt(row, index.debit)) {
      // "SALDO ANTERIOR" / "SALDO DO DIA" na coluna de valor: é saldo, não lançamento.
      const balance = parseCents(cellAt(row, index.amount), decimal);
      if (balance !== null) balanceRows.push({ day: posted, balance, order: n });
      return;
    }
    let amount: bigint | null = null;
    if (index.amount !== undefined && cellAt(row, index.amount)) amount = parseCents(cellAt(row, index.amount), decimal);
    else {
      const credit = parseCents(cellAt(row, index.credit), decimal), debit = parseCents(cellAt(row, index.debit), decimal);
      if (credit !== null || debit !== null) amount = (credit === null ? 0n : credit < 0n ? -credit : credit) - (debit === null ? 0n : debit < 0n ? -debit : debit);
    }
    const type = plain(cellAt(row, index.type));
    if (amount !== null && amount > 0n && (type === "d" || type.startsWith("debito") || type === "saida")) amount = -amount;
    if (amount !== null && mapping?.invert) amount = -amount;
    if (index.balance !== undefined) {
      const balance = parseCents(cellAt(row, index.balance), decimal);
      if (balance !== null) balanceRows.push({ day: posted, balance, order: n });
    }
    if (amount === null || amount === 0n) return;
    const memo = description ? description.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 255) : null;
    let fitid = cellAt(row, index.id);
    fitid = fitid && fitid.length <= 200 && !/[\u0000-\u001f\u007f]/.test(fitid) ? `doc:${posted}|${fitid}|${amount}` : "";
    if (!fitid || ids.has(fitid)) fitid = syntheticFitid(posted, amount.toString(), memo, seen);
    ids.add(fitid);
    lines.push({ fitid, posted_on: posted, amount_cents: amount.toString(), memo, trntype: amount > 0n ? "CREDIT" : "DEBIT" });
  });
  if (lines.length > FILE_MAX_LINES) fail("file_too_many", `A planilha tem mais de ${FILE_MAX_LINES} lançamentos. Exporte um período menor.`);
  if (!lines.length) fail("file_no_lines", "Não achei lançamentos com data e valor na planilha. Confira o modelo de colunas.");
  const days = lines.map((l) => l.posted_on).sort();
  // Saldo do fim do dia: a linha mais recente de cada dia na ordem do arquivo (crescente ou decrescente).
  const descending = lines.length > 1 && lines[0].posted_on > lines[lines.length - 1].posted_on;
  const byDay = new Map<string, { balance: bigint; order: number }>();
  for (const b of balanceRows) {
    const old = byDay.get(b.day);
    if (!old || (descending ? b.order < old.order : b.order > old.order)) byDay.set(b.day, b);
  }
  const balances = [...byDay].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, b]) => ({ day, balance_cents: b.balance.toString() }));
  return { period_from: days[0], period_to: days.at(-1)!, lines, balances, bank_id: null, account: null, header: rows[header], mapped: index };
}

// ---------------------------------------------------------------------------
// Cartão

export const BRANDS = ["visa", "mastercard", "elo", "amex", "hipercard", "diners", "cabal", "outros"] as const;
export type Brand = (typeof BRANDS)[number];
export const BRAND_LABEL: Readonly<Record<Brand, string>> = Object.freeze({
  visa: "Visa", mastercard: "Mastercard", elo: "Elo", amex: "American Express", hipercard: "Hipercard", diners: "Diners", cabal: "Cabal", outros: "Outras",
});
/** Código da bandeira na forma de pagamento (tBand da NF-e) → bandeira. */
export const BRAND_BY_CODE: Readonly<Record<string, Brand>> = Object.freeze({
  "01": "visa", "02": "mastercard", "03": "amex", "05": "diners", "06": "elo", "07": "hipercard", "09": "cabal",
});
export function normalizeBrand(value: unknown): Brand {
  const t = plain(value);
  if (/visa/.test(t)) return "visa";
  if (/master|maestro/.test(t)) return "mastercard";
  if (/\belo\b/.test(t)) return "elo";
  if (/amex|american/.test(t)) return "amex";
  if (/hiper/.test(t)) return "hipercard";
  if (/diners/.test(t)) return "diners";
  if (/cabal/.test(t)) return "cabal";
  return "outros";
}
export type CardProduct = "debit" | "credit";
/** Débito (e pré-pago) ou crédito; sem a informação, crédito. */
export function normalizeProduct(value: unknown): CardProduct {
  const t = plain(value);
  if (/debito|debit|maestro|electron|pre pago|prepago/.test(t)) return "debit";
  return "credit";
}
/** "2/6", "2 de 6", "02" → [parcela, total]. */
export function parseInstallment(value: unknown, total?: unknown): [number, number] {
  const t = String(value ?? "").trim();
  const m = /^(\d{1,2})\s*(?:\/|de|of)\s*(\d{1,2})$/i.exec(t);
  const totalN = Number(String(total ?? "").replace(/\D/g, "")) || 0;
  if (m) {
    const a = Math.max(1, Number(m[1])), b = Math.max(a, Number(m[2]));
    return [Math.min(a, 99), Math.min(b, 99)];
  }
  const a = Number(t.replace(/\D/g, "")) || 1;
  const b = Math.max(a, totalN || (/a vista|avista/.test(plain(t)) ? 1 : a));
  return [Math.min(Math.max(a, 1), 99), Math.min(Math.max(b, 1), 99)];
}

export interface CardLine {
  kind: "sale" | "receivable";
  sold_on: string | null;
  expected_on: string | null;
  brand: Brand;
  product: CardProduct;
  installment: number;
  installments: number;
  gross_cents: string;
  fee_cents: string;
  net_cents: string;
  nsu: string | null;
  authorization: string | null;
  description: string | null;
}

const ident = (v: string) => {
  const t = v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return t && t.length <= 40 ? t : null;
};

/** Extrato da adquirente em planilha: vendas (kind sales) ou recebíveis/pagamentos (receivables). */
export function parseCardCsv(text: string, kind: "sales" | "receivables", mapping?: Mapping): { lines: CardLine[]; header: string[]; mapped: Partial<Record<string, number>>; skipped: number } {
  const rows = parseCsv(text, mapping?.separator);
  const { header, index } = locateColumns(rows, CARD_FIELDS, mapping);
  const dateCol = kind === "sales" ? index.sold_on : index.expected_on ?? index.sold_on;
  if (header < 0 || dateCol === undefined || (index.gross === undefined && index.net === undefined))
    fail("csv_columns", kind === "sales"
      ? "Não achei as colunas de data da venda e valor bruto. Diga qual coluna é cada uma e importe de novo."
      : "Não achei as colunas de data de pagamento e valor. Diga qual coluna é cada uma e importe de novo.");
  const decimal = mapping?.decimal ?? "auto", format = mapping?.date_format ?? "dmy";
  const lines: CardLine[] = [];
  let skipped = 0;
  for (const row of rows.slice(header + 1)) {
    const sold = parseDay(cellAt(row, index.sold_on), format);
    const expected = parseDay(cellAt(row, index.expected_on), format);
    if ((kind === "sales" && !sold) || (kind === "receivables" && !expected && !sold)) { skipped++; continue; }
    let gross = parseCents(cellAt(row, index.gross), decimal);
    // "Taxa" em percentual ("1,99%") é a taxa aplicada, não o valor descontado.
    const feeText = cellAt(row, index.fee);
    let fee = feeText.includes("%") ? null : parseCents(feeText, decimal);
    let net = parseCents(cellAt(row, index.net), decimal);
    const rate = parseRateBp(cellAt(row, index.rate)) ?? (feeText.includes("%") ? parseRateBp(feeText) : null);
    if (gross !== null && gross < 0n) gross = -gross;
    if (fee !== null && fee < 0n) fee = -fee;
    if (net !== null && net < 0n) net = -net;
    if (gross === null && net !== null && fee !== null) gross = net + fee;
    if (gross === null || gross === 0n) { skipped++; continue; }
    if (fee === null && net !== null) fee = gross - net;
    if (fee === null && rate !== null) fee = (gross * BigInt(rate) + 5000n) / 10000n;
    if (fee === null) fee = 0n;
    if (fee > gross) { skipped++; continue; }
    net = gross - fee;
    const [installment, installments] = parseInstallment(cellAt(row, index.installment) || (kind === "sales" ? "1" : ""), cellAt(row, index.installments));
    const productText = cellAt(row, index.product);
    lines.push({
      kind: kind === "sales" ? "sale" : "receivable",
      sold_on: sold, expected_on: kind === "sales" ? expected : expected ?? sold,
      brand: normalizeBrand(cellAt(row, index.brand) || productText), product: normalizeProduct(productText),
      installment: kind === "sales" ? 1 : installment, installments: kind === "sales" ? Math.max(installment, installments) : installments,
      gross_cents: gross.toString(), fee_cents: fee.toString(), net_cents: net.toString(),
      nsu: ident(cellAt(row, index.nsu)), authorization: ident(cellAt(row, index.authorization)),
      description: cellAt(row, index.description).slice(0, 200) || null,
    });
  }
  if (lines.length > CARD_MAX_LINES) fail("file_too_many", `O arquivo tem mais de ${CARD_MAX_LINES} linhas. Exporte um período menor.`);
  if (!lines.length) fail("file_no_lines", "Não achei vendas com data e valor no arquivo. Confira o modelo de colunas.");
  return { lines, header: rows[header], mapped: index, skipped };
}

/** Identidade da linha da adquirente (a mesma linha em outro arquivo não duplica): NSU ou autorização, senão os dados da linha numerados. */
export function cardDedupSource(line: CardLine, seen: Map<string, number>): string {
  const base = [line.kind, line.sold_on ?? "", line.expected_on ?? "", line.brand, line.installment, line.installments, line.gross_cents].join("|");
  if (line.nsu || line.authorization) return `${base}|${line.nsu ?? ""}|${line.authorization ?? ""}`;
  const key = `${base}|${line.net_cents}|${plain(line.description)}`;
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  return `${key}|#${n}`;
}

/** Taxa esperada em centavos: percentual (centésimos de ponto) mais o valor fixo, arredondada. */
export const expectedFee = (gross: bigint, rateBp: number, fixed: number) => (gross * BigInt(rateBp) + 5000n) / 10000n + BigInt(fixed);
/** Taxa cobrada em centésimos de ponto percentual. */
export const chargedRateBp = (gross: bigint, fee: bigint) => (gross === 0n ? 0 : Number((fee * 10000n * 10n / gross + 5n) / 10n));

export interface RateRow { acquirer: string; brand: string; product: string; installments_from: number; installments_to: number; rate_bp: number; fixed_cents: number; settle_days: number }
/** A taxa contratada que vale para a linha: a da adquirente, bandeira e modalidade com o número de parcelas na faixa (a bandeira "outros" vale para todas). */
export function rateFor<T extends RateRow>(rates: readonly T[], acquirer: string, brand: string, product: string, installments: number): T | null {
  const fits = rates.filter((r) => r.acquirer === acquirer && r.product === product && installments >= r.installments_from && installments <= r.installments_to);
  return fits.find((r) => r.brand === brand) ?? fits.find((r) => r.brand === "outros") ?? null;
}

// ---------------------------------------------------------------------------
// Confiança das sugestões (0 a 100)

/** Quanto do nome aparece na descrição do extrato (palavras de 3 letras ou mais). 0 a 1. */
export function nameMatch(memo: unknown, name: unknown): number {
  const words = plain(name).split(" ").filter((w) => w.length >= 3 && !["ltda", "eireli", "s a", "me", "epp", "comercio", "servicos"].includes(w));
  if (!words.length) return 0;
  const text = ` ${plain(memo)} `;
  const hits = words.filter((w) => text.includes(` ${w} `) || (w.length >= 5 && text.includes(w.slice(0, 5)))).length;
  return hits / words.length;
}

/** Lançamento já existente (baixa, transferência ou registro de caixa) de mesmo valor. */
export function movementScore(days: number, nameRatio: number): number {
  const base = 70 + (days === 0 ? 20 : days === 1 ? 12 : days <= 3 ? 6 : 0);
  return Math.min(99, Math.round(base + nameRatio * 9));
}

/** Conta em aberto: saldo igual ao valor, vencimento perto e o nome do pagador na descrição. */
export function titleScore(amountEqual: boolean, days: number, nameRatio: number): number {
  if (!amountEqual) return 0;
  const due = days === 0 ? 20 : days <= 2 ? 15 : days <= 5 ? 10 : days <= 15 ? 4 : 0;
  return Math.min(97, Math.round(55 + due + nameRatio * 22));
}

/** Regra da pessoa: o texto dela aparece na descrição do extrato. */
export function ruleMatches(memo: unknown, pattern: string): boolean {
  const p = plain(pattern);
  return !!p && plain(memo).includes(p);
}

/** Linha da adquirente x conta a receber (venda do PDV ou do pedido). */
export function cardScore(input: {
  amountEqual: boolean; amountNear: boolean; days: number | null; brandKnown: boolean; brandEqual: boolean; installmentsEqual: boolean;
  installmentEqual: boolean | null; productEqual: boolean | null; referenceEqual: boolean;
}): number {
  if (!input.amountEqual && !input.amountNear && !input.referenceEqual) return 0;
  let s = input.amountEqual ? 45 : input.amountNear ? 35 : 10;
  if (input.days !== null) s += input.days === 0 ? 25 : input.days === 1 ? 15 : input.days <= 3 ? 5 : -20;
  if (input.brandKnown) s += input.brandEqual ? 10 : -20;
  s += input.installmentsEqual ? 10 : -30;
  if (input.installmentEqual !== null) s += input.installmentEqual ? 5 : -25;
  if (input.productEqual !== null) s += input.productEqual ? 5 : -15;
  if (input.referenceEqual) s += 40;
  return Math.max(0, Math.min(99, s));
}

export const confidenceLabel = (n: number) => (n >= 90 ? "alta" : n >= 70 ? "média" : "baixa");
