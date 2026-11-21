// Conferência linha a linha do arquivo pronto contra o layout embutido
// (./layout.ts), antes de gravar: registro conhecido, quantidade de campos,
// tipo e tamanho de cada campo, obrigatórios, ordem e abertura/encerramento
// dos blocos, as contagens do bloco 9 (9900, 9990, 9999) e as linhas de cada
// bloco (x990). No SINTEGRA: 126 posições por registro, tipos conhecidos e os
// totais do registro 90. Arquivo que não passa não é gravado: a falha vira
// mensagem para o suporte, nunca um arquivo inválido em silêncio.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import { SINTEGRA_LAYOUT, SINTEGRA_RECORD_SIZE, type FieldSpec } from "./layout.ts";

const NUMBER = (decimals: number) => decimals ? new RegExp(`^-?\\d+,\\d{${decimals}}$`) : /^-?\d+$/;
function validDate(v: string) {
  if (!/^\d{8}$/.test(v)) return false;
  const iso = `${v.slice(4)}-${v.slice(2, 4)}-${v.slice(0, 2)}`;
  return !Number.isNaN(Date.parse(iso + "T00:00:00Z")) && new Date(iso + "T00:00:00Z").toISOString().slice(0, 10) === iso;
}

function fieldProblem(spec: FieldSpec, value: string): string | null {
  if (value === "") return spec.required ? `campo ${spec.name} obrigatório vazio` : null;
  if (spec.type === "D") return validDate(value) ? null : `campo ${spec.name} com data inválida (${value})`;
  if (spec.type === "M") return /^(0[1-9]|1[0-2])\d{4}$/.test(value) ? null : `campo ${spec.name} com mês inválido (${value})`;
  if (spec.type === "N") {
    // Números sem casas: só dígitos, com o tamanho exato quando o campo tem tamanho fixo de código (CNPJ, CPF, CFOP, NCM...).
    if (!NUMBER(spec.decimals).test(value)) return `campo ${spec.name} não é número com ${spec.decimals} casa(s) (${value})`;
    if (spec.size && !spec.decimals && value.length > spec.size) return `campo ${spec.name} passa de ${spec.size} dígitos`;
    return null;
  }
  if (spec.size && value.length > spec.size) return `campo ${spec.name} passa de ${spec.size} caracteres`;
  return null;
}

/** Problemas do arquivo SPED (vazio: confere). No máximo 50 mensagens. */
export function validateSped(lines: readonly string[], layout: Readonly<Record<string, FieldSpec[]>>, blocks: readonly string[]): string[] {
  const problems: string[] = [];
  const add = (line: number, message: string) => { if (problems.length < 50) problems.push(`linha ${line}: ${message}`); };
  const counts = new Map<string, number>();
  const blockLines = new Map<string, number>();
  let blockIndex = -1, currentBlock = "";
  lines.forEach((line, i) => {
    const n = i + 1;
    if (!line.startsWith("|") || !line.endsWith("|")) { add(n, "registro sem as barras de começo e fim"); return; }
    const values = line.slice(1, -1).split("|");
    const reg = values[0];
    const spec = layout[reg];
    if (!spec) { add(n, `registro ${reg} fora do layout`); return; }
    if (values.length !== spec.length) { add(n, `registro ${reg} com ${values.length} campos (o layout pede ${spec.length})`); return; }
    spec.forEach((field, index) => { const p = fieldProblem(field, values[index]); if (p) add(n, `${reg}: ${p}`); });
    counts.set(reg, (counts.get(reg) ?? 0) + 1);
    const block = reg[0];
    if (block !== currentBlock) {
      const next = blocks.indexOf(block);
      if (next <= blockIndex) add(n, `bloco ${block} fora da ordem`);
      if (!reg.endsWith("000") && !reg.endsWith("001")) add(n, `bloco ${block} não começa pelo registro de abertura`);
      blockIndex = next; currentBlock = block;
    }
    blockLines.set(block, (blockLines.get(block) ?? 0) + 1);
    if (reg.endsWith("990") && reg !== "9990") {
      const declared = Number(values[1]);
      if (declared !== blockLines.get(block)) add(n, `${reg} diz ${declared} linhas no bloco ${block}, mas o bloco tem ${blockLines.get(block)}`);
    }
  });
  for (const block of blocks) if (!blockLines.has(block)) problems.push(`o bloco ${block} não está no arquivo`);
  if (lines[0] && !lines[0].startsWith("|0000|")) problems.push("o arquivo não começa pelo registro 0000");
  const last = lines[lines.length - 1] ?? "";
  if (!last.startsWith("|9999|")) problems.push("o arquivo não termina no registro 9999");
  else if (Number(last.slice(6, -1)) !== lines.length) problems.push(`o 9999 diz ${last.slice(6, -1)} linhas, mas o arquivo tem ${lines.length}`);
  // 9900: uma linha por registro, com a quantidade certa.
  const declared = new Map<string, number>();
  for (const line of lines) if (line.startsWith("|9900|")) { const [, , reg, qty] = line.split("|"); declared.set(reg, Number(qty)); }
  for (const [reg, qty] of counts) if (declared.get(reg) !== qty) problems.push(`o 9900 do registro ${reg} diz ${declared.get(reg) ?? 0}, mas o arquivo tem ${qty}`);
  for (const reg of declared.keys()) if (!counts.has(reg)) problems.push(`o 9900 cita o registro ${reg}, que não está no arquivo`);
  const nine = lines.find((l) => l.startsWith("|9990|"));
  if (nine && Number(nine.slice(6, -1)) !== blockLines.get("9")) problems.push(`o 9990 diz ${nine.slice(6, -1)} linhas no bloco 9, mas o bloco tem ${blockLines.get("9")}`);
  return problems.slice(0, 50);
}

/** Problemas do arquivo SINTEGRA (vazio: confere). */
export function validateSintegra(lines: readonly string[]): string[] {
  const problems: string[] = [];
  const add = (line: number, message: string) => { if (problems.length < 50) problems.push(`linha ${line}: ${message}`); };
  const counts = new Map<string, number>();
  let order = 0;
  const rank: Record<string, number> = { "10": 1, "11": 2, "50": 3, "54": 4, "61": 5, "74": 6, "75": 7, "90": 8 };
  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.length !== SINTEGRA_RECORD_SIZE) add(n, `registro com ${line.length} posições (são ${SINTEGRA_RECORD_SIZE})`);
    if (/[^\x20-\x7e]/.test(line)) add(n, "registro com caractere fora do ASCII");
    const type = line.slice(0, 2);
    if (!(type in rank)) { add(n, `tipo de registro ${type} desconhecido`); return; }
    if (rank[type] < order) add(n, `registro ${type} fora da ordem`);
    order = rank[type];
    counts.set(type, (counts.get(type) ?? 0) + 1);
    const layout = type === "61" && line[2] === "R" ? SINTEGRA_LAYOUT["61R"] : SINTEGRA_LAYOUT[type];
    if (layout && layout.reduce((s, f) => s + f.size, 0) !== SINTEGRA_RECORD_SIZE) add(n, `layout do registro ${type} não soma ${SINTEGRA_RECORD_SIZE}`);
    if (layout) {
      let at = 0;
      for (const f of layout) {
        const v = line.slice(at, at + f.size);
        at += f.size;
        if (f.type === "N" && !/^\d+$/.test(v)) add(n, `registro ${type}: campo ${f.name} não numérico`);
        if (f.type === "D" && !/^\d{8}$/.test(v)) add(n, `registro ${type}: campo ${f.name} não é data`);
      }
    }
  });
  if ((counts.get("10") ?? 0) !== 1 || (counts.get("11") ?? 0) !== 1) problems.push("o arquivo precisa de um registro 10 e um 11");
  // Registro 90: totais por tipo e o total geral (99) conferem.
  const nineties = lines.filter((l) => l.startsWith("90"));
  if (!nineties.length) problems.push("falta o registro 90");
  const declared = new Map<string, number>();
  for (const l of nineties) {
    if (Number(l[125]) !== nineties.length) problems.push(`o 90 diz ${l[125]} registros 90, mas há ${nineties.length}`);
    for (let at = 30; at + 10 <= 125; at += 10) {
      const type = l.slice(at, at + 2), qty = l.slice(at + 2, at + 10);
      if (type.trim() && /^\d{8}$/.test(qty)) declared.set(type, Number(qty));
    }
  }
  // Os tipos 10 e 11 entram só no total geral (99).
  for (const [type, qty] of counts) if (!["10", "11", "90"].includes(type) && declared.get(type) !== qty) problems.push(`o 90 diz ${declared.get(type) ?? 0} registros ${type}, mas há ${qty}`);
  if (nineties.length && declared.get("99") !== lines.length) problems.push(`o 90 diz ${declared.get("99") ?? 0} registros no total, mas há ${lines.length}`);
  return problems.slice(0, 50);
}
