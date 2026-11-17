// Etiquetas padrão e o DTO da etiqueta (erp_preferences.label_defaults e
// label_dto), num arquivo leve, sem import de outros domínios: o Catálogo os lê
// pelo public.ts (erp_catalog_contact_labels, sessão P) sem o ciclo do
// rpc/erp_preferences_labels.ts.
import { jsonTimestamp } from "../../engine/time.ts";

const mmDefault = (w: string, h: string, font: string, barcode: string, currency: boolean, showLabels: boolean, columnsGap: string, rowsGap: string) => ({
  width: w,
  height: h,
  font: "helvetica",
  font_size: font,
  barcode,
  barcode_text: true,
  currency,
  show_labels: showLabels,
  columns_gap: columnsGap,
  rows_gap: rowsGap,
});
const PAGE = { size: "A4", width: null, height: null, orientation: "portrait", margin_left: "5", margin_top: "10" };
const field = (f: string, x: string, y: string, size: string, bold: boolean, barcode: boolean) => ({ field: f, x, y, size, bold, barcode });

/** erp_preferences.label_defaults() */
export const labelDefaults = () => [
  {
    id: "padrao-contato",
    type: "contato",
    description: "Etiqueta de contato",
    config: {
      label: mmDefault("100", "40", "9", "c128", false, false, "3", "0"),
      page: PAGE,
      fields: [
        field("nome", "4", "4", "10", true, false),
        field("endereco", "4", "11", "9", false, false),
        field("bairro", "4", "17", "9", false, false),
        field("cidade_uf", "4", "23", "9", false, false),
        field("cep", "4", "29", "9", true, false),
      ],
    },
  },
  {
    id: "padrao-produto",
    type: "produto",
    description: "Etiqueta de produto",
    config: {
      label: mmDefault("50", "30", "8", "ean13", true, false, "2", "2"),
      page: PAGE,
      fields: [field("descricao", "2", "2", "8", true, false), field("preco", "2", "8", "11", true, false), field("gtin", "2", "14", "8", false, true)],
    },
  },
  {
    id: "padrao-nota-fiscal",
    type: "nota_fiscal",
    description: "Etiqueta de nota fiscal",
    config: {
      label: mmDefault("100", "50", "9", "c128", false, true, "3", "0"),
      page: PAGE,
      fields: [
        field("numero", "4", "4", "10", true, false),
        field("serie", "60", "4", "10", false, false),
        field("cliente", "4", "11", "9", false, false),
        field("endereco_cliente", "4", "17", "9", false, false),
        field("cidade_uf", "4", "23", "9", false, false),
        field("chave", "4", "30", "7", false, true),
      ],
    },
  },
  {
    id: "padrao-ordem-servico",
    type: "ordem_servico",
    description: "Etiqueta de ordem de serviço",
    config: {
      label: mmDefault("100", "30", "9", "c128", true, true, "3", "0"),
      page: PAGE,
      fields: [
        field("numero", "4", "4", "10", true, false),
        field("data", "60", "4", "9", false, false),
        field("cliente", "4", "12", "9", false, false),
        field("total", "4", "20", "9", true, false),
      ],
    },
  },
  {
    id: "padrao-pedido-venda",
    type: "pedido_venda",
    description: "Etiqueta de pedido de venda",
    config: {
      label: mmDefault("100", "50", "9", "c128", true, false, "3", "0"),
      page: PAGE,
      fields: [
        field("numero", "4", "4", "10", true, false),
        field("cliente", "4", "11", "9", false, false),
        field("endereco_cliente", "4", "17", "9", false, false),
        field("cidade_uf", "4", "23", "9", false, false),
        field("cep", "4", "29", "9", true, false),
        field("numero", "4", "36", "8", false, true),
      ],
    },
  },
];

/** erp_preferences.label_dto(t) */
export const labelDto = (t: Record<string, unknown>) => ({
  id: t.id,
  type: t.type,
  description: t.description,
  default: false,
  config: JSON.parse(String(t.config)),
  version: Number(t.version),
  updated_at: jsonTimestamp(String(t.updated_at)),
});
