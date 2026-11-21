/**
 * Casos especiais da NF-e achados na conferência contra o Bling, e o que o
 * cofre NFapi recebe hoje (contrato em src/erp/emissor/contract, 0.12.0).
 *
 * Conferido no PedidoNfe do contrato:
 * - PIS e COFINS aceitam os CST 02 (alíquota diferenciada, fabricante ou
 *   importador do produto monofásico) e 04 (revenda monofásica a alíquota
 *   zero): o motor calcula e o preparo envia como qualquer outro CST.
 * - Não há no contrato: grupo de combustível (comb), ICMS monofásico de
 *   combustíveis (CST 02, 15, 53 e 61), veículo novo (veicProd), medicamento
 *   (med), rastreabilidade (rastro), autorização de download do XML (autXML),
 *   inscrição Suframa do destinatário (ISUF), local de retirada e local de
 *   entrega. O preparo nunca descarta esses dados em silêncio: o que muda o
 *   documento bloqueia com mensagem em palavras; o que só deixa de ir (quem
 *   pode baixar o XML, a inscrição Suframa sem benefício) vira aviso na
 *   revisão.
 *
 * `layout` e `fields` são o que o cofre precisaria receber (nomes do leiaute
 * da NF-e 4.00), para o dono levar ao projeto da NFapi.
 */
import type { JsonObject } from "../../../commercial-nfe/contracts.ts";

/** Versão do contrato do cofre em que a conferência acima foi feita. */
export const SPECIAL_GROUPS_VAULT_VERSION = "0.12.0";

export interface NfeSpecialGroup {
  /** Como aparece para o dono, em frase. */
  label: string;
  /** O cofre recebe hoje? */
  accepted: boolean;
  /** Grupo do leiaute da NF-e. */
  layout: string;
  /** Campos do grupo no leiaute. */
  fields: readonly string[];
  /** O que fazer, dito ao dono. */
  action: string;
}

export const NFE_SPECIAL_GROUPS = {
  pis_cofins_monophase: {
    label: "PIS e COFINS monofásicos (CST 02 e 04)", accepted: true,
    layout: "PISAliq/COFINSAliq (CST 02) e PISNT/COFINSNT (CST 04)", fields: ["CST", "vBC", "pPIS", "vPIS", "pCOFINS", "vCOFINS"],
    action: "Use na regra de PIS e COFINS da natureza o CST 04 (revenda de produto monofásico) ou 02 (fabricante ou importador).",
  },
  fuel: {
    label: "combustível (código ANP)", accepted: false,
    layout: "det/prod/comb",
    fields: ["cProdANP", "descANP", "pGLP", "pGNn", "pGNi", "vPart", "CODIF", "qTemp", "UFCons", "CIDE (qBCProd, vAliqProd, vCIDE)", "encerrante", "pBio", "origComb (indImport, cUFOrig, pOrig)"],
    action: "Emita a venda de combustível por outro emissor até o cofre receber esse grupo. Se o produto não é combustível, apague o código ANP no cadastro do produto.",
  },
  icms_monophase: {
    label: "ICMS monofásico de combustível (CST 02, 15, 53 ou 61)", accepted: false,
    layout: "det/imposto/ICMS/ICMS02, ICMS15, ICMS53 e ICMS61, mais os totais de ICMSTot",
    fields: ["qBCMono", "adRemICMS", "vICMSMono", "qBCMonoReten", "adRemICMSReten", "vICMSMonoReten", "pRedAdRem", "motRedAdRem", "qBCMonoDif", "adRemICMSDif", "vICMSMonoOp", "pDif", "vICMSMonoDif", "qBCMonoRet", "adRemICMSRet", "vICMSMonoRet", "ICMSTot/qBCMono, vICMSMono, qBCMonoReten, vICMSMonoReten, qBCMonoRet, vICMSMonoRet"],
    action: "Troque a situação do ICMS na regra da natureza (confira com o contador) ou emita por outro emissor até o cofre receber o ICMS monofásico.",
  },
  vehicle: {
    label: "venda de veículo novo", accepted: false,
    layout: "det/prod/veicProd",
    fields: ["tpOp", "chassi", "cCor", "xCor", "pot", "cilin", "pesoL", "pesoB", "nSerie", "tpComb", "nMotor", "CMT", "dist", "anoMod", "anoFab", "tpPint", "tpVeic", "espVeic", "VIN", "condVeic", "cMod", "cCorDENATRAN", "lota", "tpRest"],
    action: "Emita a venda do veículo por outro emissor até o cofre receber os dados do veículo.",
  },
  medicine: {
    label: "medicamento (código da ANVISA)", accepted: false,
    layout: "det/prod/med e det/prod/rastro",
    fields: ["med/cProdANVISA", "med/xMotivoIsencao", "med/vPMC", "rastro/nLote", "rastro/qLote", "rastro/dFab", "rastro/dVal", "rastro/cAgreg"],
    action: "Emita a venda de medicamento por outro emissor até o cofre receber o código da ANVISA e o lote.",
  },
  tracking: {
    label: "rastreabilidade de lote na nota", accepted: false,
    layout: "det/prod/rastro (até 500 por item)", fields: ["nLote", "qLote", "dFab", "dVal", "cAgreg"],
    action: "Tire o lote informado no item da nota ou emita por outro emissor até o cofre receber a rastreabilidade.",
  },
  authorized_xml: {
    label: "pessoas autorizadas a baixar o XML", accepted: false,
    layout: "autXML (até 10 por nota)", fields: ["CNPJ ou CPF"],
    action: "Mande o XML ao contador pela exportação do cofre (Fiscal › Exportação para o contador) até o cofre receber a lista de autorizados.",
  },
  suframa: {
    label: "inscrição Suframa do cliente", accepted: false,
    layout: "dest/ISUF", fields: ["ISUF"],
    action: "Venda com isenção para a Zona Franca de Manaus (desoneração do ICMS motivo 7) precisa da inscrição Suframa na nota: emita por outro emissor até o cofre recebê-la.",
  },
  pickup: {
    label: "endereço de retirada diferente do emitente", accepted: false,
    layout: "retirada",
    fields: ["CNPJ ou CPF", "xNome", "xLgr", "nro", "xCpl", "xBairro", "cMun", "xMun", "UF", "CEP", "cPais", "xPais", "fone", "email", "IE"],
    action: "Emita por outro emissor quando a mercadoria sai de outro endereço, até o cofre receber o local de retirada.",
  },
  delivery: {
    label: "endereço de entrega diferente do cliente", accepted: false,
    layout: "entrega",
    fields: ["CNPJ ou CPF", "xNome", "xLgr", "nro", "xCpl", "xBairro", "cMun", "xMun", "UF", "CEP", "cPais", "xPais", "fone", "email", "IE"],
    action: "Se a mercadoria vai para o endereço do cliente, apague o endereço de entrega no pedido. Se vai para outro lugar, emita por outro emissor até o cofre receber o local de entrega.",
  },
} as const satisfies Record<string, NfeSpecialGroup>;

export type NfeSpecialGroupKey = keyof typeof NFE_SPECIAL_GROUPS;

/** Mensagem do bloqueio: o que a venda tem, por que não sai e o que fazer. */
export function specialGroupBlockMessage(key: NfeSpecialGroupKey, subject?: string): string {
  const group = NFE_SPECIAL_GROUPS[key];
  return `${subject ? `${subject}: ` : ""}esta venda tem ${group.label}, e o seu cofre fiscal ainda não recebe esse dado na NF-e. Sem ele a nota sairia errada, por isso não foi enviada. ${group.action}`;
}

/** Chaves de item ou produto que pertencem a um grupo especial que o cofre não recebe. */
const ITEM_KEYS: Record<string, NfeSpecialGroupKey> = {
  fuel: "fuel", anp_code: "fuel", anp_description: "fuel", glp_percent: "fuel", glgnn_percent: "fuel", glgni_percent: "fuel", starting_value: "fuel",
  vehicle: "vehicle", medicine: "medicine", tracking: "tracking", rastro: "tracking",
};
export const specialGroupOfKey = (key: string): NfeSpecialGroupKey | null => ITEM_KEYS[key] ?? null;

/** ICMS monofásico de combustíveis (CST que o contrato não tem). */
export const ICMS_MONOPHASE_CST = ["02", "15", "53", "61"] as const;
/** Motivo de desoneração do ICMS "Suframa" (venda para a Zona Franca de Manaus e áreas de livre comércio). */
export const SUFRAMA_DESONERATION_REASON = "7";

export interface SpecialGroupNotice { code: string; group: NfeSpecialGroupKey; message: string }

/**
 * Avisos que não bloqueiam: dados do cadastro que existem mas não vão na nota
 * porque o cofre não os recebe e a nota continua correta sem eles.
 */
export function specialGroupNotices(input: { preferences: JsonObject | null | undefined; recipient: JsonObject | null | undefined }): SpecialGroupNotice[] {
  const notices: SpecialGroupNotice[] = [];
  const people = Array.isArray(input.preferences?.autxml_people) ? input.preferences!.autxml_people : [];
  if (people.length || input.preferences?.autxml_carrier === true) {
    notices.push({ code: "nfe_autxml_not_sent", group: "authorized_xml",
      message: `As pessoas autorizadas a baixar o XML (Preferências › Notas fiscais${people.length ? `, ${people.length} ${people.length === 1 ? "pessoa" : "pessoas"}` : ""}) não vão nesta nota: o seu cofre fiscal ainda não recebe essa lista. ${NFE_SPECIAL_GROUPS.authorized_xml.action}` });
  }
  const suframa = input.recipient?.suframa;
  if (typeof suframa === "string" && suframa.trim()) {
    notices.push({ code: "nfe_suframa_not_sent", group: "suframa",
      message: `A inscrição Suframa do cliente (${suframa.trim()}) não vai nesta nota: o seu cofre fiscal ainda não recebe esse dado. A nota sai sem ela; isso só é problema se a venda tiver o benefício da Zona Franca, que fica bloqueado até o cofre receber a inscrição.` });
  }
  return notices;
}
