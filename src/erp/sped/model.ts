// O que os geradores de arquivo (SPED Fiscal, EFD-Contribuições e SINTEGRA)
// recebem: a empresa, a configuração, as notas do período já lidas dos XML e
// normalizadas, o inventário e os cadastros. Dinheiro em centavos (inteiro);
// quantidade, preço e alíquota em texto decimal com ponto, como no XML.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.

export interface SpedCompany {
  name: string;
  trade_name: string | null;
  cnpj: string;
  ie: string | null;
  im: string | null;
  uf: string;
  city: string;
  city_code: string;
  postal_code: string;
  street: string;
  number: string;
  complement: string | null;
  district: string;
  phone: string | null;
  email: string | null;
  suframa: string | null;
  crt: string | null;
  cnae: string | null;
}

export interface SpedAccountant {
  name: string | null;
  cpf: string | null;
  crc: string | null;
  cnpj: string | null;
  postal_code: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  phone: string | null;
  email: string | null;
  city_code: string | null;
}

export interface SpedSettings {
  /** Perfil do SPED Fiscal: A, B ou C (o contador informa). */
  profile: "A" | "B" | "C";
  /** 0 industrial ou equiparado; 1 outros. */
  activity: "0" | "1";
  accountant: SpedAccountant;
  pis_cofins: {
    /** COD_INC_TRIB: 1 não cumulativo, 2 cumulativo, 3 ambos. */
    incidence: "1" | "2" | "3";
    /** IND_APRO_CRED: 1 apropriação direta, 2 rateio proporcional. */
    credit_method: "1" | "2";
    /** COD_TIPO_CONT: 1 alíquota básica, 2 alíquotas específicas. */
    contribution_type: "1" | "2";
    /** IND_REG_CUM (só no cumulativo): 1 caixa, 2 consolidado por competência, 9 detalhado. */
    cumulative_regime: "1" | "2" | "9";
    /** IND_NAT_PJ: 00 sociedade empresária em geral, 01 cooperativa... */
    nature: string;
    /** IND_ATIV da EFD-Contribuições: 0 industrial, 1 serviços, 2 comércio, 3 financeira, 4 imobiliária, 9 outros. */
    activity: "0" | "1" | "2" | "3" | "4" | "9";
  };
  /** Código de receita do ICMS próprio da UF (E116); sem ele, ICMS a recolher impede o arquivo. */
  icms_revenue_code: string | null;
  /** Dia do vencimento do ICMS no mês seguinte (E116). */
  icms_due_day: number;
  sintegra: {
    /** Código da natureza das operações informadas: 1 interestaduais com ST, 2 interestaduais, 3 totalidade. */
    nature: "1" | "2" | "3";
    /** Finalidade: 1 normal, 2 retificação total, 3 retificação aditiva, 5 desfazimento. */
    purpose: "1" | "2" | "3" | "5";
    /** Nome do contato do registro 11. */
    contact: string | null;
  };
  /** O arquivo pronto entra no pacote do contador do mesmo período. */
  in_package: boolean;
}

export interface SpedParty {
  /** CNPJ (14) ou CPF (11), só dígitos (ou letras no CNPJ alfanumérico); null sem documento. */
  document: string | null;
  foreign_id: string | null;
  name: string;
  ie: string | null;
  uf: string | null;
  city_code: string | null;
  city: string | null;
  /** Código do país (Bacen): 1058 Brasil. */
  country: string;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  postal_code: string | null;
  phone: string | null;
  suframa: string | null;
}

export interface SpedTax { cst: string | null; base: number; rate: string; value: number }
export interface SpedItem {
  n: number;
  /** Código do item no arquivo (o do cadastro do produto quando a entrada ligou o item a um produto). */
  code: string;
  description: string;
  ncm: string | null;
  cest: string | null;
  gtin: string | null;
  ex_tipi: string | null;
  unit: string;
  /** Produto do cadastro (entradas ligadas a produto), para o atalho de correção. */
  product_id: string | null;
  cfop: string;
  qty: string;
  unit_value: string;
  amount: number;
  discount: number;
  freight: number;
  insurance: number;
  other: number;
  /** Origem (0 a 8). */
  origin: string;
  /** CST do ICMS (2 dígitos) ou CSOSN (3 dígitos), sem a origem. */
  icms_cst: string;
  csosn: boolean;
  icms_base: number;
  icms_rate: string;
  icms: number;
  icms_reduction: string | null;
  st_base: number;
  st_rate: string;
  st: number;
  ipi: SpedTax & { enq: string | null };
  pis: SpedTax;
  cofins: SpedTax;
}

export interface SpedTotals {
  doc: number;
  products: number;
  discount: number;
  freight: number;
  insurance: number;
  other: number;
  icms_base: number;
  icms: number;
  st_base: number;
  st: number;
  ipi: number;
  pis: number;
  cofins: number;
}

export interface SpedService {
  /** Código do serviço (tributação nacional, 6 dígitos) e o item da lista (LC 116). */
  code: string | null;
  description: string;
  amount: number;
  discount: number;
  iss_base: number;
  iss_rate: string;
  iss: number;
  iss_withheld: boolean;
  pis: SpedTax;
  cofins: SpedTax;
  pis_withheld: number;
  cofins_withheld: number;
}

/** COD_SIT: 00 regular, 01 extemporâneo, 02 cancelado, 03 cancelado extemporâneo, 04 denegado, 05 inutilizado, 06 complementar, 07 complementar extemporâneo, 08 regime especial. */
export type SpedSituation = "00" | "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08";

export interface SpedDocument {
  kind: "nfe" | "nfce" | "nfse" | "entrada" | "inutilizada";
  /** 55 NF-e, 65 NFC-e; NFS-e: "nfse". */
  model: "55" | "65" | "nfse";
  /** IND_OPER: 0 entrada, 1 saída. */
  direction: "0" | "1";
  /** IND_EMIT: true emissão própria (0), false terceiros (1). */
  own: boolean;
  key: string | null;
  series: string;
  number: string;
  /** Inutilização: o último número da faixa. */
  number_to: string | null;
  issued_on: string;
  /** Data da entrada ou da saída (DT_E_S); na entrada, o dia em que a nota entrou no ERP. */
  io_on: string | null;
  situation: SpedSituation;
  /** finNFe: 1 normal, 2 complementar, 3 ajuste, 4 devolução. */
  finality: string;
  nature: string | null;
  party: SpedParty | null;
  /** IND_PGTO: 0 à vista, 1 a prazo, 2 outros (9 sem pagamento no SPED Fiscal). */
  payment: string;
  /** modFrete: 0 emitente, 1 destinatário, 2 terceiros, 3 próprio remetente, 4 próprio destinatário, 9 sem frete. */
  freight_mode: string;
  totals: SpedTotals;
  items: SpedItem[];
  service: SpedService | null;
  /** CRT do emitente no XML. */
  emitter_crt: string | null;
}

export interface SpedInventoryItem {
  product_id: string;
  code: string;
  description: string;
  unit: string | null;
  ncm: string | null;
  gtin: string | null;
  /** Quantidade em texto decimal (escala 6 do Estoque). */
  qty: string;
  /** Custo unitário em texto decimal. */
  unit_cost: string;
  /** Valor total em centavos. */
  amount: number;
}

export interface SpedInput {
  kind: "efd_icms_ipi" | "efd_contribuicoes" | "sintegra";
  from: string;
  to: string;
  company: SpedCompany;
  settings: SpedSettings;
  documents: SpedDocument[];
  inventory: { day: string; items: SpedInventoryItem[] } | null;
  /** Saldo credor de ICMS do mês anterior, em centavos (E110). */
  previous_credit: number;
  /** Cadastro dos produtos ligados (código do produto → dados do cadastro), para o 0200 e o 75. */
  products: Record<string, { description: string; unit: string | null; ncm: string | null; gtin: string | null; cest: string | null }>;
}

export const emptyTotals = (): SpedTotals => ({ doc: 0, products: 0, discount: 0, freight: 0, insurance: 0, other: 0, icms_base: 0, icms: 0, st_base: 0, st: 0, ipi: 0, pis: 0, cofins: 0 });
export const emptyTax = (): SpedTax => ({ cst: null, base: 0, rate: "0", value: 0 });
