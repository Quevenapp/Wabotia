// Layout dos arquivos como dado versionado: os registros que o Vinki gera,
// com os campos na ordem do Guia Prático (SPED Fiscal e EFD-Contribuições) e
// do Convênio ICMS 57/95 (SINTEGRA), o tipo, o tamanho, as casas decimais e se
// o campo é obrigatório; a versão do leiaute (COD_VER) pelo ano do período.
// A conferência linha a linha (./validate.ts) lê daqui. Mudou o guia: suba a
// versão abaixo e acrescente a linha nova da tabela de COD_VER; as mudanças
// de campo entram registro a registro, com a vigência no comentário.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.

/** Versão deste dado (sobe a cada mudança de layout embutida). */
export const SPED_LAYOUT_VERSION = "2026.1";
/** Guias de referência do dado. */
export const SPED_GUIDES = Object.freeze({
  efd_icms_ipi: "Guia Prático da EFD ICMS/IPI, versão 3.1.x (leiautes 017 a 020)",
  efd_contribuicoes: "Guia Prático da EFD-Contribuições, versão 1.35 (leiaute 006)",
  sintegra: "Convênio ICMS 57/95, Manual de Orientação (registros 10 a 90, 126 posições)",
});

/** COD_VER da EFD ICMS/IPI pelo período (vigência a partir do primeiro dia do ano). */
export const EFD_ICMS_IPI_VERSIONS: readonly { from: string; version: string }[] = Object.freeze([
  { from: "2020-01-01", version: "014" },
  { from: "2021-01-01", version: "015" },
  { from: "2022-01-01", version: "016" },
  { from: "2023-01-01", version: "017" },
  { from: "2024-01-01", version: "018" },
  { from: "2025-01-01", version: "019" },
  { from: "2026-01-01", version: "020" },
]);
/** COD_VER da EFD-Contribuições pelo período. */
export const EFD_CONTRIBUICOES_VERSIONS: readonly { from: string; version: string }[] = Object.freeze([
  { from: "2019-01-01", version: "006" },
]);

export function layoutVersion(table: readonly { from: string; version: string }[], day: string): string | null {
  let found: string | null = null;
  for (const row of table) if (day >= row.from) found = row.version;
  return found;
}

/** Tipo do campo: C texto, N número (com casas, vírgula), D data DDMMAAAA, M mês MMAAAA. */
export type FieldType = "C" | "N" | "D" | "M";
export interface FieldSpec { name: string; type: FieldType; size: number | null; decimals: number; required: boolean }

/** "NOME:TIPO:TAMANHO:CASAS:O" (O obrigatório; vazio, condicional). */
function fields(spec: string): FieldSpec[] {
  return spec.trim().split(/\s+/).map((item) => {
    const [name, type, size, decimals, req] = item.split(":");
    return { name, type: (type || "C") as FieldType, size: size ? Number(size) : null, decimals: decimals ? Number(decimals) : 0, required: req === "O" };
  });
}

// ---------------------------------------------------------------------------
// EFD ICMS/IPI (leiaute 017+; campos de 2023 em diante)

export const EFD_ICMS_IPI_LAYOUT: Readonly<Record<string, FieldSpec[]>> = Object.freeze({
  "0000": fields("REG:C:4::O COD_VER:N:3::O COD_FIN:N:1::O DT_INI:D:8::O DT_FIN:D:8::O NOME:C:100::O CNPJ:C:14 CPF:N:11 UF:C:2::O IE:C:14::O COD_MUN:N:7::O IM:C SUFRAMA:C:9 IND_PERFIL:C:1::O IND_ATIV:N:1::O"),
  "0001": fields("REG:C:4::O IND_MOV:N:1::O"),
  "0005": fields("REG:C:4::O FANTASIA:C:60::O CEP:N:8::O END:C:60::O NUM:C:10 COMPL:C:60 BAIRRO:C:60::O FONE:C:11 FAX:C:11 EMAIL:C"),
  "0100": fields("REG:C:4::O NOME:C:100::O CPF:N:11::O CRC:C:15::O CNPJ:C:14 CEP:N:8 END:C:60 NUM:C:10 COMPL:C:60 BAIRRO:C:60 FONE:C:11 FAX:C:11 EMAIL:C::O COD_MUN:N:7"),
  "0150": fields("REG:C:4::O COD_PART:C:60::O NOME:C:100::O COD_PAIS:N:5::O CNPJ:C:14 CPF:N:11 IE:C:14 COD_MUN:N:7 SUFRAMA:C:9 END:C:60 NUM:C:10 COMPL:C:60 BAIRRO:C:60"),
  "0190": fields("REG:C:4::O UNID:C:6::O DESCR:C::O"),
  "0200": fields("REG:C:4::O COD_ITEM:C:60::O DESCR_ITEM:C::O COD_BARRA:C COD_ANT_ITEM:C:60 UNID_INV:C:6 TIPO_ITEM:N:2::O COD_NCM:C:8 EX_IPI:C:3 COD_GEN:N:2 COD_LST:C:5 ALIQ_ICMS:N:6:2 CEST:N:7"),
  "0400": fields("REG:C:4::O COD_NAT:C:10::O DESCR_NAT:C::O"),
  "0990": fields("REG:C:4::O QTD_LIN_0:N::O"),
  "B001": fields("REG:C:4::O IND_DAD:N:1::O"),
  "B990": fields("REG:C:4::O QTD_LIN_B:N::O"),
  "C001": fields("REG:C:4::O IND_MOV:C:1::O"),
  "C100": fields(`REG:C:4::O IND_OPER:C:1::O IND_EMIT:C:1::O COD_PART:C:60 COD_MOD:C:2::O COD_SIT:N:2::O SER:C:3 NUM_DOC:N:9::O CHV_NFE:C:44 DT_DOC:D:8 DT_E_S:D:8
    VL_DOC:N::2 IND_PGTO:C:1 VL_DESC:N::2 VL_ABAT_NT:N::2 VL_MERC:N::2 IND_FRT:C:1 VL_FRT:N::2 VL_SEG:N::2 VL_OUT_DA:N::2 VL_BC_ICMS:N::2 VL_ICMS:N::2
    VL_BC_ICMS_ST:N::2 VL_ICMS_ST:N::2 VL_IPI:N::2 VL_PIS:N::2 VL_COFINS:N::2 VL_PIS_ST:N::2 VL_COFINS_ST:N::2`),
  "C170": fields(`REG:C:4::O NUM_ITEM:N:3::O COD_ITEM:C:60::O DESCR_COMPL:C QTD:N::5 UNID:C:6 VL_ITEM:N::2:O VL_DESC:N::2 IND_MOV:C:1 CST_ICMS:N:3::O CFOP:N:4::O COD_NAT:C:10
    VL_BC_ICMS:N::2 ALIQ_ICMS:N:6:2 VL_ICMS:N::2 VL_BC_ICMS_ST:N::2 ALIQ_ST:N:6:2 VL_ICMS_ST:N::2 IND_APUR:C:1 CST_IPI:C:2 COD_ENQ:C:3 VL_BC_IPI:N::2 ALIQ_IPI:N:6:2 VL_IPI:N::2
    CST_PIS:N:2 VL_BC_PIS:N::2 ALIQ_PIS:N:8:4 QUANT_BC_PIS:N::3 ALIQ_PIS_QUANT:N::4 VL_PIS:N::2 CST_COFINS:N:2 VL_BC_COFINS:N::2 ALIQ_COFINS:N:8:4 QUANT_BC_COFINS:N::3
    ALIQ_COFINS_QUANT:N::4 VL_COFINS:N::2 COD_CTA:C VL_ABAT_NT:N::2`),
  "C190": fields("REG:C:4::O CST_ICMS:N:3::O CFOP:N:4::O ALIQ_ICMS:N:6:2 VL_OPR:N::2:O VL_BC_ICMS:N::2:O VL_ICMS:N::2:O VL_BC_ICMS_ST:N::2:O VL_ICMS_ST:N::2:O VL_RED_BC:N::2:O VL_IPI:N::2:O COD_OBS:C:6"),
  "C990": fields("REG:C:4::O QTD_LIN_C:N::O"),
  "D001": fields("REG:C:4::O IND_MOV:C:1::O"),
  "D990": fields("REG:C:4::O QTD_LIN_D:N::O"),
  "E001": fields("REG:C:4::O IND_MOV:C:1::O"),
  "E100": fields("REG:C:4::O DT_INI:D:8::O DT_FIN:D:8::O"),
  "E110": fields(`REG:C:4::O VL_TOT_DEBITOS:N::2:O VL_AJ_DEBITOS:N::2:O VL_TOT_AJ_DEBITOS:N::2:O VL_ESTORNOS_CRED:N::2:O VL_TOT_CREDITOS:N::2:O VL_AJ_CREDITOS:N::2:O
    VL_TOT_AJ_CREDITOS:N::2:O VL_ESTORNOS_DEB:N::2:O VL_SLD_CREDOR_ANT:N::2:O VL_SLD_APURADO:N::2:O VL_TOT_DED:N::2:O VL_ICMS_RECOLHER:N::2:O VL_SLD_CREDOR_TRANSPORTAR:N::2:O DEB_ESP:N::2:O`),
  "E116": fields("REG:C:4::O COD_OR:C:3::O VL_OR:N::2:O DT_VCTO:D:8::O COD_REC:C::O NUM_PROC:C:60 IND_PROC:C:1 PROC:C TXT_COMPL:C MES_REF:M:6::O"),
  "E200": fields("REG:C:4::O UF:C:2::O DT_INI:D:8::O DT_FIN:D:8::O"),
  "E210": fields(`REG:C:4::O IND_MOV_ST:C:1::O VL_SLD_CRED_ANT_ST:N::2:O VL_DEVOL_ST:N::2:O VL_RESSARC_ST:N::2:O VL_OUT_CRED_ST:N::2:O VL_AJ_CREDITOS_ST:N::2:O
    VL_RETENCAO_ST:N::2:O VL_OUT_DEB_ST:N::2:O VL_AJ_DEBITOS_ST:N::2:O VL_SLD_DEV_ANT_ST:N::2:O VL_DEDUCOES_ST:N::2:O VL_ICMS_RECOL_ST:N::2:O VL_SLD_CRED_ST_TRANSPORTAR:N::2:O DEB_ESP_ST:N::2:O`),
  "E500": fields("REG:C:4::O IND_APUR:C:1::O DT_INI:D:8::O DT_FIN:D:8::O"),
  "E510": fields("REG:C:4::O CFOP:N:4::O CST_IPI:C:2::O VL_CONT_IPI:N::2:O VL_BC_IPI:N::2:O VL_IPI:N::2:O"),
  "E520": fields("REG:C:4::O VL_SD_ANT_IPI:N::2:O VL_DEB_IPI:N::2:O VL_CRED_IPI:N::2:O VL_OD_IPI:N::2:O VL_OC_IPI:N::2:O VL_SC_IPI:N::2:O VL_SD_IPI:N::2:O"),
  "E990": fields("REG:C:4::O QTD_LIN_E:N::O"),
  "G001": fields("REG:C:4::O IND_MOV:C:1::O"),
  "G990": fields("REG:C:4::O QTD_LIN_G:N::O"),
  "H001": fields("REG:C:4::O IND_MOV:C:1::O"),
  "H005": fields("REG:C:4::O DT_INV:D:8::O VL_INV:N::2:O MOT_INV:C:2::O"),
  "H010": fields("REG:C:4::O COD_ITEM:C:60::O UNID:C:6::O QTD:N::3:O VL_UNIT:N::6:O VL_ITEM:N::2:O IND_PROP:C:1::O COD_PART:C:60 TXT_COMPL:C COD_CTA:C VL_ITEM_IR:N::2"),
  "H990": fields("REG:C:4::O QTD_LIN_H:N::O"),
  "K001": fields("REG:C:4::O IND_MOV:C:1::O"),
  "K990": fields("REG:C:4::O QTD_LIN_K:N::O"),
  "1001": fields("REG:C:4::O IND_MOV:C:1::O"),
  "1010": fields(`REG:C:4::O IND_EXP:C:1::O IND_CCRF:C:1::O IND_COMB:C:1::O IND_USINA:C:1::O IND_VA:C:1::O IND_EE:C:1::O IND_CART:C:1::O IND_FORM:C:1::O IND_AER:C:1::O
    IND_GIAF1:C:1::O IND_GIAF3:C:1::O IND_GIAF4:C:1::O IND_REST_RESSARC_COMPL_ICMS:C:1::O`),
  "1990": fields("REG:C:4::O QTD_LIN_1:N::O"),
  "9001": fields("REG:C:4::O IND_MOV:C:1::O"),
  "9900": fields("REG:C:4::O REG_BLC:C:4::O QTD_REG_BLC:N::O"),
  "9990": fields("REG:C:4::O QTD_LIN_9:N::O"),
  "9999": fields("REG:C:4::O QTD_LIN:N::O"),
});

// ---------------------------------------------------------------------------
// EFD-Contribuições (leiaute 006)

const C100 = EFD_ICMS_IPI_LAYOUT["C100"];
export const EFD_CONTRIBUICOES_LAYOUT: Readonly<Record<string, FieldSpec[]>> = Object.freeze({
  "0000": fields("REG:C:4::O COD_VER:N:3::O TIPO_ESCRIT:N:1::O IND_SIT_ESP:N:1 NUM_REC_ANTERIOR:C:41 DT_INI:D:8::O DT_FIN:D:8::O NOME:C:100::O CNPJ:C:14::O UF:C:2::O COD_MUN:N:7::O SUFRAMA:C:9 IND_NAT_PJ:N:2 IND_ATIV:N:1::O"),
  "0001": fields("REG:C:4::O IND_MOV:N:1::O"),
  "0100": EFD_ICMS_IPI_LAYOUT["0100"],
  "0110": fields("REG:C:4::O COD_INC_TRIB:N:1::O IND_APRO_CRED:N:1 COD_TIPO_CONT:N:1 IND_REG_CUM:N:1"),
  "0140": fields("REG:C:4::O COD_EST:C:60 NOME:C:100::O CNPJ:C:14::O UF:C:2::O IE:C:14 COD_MUN:N:7::O IM:C SUFRAMA:C:9"),
  "0150": EFD_ICMS_IPI_LAYOUT["0150"],
  "0190": EFD_ICMS_IPI_LAYOUT["0190"],
  "0200": fields("REG:C:4::O COD_ITEM:C:60::O DESCR_ITEM:C::O COD_BARRA:C COD_ANT_ITEM:C:60 UNID_INV:C:6 TIPO_ITEM:N:2::O COD_NCM:C:8 EX_IPI:C:3 COD_GEN:N:2 COD_LST:C:5 ALIQ_ICMS:N:6:2"),
  "0400": EFD_ICMS_IPI_LAYOUT["0400"],
  "0990": EFD_ICMS_IPI_LAYOUT["0990"],
  "A001": fields("REG:C:4::O IND_MOV:N:1::O"),
  "A010": fields("REG:C:4::O CNPJ:C:14::O"),
  "A100": fields(`REG:C:4::O IND_OPER:C:1::O IND_EMIT:C:1::O COD_PART:C:60 COD_SIT:N:2::O SER:C:20 SUB:C:20 NUM_DOC:C:128::O CHV_NFSE:C:60 DT_DOC:D:8::O DT_EXE_SERV:D:8
    VL_DOC:N::2:O IND_PGTO:C:1::O VL_DESC:N::2 VL_BC_PIS:N::2:O VL_PIS:N::2:O VL_BC_COFINS:N::2:O VL_COFINS:N::2:O VL_PIS_RET:N::2 VL_COFINS_RET:N::2 VL_ISS:N::2`),
  "A170": fields(`REG:C:4::O NUM_ITEM:N:4::O COD_ITEM:C:60::O DESCR_COMPL:C VL_ITEM:N::2:O VL_DESC:N::2 NAT_BC_CRED:C:2 IND_ORIG_CRED:C:1 CST_PIS:N:2::O VL_BC_PIS:N::2 ALIQ_PIS:N::4
    VL_PIS:N::2 CST_COFINS:N:2::O VL_BC_COFINS:N::2 ALIQ_COFINS:N::4 VL_COFINS:N::2 COD_CTA:C COD_CCUS:C`),
  "A990": fields("REG:C:4::O QTD_LIN_A:N::O"),
  "C001": fields("REG:C:4::O IND_MOV:N:1::O"),
  "C010": fields("REG:C:4::O CNPJ:C:14::O IND_ESCRI:C:1"),
  "C100": C100,
  "C170": EFD_ICMS_IPI_LAYOUT["C170"].slice(0, 37),
  "C175": fields(`REG:C:4::O CFOP:N:4::O VL_OPR:N::2:O VL_DESC:N::2 CST_PIS:N:2::O VL_BC_PIS:N::2 ALIQ_PIS:N::4 QUANT_BC_PIS:N::3 ALIQ_PIS_QUANT:N::4 VL_PIS:N::2
    CST_COFINS:N:2::O VL_BC_COFINS:N::2 ALIQ_COFINS:N::4 QUANT_BC_COFINS:N::3 ALIQ_COFINS_QUANT:N::4 VL_COFINS:N::2 COD_CTA:C INFO_COMPL:C`),
  "C990": fields("REG:C:4::O QTD_LIN_C:N::O"),
  "D001": fields("REG:C:4::O IND_MOV:N:1::O"),
  "D990": fields("REG:C:4::O QTD_LIN_D:N::O"),
  "F001": fields("REG:C:4::O IND_MOV:N:1::O"),
  "F990": fields("REG:C:4::O QTD_LIN_F:N::O"),
  "I001": fields("REG:C:4::O IND_MOV:N:1::O"),
  "I990": fields("REG:C:4::O QTD_LIN_I:N::O"),
  "M001": fields("REG:C:4::O IND_MOV:N:1::O"),
  "M100": fields(`REG:C:4::O COD_CRED:C:3::O IND_CRED_ORI:N:1::O VL_BC_PIS:N::2 ALIQ_PIS:N:8:4 QUANT_BC_PIS:N::3 ALIQ_PIS_QUANT:N::4 VL_CRED:N::2:O VL_AJUS_ACRES:N::2:O
    VL_AJUS_REDUC:N::2:O VL_CRED_DIF:N::2:O VL_CRED_DISP:N::2:O IND_DESC_CRED:C:1::O VL_CRED_DESC:N::2 SLD_CRED:N::2:O`),
  "M105": fields("REG:C:4::O NAT_BC_CRED:C:2::O CST_PIS:N:2::O VL_BC_PIS_TOT:N::2 VL_BC_PIS_CUM:N::2 VL_BC_PIS_NC:N::2 VL_BC_PIS:N::2 QUANT_BC_PIS_TOT:N::3 QUANT_BC_PIS:N::3 DESC_CRED:C:60"),
  "M200": fields(`REG:C:4::O VL_TOT_CONT_NC_PER:N::2:O VL_TOT_CRED_DESC:N::2:O VL_TOT_CRED_DESC_ANT:N::2:O VL_TOT_CONT_NC_DEV:N::2:O VL_RET_NC:N::2:O VL_OUT_DED_NC:N::2:O VL_CONT_NC_REC:N::2:O
    VL_TOT_CONT_CUM_PER:N::2:O VL_RET_CUM:N::2:O VL_OUT_DED_CUM:N::2:O VL_CONT_CUM_REC:N::2:O VL_TOT_CONT_REC:N::2:O`),
  "M210": fields(`REG:C:4::O COD_CONT:C:2::O VL_REC_BRT:N::2:O VL_BC_CONT:N::2:O VL_AJUS_ACRES_BC_PIS:N::2:O VL_AJUS_REDUC_BC_PIS:N::2:O VL_BC_CONT_AJUS:N::2:O ALIQ_PIS:N:8:4 QUANT_BC_PIS:N::3
    ALIQ_PIS_QUANT:N::4 VL_CONT_APUR:N::2:O VL_AJUS_ACRES:N::2:O VL_AJUS_REDUC:N::2:O VL_CONT_DIFER:N::2 VL_CONT_DIFER_ANT:N::2 VL_CONT_PER:N::2:O`),
  "M500": fields(`REG:C:4::O COD_CRED:C:3::O IND_CRED_ORI:N:1::O VL_BC_COFINS:N::2 ALIQ_COFINS:N:8:4 QUANT_BC_COFINS:N::3 ALIQ_COFINS_QUANT:N::4 VL_CRED:N::2:O VL_AJUS_ACRES:N::2:O
    VL_AJUS_REDUC:N::2:O VL_CRED_DIFER:N::2:O VL_CRED_DISP:N::2:O IND_DESC_CRED:C:1::O VL_CRED_DESC:N::2 SLD_CRED:N::2:O`),
  "M505": fields("REG:C:4::O NAT_BC_CRED:C:2::O CST_COFINS:N:2::O VL_BC_COFINS_TOT:N::2 VL_BC_COFINS_CUM:N::2 VL_BC_COFINS_NC:N::2 VL_BC_COFINS:N::2 QUANT_BC_COFINS_TOT:N::3 QUANT_BC_COFINS:N::3 DESC_CRED:C:60"),
  "M600": fields(`REG:C:4::O VL_TOT_CONT_NC_PER:N::2:O VL_TOT_CRED_DESC:N::2:O VL_TOT_CRED_DESC_ANT:N::2:O VL_TOT_CONT_NC_DEV:N::2:O VL_RET_NC:N::2:O VL_OUT_DED_NC:N::2:O VL_CONT_NC_REC:N::2:O
    VL_TOT_CONT_CUM_PER:N::2:O VL_RET_CUM:N::2:O VL_OUT_DED_CUM:N::2:O VL_CONT_CUM_REC:N::2:O VL_TOT_CONT_REC:N::2:O`),
  "M610": fields(`REG:C:4::O COD_CONT:C:2::O VL_REC_BRT:N::2:O VL_BC_CONT:N::2:O VL_AJUS_ACRES_BC_COFINS:N::2:O VL_AJUS_REDUC_BC_COFINS:N::2:O VL_BC_CONT_AJUS:N::2:O ALIQ_COFINS:N:8:4 QUANT_BC_COFINS:N::3
    ALIQ_COFINS_QUANT:N::4 VL_CONT_APUR:N::2:O VL_AJUS_ACRES:N::2:O VL_AJUS_REDUC:N::2:O VL_CONT_DIFER:N::2 VL_CONT_DIFER_ANT:N::2 VL_CONT_PER:N::2:O`),
  "M990": fields("REG:C:4::O QTD_LIN_M:N::O"),
  "P001": fields("REG:C:4::O IND_MOV:N:1::O"),
  "P990": fields("REG:C:4::O QTD_LIN_P:N::O"),
  "1001": fields("REG:C:4::O IND_MOV:N:1::O"),
  "1990": fields("REG:C:4::O QTD_LIN_1:N::O"),
  "9001": EFD_ICMS_IPI_LAYOUT["9001"],
  "9900": EFD_ICMS_IPI_LAYOUT["9900"],
  "9990": EFD_ICMS_IPI_LAYOUT["9990"],
  "9999": EFD_ICMS_IPI_LAYOUT["9999"],
});

/** Ordem dos blocos em cada arquivo (o validador confere a sequência). */
export const BLOCK_ORDER = Object.freeze({
  efd_icms_ipi: ["0", "B", "C", "D", "E", "G", "H", "K", "1", "9"],
  efd_contribuicoes: ["0", "A", "C", "D", "F", "I", "M", "P", "1", "9"],
});

// ---------------------------------------------------------------------------
// SINTEGRA (Convênio ICMS 57/95): registros de 126 posições.
// Tipo: N número alinhado à direita com zeros (casas implícitas), X texto
// alinhado à esquerda com brancos, D data AAAAMMDD.

export interface FixedField { name: string; type: "N" | "X" | "D"; size: number; decimals: number }
function fixed(spec: string): FixedField[] {
  return spec.trim().split(/\s+/).map((item) => {
    const [name, type, size, decimals] = item.split(":");
    return { name, type: type as FixedField["type"], size: Number(size), decimals: decimals ? Number(decimals) : 0 };
  });
}
export const SINTEGRA_RECORD_SIZE = 126;
export const SINTEGRA_LAYOUT: Readonly<Record<string, FixedField[]>> = Object.freeze({
  "10": fixed("TIPO:N:2 CNPJ:N:14 IE:X:14 NOME:X:35 MUNICIPIO:X:30 UF:X:2 FAX:N:10 DATA_INICIAL:D:8 DATA_FINAL:D:8 COD_CONVENIO:X:1 COD_NATUREZA:X:1 COD_FINALIDADE:X:1"),
  "11": fixed("TIPO:N:2 LOGRADOURO:X:34 NUMERO:N:5 COMPLEMENTO:X:22 BAIRRO:X:15 CEP:N:8 CONTATO:X:28 TELEFONE:N:12"),
  "50": fixed("TIPO:N:2 CNPJ:N:14 IE:X:14 DATA:D:8 UF:X:2 MODELO:N:2 SERIE:X:3 NUMERO:N:6 CFOP:N:4 EMITENTE:X:1 VALOR_TOTAL:N:13:2 BASE_ICMS:N:13:2 VALOR_ICMS:N:13:2 ISENTA:N:13:2 OUTRAS:N:13:2 ALIQUOTA:N:4:2 SITUACAO:X:1"),
  "54": fixed("TIPO:N:2 CNPJ:N:14 MODELO:N:2 SERIE:X:3 NUMERO:N:6 CFOP:N:4 CST:X:3 ITEM:N:3 CODIGO:X:14 QUANTIDADE:N:11:3 VALOR_PRODUTO:N:12:2 DESCONTO:N:12:2 BASE_ICMS:N:12:2 BASE_ST:N:12:2 VALOR_IPI:N:12:2 ALIQUOTA:N:4:2"),
  "61": fixed("TIPO:N:2 BRANCOS1:X:14 BRANCOS2:X:14 DATA:D:8 MODELO:N:2 SERIE:X:3 SUBSERIE:X:2 NUMERO_INICIAL:N:6 NUMERO_FINAL:N:6 VALOR_TOTAL:N:13:2 BASE_ICMS:N:13:2 VALOR_ICMS:N:12:2 ISENTA:N:13:2 OUTRAS:N:13:2 ALIQUOTA:N:4:2 BRANCO:X:1"),
  "61R": fixed("TIPO:N:2 MESTRE:X:1 MES_ANO:N:6 CODIGO:X:14 QUANTIDADE:N:13:3 VALOR:N:16:2 BASE_ICMS:N:16:2 ALIQUOTA:N:4:2 BRANCOS:X:54"),
  "74": fixed("TIPO:N:2 DATA:D:8 CODIGO:X:14 QUANTIDADE:N:13:3 VALOR:N:13:2 POSSE:X:1 CNPJ:N:14 IE:X:14 UF:X:2 BRANCOS:X:45"),
  "75": fixed("TIPO:N:2 DATA_INICIAL:D:8 DATA_FINAL:D:8 CODIGO:X:14 NCM:X:8 DESCRICAO:X:53 UNIDADE:X:6 ALIQ_IPI:N:5:2 ALIQ_ICMS:N:4:2 REDUCAO:N:5:2 BASE_ST:N:13:2"),
});
