// Tabelas fiscais do painel (NF-e/NFC-e, leiaute 4.00): mesmos códigos
// aceitos por validateFiscal em src/modules/vendas/model.ts.

/** Origem da mercadoria (tabela A do ICMS). */
export const originOptions: [string, string][] = [
  ["0", "0 · Nacional, exceto as indicadas nos códigos 3, 4, 5 e 8"],
  ["1", "1 · Estrangeira, importação direta, exceto a do código 6"],
  ["2", "2 · Estrangeira, adquirida no mercado interno, exceto a do código 7"],
  ["3", "3 · Nacional, com conteúdo de importação acima de 40% e até 70%"],
  ["4", "4 · Nacional, produzida conforme os processos produtivos básicos (PPB)"],
  ["5", "5 · Nacional, com conteúdo de importação de até 40%"],
  ["6", "6 · Estrangeira, importação direta, sem similar nacional (lista da CAMEX)"],
  ["7", "7 · Estrangeira, mercado interno, sem similar nacional (lista da CAMEX)"],
  ["8", "8 · Nacional, com conteúdo de importação acima de 70%"],
];

/** CSOSN (Simples Nacional). */
export const csosnOptions: [string, string][] = [
  ["101", "101 · Tributada com permissão de crédito"],
  ["102", "102 · Tributada sem permissão de crédito"],
  ["103", "103 · Isenção para faixa de receita bruta"],
  ["201", "201 · Com permissão de crédito e cobrança por ST"],
  ["202", "202 · Sem permissão de crédito e com cobrança por ST"],
  ["203", "203 · Isenção para faixa de receita bruta e cobrança por ST"],
  ["300", "300 · Imune"],
  ["400", "400 · Não tributada"],
  ["500", "500 · ICMS cobrado anteriormente por ST ou antecipação"],
  ["900", "900 · Outros"],
];

/** CST do ICMS (regime normal). */
export const icmsCstOptions: [string, string][] = [
  ["00", "00 · Tributada integralmente"],
  ["02", "02 · Monofásica própria sobre combustíveis"],
  ["10", "10 · Tributada e com cobrança por ST"],
  ["15", "15 · Monofásica própria e com retenção sobre combustíveis"],
  ["20", "20 · Com redução da base de cálculo"],
  ["30", "30 · Isenta ou não tributada e com cobrança por ST"],
  ["40", "40 · Isenta"],
  ["41", "41 · Não tributada"],
  ["50", "50 · Suspensão"],
  ["51", "51 · Diferimento"],
  ["53", "53 · Monofásica sobre combustíveis com recolhimento diferido"],
  ["60", "60 · ICMS cobrado anteriormente por ST"],
  ["61", "61 · Monofásica sobre combustíveis cobrada anteriormente"],
  ["70", "70 · Com redução da base e cobrança por ST"],
  ["90", "90 · Outras"],
];

/** CST de PIS e COFINS nas saídas. */
export const pisCofinsOptions: [string, string][] = [
  ["01", "01 · Tributável, alíquota básica"],
  ["02", "02 · Tributável, alíquota diferenciada"],
  ["03", "03 · Tributável, alíquota por unidade de medida"],
  ["04", "04 · Monofásica, revenda a alíquota zero"],
  ["05", "05 · Substituição tributária"],
  ["06", "06 · Alíquota zero"],
  ["07", "07 · Isenta"],
  ["08", "08 · Sem incidência"],
  ["09", "09 · Com suspensão"],
  ["49", "49 · Outras operações de saída"],
  ["99", "99 · Outras operações"],
];

/** CST do IPI nas saídas. */
export const ipiCstOptions: [string, string][] = [
  ["50", "50 · Saída tributada"],
  ["51", "51 · Saída tributável com alíquota zero"],
  ["52", "52 · Saída isenta"],
  ["53", "53 · Saída não tributada"],
  ["54", "54 · Saída imune"],
  ["55", "55 · Saída com suspensão"],
  ["99", "99 · Outras saídas"],
];

export const regimeOptions: [string, string][] = [
  ["simples", "Simples Nacional"],
  ["simples_excesso", "Simples Nacional, excesso de sublimite da receita bruta"],
  ["normal", "Regime normal (Lucro Presumido ou Real)"],
  ["mei", "MEI"],
];

export const UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA",
  "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
];

/** Opções de um select, mantendo um valor salvo fora da lista. */
export const withCurrent = (options: [string, string][], value: string) =>
  value && !options.some(([id]) => id === value)
    ? [...options, [value, `${value} · (código salvo)`] as [string, string]]
    : options;

/** Emitente do Simples (CSOSN) ou do regime normal (CST). */
export const isSimples = (regime: string | null | undefined) =>
  regime === "simples" || regime === "mei";
