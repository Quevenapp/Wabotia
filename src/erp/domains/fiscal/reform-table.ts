// Tabelas de referência da reforma tributária do consumo (IBS, CBS e IS),
// versionadas como dado: o motor, as telas e o relatório leem daqui.
//
// 1. CST de IBS/CBS e classificações tributárias (cClassTrib) publicadas na
//    tabela oficial do Portal da NF-e (informe técnico 2025.002), com o
//    percentual de redução de alíquota de cada classificação (pRedIBS e
//    pRedCBS). O primeiro trecho de três dígitos da classificação é o CST.
//    Esta cópia foi montada sem acesso à rede: traz as classificações de uso
//    mais comum num pequeno negócio. Para trocar pela tabela oficial inteira,
//    exporte a planilha publicada em CSV e rode
//    `node scripts/erp/reforma-cclasstrib.mjs <arquivo.csv>`: o script
//    reescreve REFORM_CLASSES abaixo e sobe REFORM_TABLE_VERSION.
// 2. Alíquotas por ano da transição (LC 214/2025, arts. 343 a 348 e ADCT da
//    EC 132/2023, arts. 125 a 133): 2026 com as alíquotas de teste (CBS 0,9%
//    e IBS estadual 0,1%), 2027 e 2028 com a CBS cheia e o IBS de 0,1%, e o
//    IBS subindo de 2029 a 2033. As alíquotas de referência de 2027 em diante
//    dependem de resolução do Senado: sem elas, o ano fica "não publicado" e
//    o cálculo pede as alíquotas na tela da reforma (configuração da empresa).
//
// Nada aqui faz I/O: o mesmo arquivo serve ao motor (SQLite), ao Worker e ao
// painel.

/** Versão da tabela embutida (data da cópia e origem). */
export const REFORM_TABLE_VERSION = "2026-11-21.parcial-1";
export const REFORM_TABLE_SOURCE =
  "Tabela de CST e cClassTrib do IBS e da CBS, Portal da NF-e (informe técnico 2025.002); subconjunto sem acesso à rede, a conferir com a planilha oficial.";

/** Como o ERP trata cada CST no cálculo. */
export type ReformCstKind =
  /** Tributa: base, alíquota (com redução da classificação) e valor. */
  | "taxed"
  /** Isenção, imunidade ou não incidência: vai só CST e classificação, sem base. */
  | "exempt"
  /** Regime que o ERP não calcula (alíquota fixa, diferimento, suspensão,
   *  monofásico, transferência de crédito, ajustes, regimes específicos):
   *  vai só CST e classificação; os valores ficam com o contador. */
  | "manual";

export interface ReformCst {
  cst: string;
  description: string;
  kind: ReformCstKind;
}

export const REFORM_CSTS: readonly ReformCst[] = Object.freeze([
  { cst: "000", description: "Tributação integral", kind: "taxed" },
  { cst: "010", description: "Tributação com alíquotas uniformes", kind: "manual" },
  { cst: "011", description: "Tributação com alíquotas uniformes reduzidas", kind: "manual" },
  { cst: "200", description: "Alíquota reduzida", kind: "taxed" },
  { cst: "210", description: "Alíquota reduzida com redutor de base de cálculo", kind: "manual" },
  { cst: "220", description: "Alíquota fixa", kind: "manual" },
  { cst: "221", description: "Alíquota fixa proporcional", kind: "manual" },
  { cst: "222", description: "Redução de base de cálculo", kind: "manual" },
  { cst: "400", description: "Isenção", kind: "exempt" },
  { cst: "410", description: "Imunidade e não incidência", kind: "exempt" },
  { cst: "510", description: "Diferimento", kind: "manual" },
  { cst: "550", description: "Suspensão", kind: "manual" },
  { cst: "620", description: "Tributação monofásica", kind: "manual" },
  { cst: "800", description: "Transferência de crédito", kind: "manual" },
  { cst: "810", description: "Ajustes", kind: "manual" },
  { cst: "820", description: "Tributação em declaração de regime específico", kind: "manual" },
  { cst: "830", description: "Exclusão da base de cálculo", kind: "manual" },
]);

export interface ReformClassEntry {
  /** cClassTrib, seis dígitos; os três primeiros são o CST. */
  code: string;
  cst: string;
  description: string;
  /** Percentual de redução da alíquota do IBS (pRedIBS), texto decimal. */
  ibs_reduction: string;
  /** Percentual de redução da alíquota da CBS (pRedCBS), texto decimal. */
  cbs_reduction: string;
  /** Dispositivo da LC 214/2025. */
  law: string;
}

const c = (code: string, description: string, reduction: string, law: string, cbsReduction = reduction): ReformClassEntry =>
  ({ code, cst: code.slice(0, 3), description, ibs_reduction: reduction, cbs_reduction: cbsReduction, law });

export const REFORM_CLASSES: readonly ReformClassEntry[] = Object.freeze([
  c("000001", "Situações tributadas integralmente pelo IBS e CBS", "0", "art. 4º"),
  c("000002", "Exploração de via", "0", "art. 11"),
  c("000003", "Regime automotivo: projetos incentivados (art. 311)", "0", "art. 311"),
  c("000004", "Regime automotivo: projetos incentivados (art. 312)", "0", "art. 312"),
  c("010001", "Operações do FGTS não realizadas pela Caixa Econômica Federal", "0", "art. 212"),
  c("010002", "Operações do serviço financeiro", "0", "art. 233"),
  c("011001", "Planos de assistência funerária", "0", "art. 236"),
  c("011002", "Planos de assistência à saúde", "0", "art. 237"),
  c("011003", "Intermediação de planos de assistência à saúde", "0", "art. 240"),
  c("011004", "Concursos e prognósticos", "0", "art. 246"),
  c("200001", "Aquisições por empresas autorizadas a operar em zona de processamento de exportação", "100", "art. 103"),
  c("200003", "Produtos da Cesta Básica Nacional de Alimentos (Anexo I)", "100", "art. 125"),
  c("200013", "Produtos hortícolas, frutas e ovos (Anexo XV)", "100", "art. 148"),
  c("200028", "Serviços de educação (Anexo II)", "60", "art. 129"),
  c("200029", "Serviços de saúde humana (Anexo III)", "60", "art. 130"),
  c("200030", "Dispositivos médicos (Anexo IV)", "60", "art. 131"),
  c("200031", "Dispositivos de acessibilidade para pessoas com deficiência (Anexo V)", "60", "art. 132"),
  c("200032", "Medicamentos (Anexo VI)", "60", "art. 133"),
  c("200034", "Alimentos destinados ao consumo humano (Anexo VII)", "60", "art. 135"),
  c("200035", "Produtos de higiene pessoal e limpeza (Anexo VIII)", "60", "art. 136"),
  c("200036", "Produtos agropecuários, aquícolas, pesqueiros, florestais e extrativistas vegetais in natura", "60", "art. 137"),
  c("200038", "Insumos agropecuários e aquícolas (Anexo IX)", "60", "art. 138"),
  c("200039", "Produções artísticas, culturais, jornalísticas e audiovisuais nacionais (Anexo X)", "60", "art. 139"),
  c("200041", "Atividades desportivas", "60", "art. 141"),
  c("200052", "Serviços de profissão intelectual regulamentada", "30", "art. 127"),
  c("400001", "Transporte público coletivo de passageiros rodoviário e metroviário", "100", "art. 157"),
  c("410001", "Bonificações que constem no documento fiscal e não dependam de evento posterior", "100", "art. 5º"),
  c("410002", "Transferências entre estabelecimentos do mesmo titular", "100", "art. 6º"),
  c("410003", "Doações sem contraprestação em benefício do doador", "100", "art. 6º"),
  c("410004", "Exportações de bens e serviços", "100", "art. 8º"),
  c("410999", "Operações não onerosas sem previsão de tributação", "100", "art. 6º"),
  c("510001", "Operações com diferimento", "0", "art. 63"),
  c("550001", "Operações com suspensão", "0", "art. 82"),
  c("620001", "Tributação monofásica de combustíveis", "0", "art. 172"),
  c("800001", "Transferência de crédito em fusão, cisão ou incorporação", "0", "art. 55"),
  c("810001", "Crédito presumido ou ajuste de documento", "0", "art. 168"),
]);

/** CST do Imposto Seletivo e as classificações mais comuns (LC 214/2025, arts. 409 a 438). */
export const SELECTIVE_CSTS: readonly ReformCst[] = Object.freeze([
  { cst: "000", description: "Tributação integral do Imposto Seletivo", kind: "taxed" },
  { cst: "410", description: "Imunidade e não incidência do Imposto Seletivo", kind: "exempt" },
]);

export interface ReformYearRates {
  year: number;
  /** Alíquotas em %, texto decimal; null quando ainda não publicadas. */
  cbs: string | null;
  ibs_uf: string | null;
  ibs_mun: string | null;
  /** 2026: valores informativos, que não entram no total da nota nem são pagos. */
  informative: boolean;
  /** Imposto Seletivo vigente no ano (a partir de 2027). */
  selective: boolean;
  note: string;
}

/** Alíquotas padrão por ano. A empresa pode informar as dos anos não publicados. */
export const REFORM_YEAR_RATES: readonly ReformYearRates[] = Object.freeze([
  { year: 2026, cbs: "0.9", ibs_uf: "0.1", ibs_mun: "0", informative: true, selective: false,
    note: "Ano de teste: CBS 0,9% e IBS 0,1%, só informativos; compensáveis com PIS e COFINS." },
  { year: 2027, cbs: null, ibs_uf: "0.05", ibs_mun: "0.05", informative: false, selective: true,
    note: "CBS cheia (alíquota de referência menos 0,1 ponto) e IBS de 0,1%; PIS e COFINS acabam." },
  { year: 2028, cbs: null, ibs_uf: "0.05", ibs_mun: "0.05", informative: false, selective: true,
    note: "Como 2027." },
  { year: 2029, cbs: null, ibs_uf: null, ibs_mun: null, informative: false, selective: true, note: "IBS em 10% da alíquota de referência." },
  { year: 2030, cbs: null, ibs_uf: null, ibs_mun: null, informative: false, selective: true, note: "IBS em 20% da alíquota de referência." },
  { year: 2031, cbs: null, ibs_uf: null, ibs_mun: null, informative: false, selective: true, note: "IBS em 30% da alíquota de referência." },
  { year: 2032, cbs: null, ibs_uf: null, ibs_mun: null, informative: false, selective: true, note: "IBS em 40% da alíquota de referência." },
  { year: 2033, cbs: null, ibs_uf: null, ibs_mun: null, informative: false, selective: true, note: "IBS e CBS integrais; ICMS e ISS acabam." },
]);

export const REFORM_FIRST_YEAR = 2026;
export const REFORM_LAST_YEAR = 2033;

export const reformCst = (cst: string) => REFORM_CSTS.find((entry) => entry.cst === cst) ?? null;
export const reformClassEntry = (code: string) => REFORM_CLASSES.find((entry) => entry.code === code) ?? null;
export const reformYearRates = (year: number) => REFORM_YEAR_RATES.find((entry) => entry.year === year) ?? null;
