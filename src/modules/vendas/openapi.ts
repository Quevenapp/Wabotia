// OpenAPI dos módulos Vendas e orçamento (docs/VENDAS.md) e Caixa
// (docs/CAIXA.md). Ligado em src/modules/openapi.ts: esquemas, operações e
// descrições.
import {
  MOVE_TYPES,
  PAYMENT_METHODS,
  QUOTE_STATUSES,
  SALE_STATUSES,
} from "./model";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string, description?: string) => ({
  type: [type, "null"],
  ...(description ? { description } : {}),
});
const list = (name: string) => ({
  type: "object",
  properties: {
    data: { type: "array", items: ref(name) },
    next_cursor: { type: ["string", "null"] },
  },
});
const integer = { type: "integer" };
const cents = { type: "integer", minimum: 0 };
const quantity = {
  type: "number",
  description: "Quantidade na unidade do produto, até 3 casas decimais (1.5 kg).",
};

export function vendasSchemas() {
  const customer = {
    type: "object",
    properties: {
      name: { type: "string" },
      phone: nullable("string", "Só com contacts:read (aplicações)."),
      document: nullable("string", "CPF ou CNPJ; só com contacts:read."),
      contact_id: nullable("string"),
      conversation_id: nullable("string"),
    },
  };
  const line = {
    type: "object",
    properties: {
      index: integer,
      product_id: nullable("string", "null: item avulso (serviço, frete)."),
      name: { type: "string" },
      sku: nullable("string"),
      ean: nullable("string"),
      unit: { type: "string" },
      quantity,
      unit_cents: cents,
      gross_cents: cents,
      discount_cents: cents,
      total_cents: cents,
      net_cents: {
        ...cents,
        description: "Total da linha menos a parte do desconto da venda (base das devoluções).",
      },
      returned_quantity: quantity,
      returned_cents: cents,
    },
  };
  const lineInput = {
    type: "object",
    required: ["quantity"],
    properties: {
      product_id: { type: "string" },
      name: { type: "string", maxLength: 120, description: "Item avulso (sem product_id)." },
      quantity,
      unit_cents: {
        ...cents,
        description:
          "Outro preço ou preço do item avulso: administrador na venda; qualquer pessoa da equipe no orçamento.",
      },
      discount_cents: cents,
    },
  };
  const payment = {
    type: "object",
    required: ["method", "amount_cents"],
    properties: {
      method: { enum: [...PAYMENT_METHODS] },
      amount_cents: { type: "integer", minimum: 1 },
    },
  };
  const fiscal = {
    type: "object",
    description:
      "Dados da NF-e/NFC-e, todos opcionais ao salvar. A prévia da nota (GET /vendas/sales/{id}/fiscal) aponta o que falta.",
    properties: {
      ncm: { type: "string", pattern: "^\\d{8}$" },
      cest: { type: "string", pattern: "^\\d{7}$" },
      cfop: { type: "string", pattern: "^[1-7]\\d{3}$" },
      origin: { type: "integer", minimum: 0, maximum: 8 },
      icms_cst: { type: "string", description: "Regime normal." },
      icms_csosn: { type: "string", description: "Simples Nacional." },
      icms_rate: { type: "number" },
      icms_base_reduction: { type: "number" },
      fcp_rate: { type: "number" },
      pis_cst: { type: "string" },
      pis_rate: { type: "number" },
      cofins_cst: { type: "string" },
      cofins_rate: { type: "number" },
      ipi_cst: { type: "string" },
      ipi_rate: { type: "number" },
      tax_unit: { type: "string", maxLength: 6 },
      tax_factor: { type: "number" },
      tax_ean: { type: "string", description: "GTIN da unidade tributável ou SEM GTIN." },
      cbenef: { type: "string" },
      ibs_cbs_cst: { type: "string", pattern: "^\\d{3}$" },
      cclasstrib: { type: "string", pattern: "^\\d{6}$" },
    },
  };
  const productBase = {
    category_id: nullable("string"),
    name: { type: "string", maxLength: 120 },
    description: { type: "string", maxLength: 500 },
    price_cents: cents,
    cost_cents: nullable("integer"),
    unit: { type: "string", maxLength: 6, default: "UN" },
    fractional: { type: "boolean" },
    ean: nullable("string", "GTIN-8/12/13/14 com dígito verificador."),
    sku: nullable("string"),
    photo_media_id: nullable(
      "string",
      "Imagem JPG, PNG ou WebP enviada por POST /profiles/{profile}/media.",
    ),
    active: { type: "boolean" },
    track_stock: { type: "boolean" },
    allow_negative: { type: "boolean" },
    position: { type: "integer", minimum: 0 },
    fiscal: ref("VendasFiscal"),
  };
  return {
    VendasFiscal: fiscal,
    VendasCategory: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        color: nullable("string"),
        position: integer,
        created: integer,
        updated: integer,
      },
    },
    VendasCategoryInput: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", maxLength: 40 },
        color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
        position: integer,
      },
    },
    VendasProduct: {
      type: "object",
      properties: {
        id: { type: "string" },
        ...productBase,
        photo_path: nullable("string", "Caminho da foto (autenticado)."),
        stock: nullable("number", "null sem controle de estoque."),
        min_stock: nullable("number"),
        low_stock: { type: "boolean" },
        out_of_stock: { type: "boolean" },
        created: integer,
        updated: integer,
      },
    },
    VendasProductInput: {
      type: "object",
      required: ["name", "price_cents"],
      properties: {
        ...productBase,
        min_stock: { type: "number" },
        stock: {
          type: "number",
          description: "Só na criação: vira o movimento Saldo inicial.",
        },
      },
    },
    VendasStockMove: {
      type: "object",
      properties: {
        id: { type: "string" },
        product_id: { type: "string" },
        product_name: nullable("string"),
        unit: nullable("string"),
        type: { enum: [...MOVE_TYPES] },
        type_label: { type: "string" },
        quantity: { type: "number", description: "Variação do saldo (negativa nas saídas)." },
        balance: { type: "number", description: "Saldo depois do movimento." },
        ref_type: { enum: ["sale", "return", "manual"] },
        ref_id: nullable("string"),
        cost_cents: nullable("integer"),
        note: { type: "string" },
        actor: { type: "string" },
        created: integer,
      },
    },
    VendasStockMoveInput: {
      type: "object",
      required: ["type", "items"],
      properties: {
        type: {
          enum: ["entrada", "saida", "ajuste"],
          description: "ajuste: quantity é o saldo contado.",
        },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            required: ["product_id", "quantity"],
            properties: {
              product_id: { type: "string" },
              quantity,
              cost_cents: { ...cents, description: "Custo unitário (entrada)." },
            },
          },
        },
        note: { type: "string", maxLength: 300 },
      },
    },
    VendasLine: line,
    VendasLineInput: lineInput,
    VendasPayment: payment,
    VendasQuote: {
      type: "object",
      properties: {
        id: { type: "string" },
        number: integer,
        status: { enum: [...QUOTE_STATUSES] },
        status_label: { type: "string" },
        customer,
        lines: { type: "array", items: ref("VendasLine") },
        item_count: integer,
        subtotal_cents: cents,
        discount_cents: cents,
        total_cents: cents,
        valid_days: nullable("integer"),
        valid_until: nullable("integer"),
        note: { type: "string" },
        notes: { type: "string", description: "Interna; só com notes:read." },
        version: integer,
        sent_at: nullable("integer"),
        sent_via: { type: ["string", "null"], enum: ["buttons", "link", "manual", null] },
        web_step_id: nullable("string"),
        decided_at: nullable("integer"),
        decided_by: nullable("string"),
        decided_via: { type: ["string", "null"], enum: ["whatsapp", "link", "panel", "api", null] },
        decision_note: { type: "string" },
        sale_id: nullable("string"),
        created_by: { type: "string" },
        created: integer,
        updated: integer,
      },
    },
    VendasQuoteInput: {
      type: "object",
      properties: {
        lines: { type: "array", items: ref("VendasLineInput") },
        discount_cents: cents,
        discount_percent: { type: "number", minimum: 0, maximum: 100 },
        conversation_id: nullable("string"),
        customer_name: { type: "string" },
        customer_phone: { type: "string" },
        customer_document: { type: "string" },
        valid_days: nullable("integer"),
        note: { type: "string", maxLength: 1000 },
        notes: { type: "string", maxLength: 2000 },
      },
    },
    VendasQuoteSend: {
      type: "object",
      properties: {
        via: { enum: ["buttons", "link"], default: "buttons" },
        notify: { type: "boolean", default: true },
      },
    },
    VendasQuoteDecision: {
      type: "object",
      required: ["decision"],
      properties: {
        decision: { enum: ["approve", "decline"] },
        note: { type: "string", maxLength: 500 },
      },
    },
    VendasQuoteConvert: {
      type: "object",
      properties: {
        payments: { type: "array", items: ref("VendasPayment") },
        conversation_id: nullable("string"),
        session_id: nullable("string"),
        note: { type: "string" },
        notes: { type: "string" },
      },
    },
    VendasSale: {
      type: "object",
      properties: {
        id: { type: "string" },
        number: integer,
        status: { enum: [...SALE_STATUSES] },
        status_label: { type: "string" },
        source: { enum: ["panel", "caixa", "quote", "api"] },
        quote_id: nullable("string"),
        session_id: nullable("string"),
        customer,
        lines: { type: "array", items: ref("VendasLine") },
        item_count: integer,
        subtotal_cents: cents,
        discount_cents: cents,
        sale_discount_cents: cents,
        total_cents: cents,
        payments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              method: { enum: [...PAYMENT_METHODS] },
              method_label: { type: "string" },
              amount_cents: cents,
            },
          },
        },
        paid_cents: cents,
        change_cents: cents,
        payment: {
          type: ["object", "null"],
          description: "Cobrança do Mercado Pago (pix ou link).",
          properties: {
            id: { type: "string" },
            status: { type: "string" },
            pix_code: nullable("string", "Pix copia e cola, para mostrar o QR na tela do caixa."),
            url: nullable("string"),
          },
        },
        needs_refund: { type: "boolean" },
        refunded_cents: cents,
        fiscal_status: { enum: ["none", "pending", "authorized", "error", "cancelled"] },
        note: { type: "string" },
        notes: { type: "string" },
        created_by: { type: "string" },
        created: integer,
        updated: integer,
        completed_at: nullable("integer"),
        cancelled_at: nullable("integer"),
        cancelled_by: nullable("string"),
        cancel_reason: { type: "string" },
      },
    },
    VendasSaleCreate: {
      type: "object",
      required: ["lines"],
      properties: {
        lines: { type: "array", minItems: 1, maxItems: 200, items: ref("VendasLineInput") },
        discount_cents: cents,
        discount_percent: { type: "number", minimum: 0, maximum: 100 },
        payments: {
          type: "array",
          maxItems: 6,
          items: ref("VendasPayment"),
          description:
            "Soma ≥ total; o que passar é troco e só pode vir de dinheiro. pix ou link (Mercado Pago): sozinhos, com o total e conversation_id.",
        },
        customer_name: { type: "string" },
        customer_phone: { type: "string" },
        customer_document: { type: "string", description: "CPF ou CNPJ (nota)." },
        conversation_id: { type: "string" },
        note: { type: "string", maxLength: 500 },
        notes: { type: "string", maxLength: 2000 },
      },
    },
    VendasSaleCancel: {
      type: "object",
      properties: { reason: { type: "string", maxLength: 300 } },
    },
    VendasSaleReturn: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["index", "quantity"],
            properties: { index: integer, quantity },
          },
          description: "Sem items, devolve tudo o que falta.",
        },
        method: { enum: [...PAYMENT_METHODS] },
        reason: { type: "string", maxLength: 300 },
      },
    },
    VendasReturn: {
      type: "object",
      properties: {
        id: { type: "string" },
        sale_id: { type: "string" },
        session_id: nullable("string"),
        lines: { type: "array", items: { type: "object" } },
        amount_cents: cents,
        method: { enum: [...PAYMENT_METHODS] },
        method_label: { type: "string" },
        reason: { type: "string" },
        actor: { type: "string" },
        created: integer,
      },
    },
    VendasReturnResult: {
      type: "object",
      properties: { sale: ref("VendasSale"), return: ref("VendasReturn") },
    },
    VendasReceipt: {
      type: "object",
      properties: {
        columns: { enum: [32, 42, 48] },
        establishment: ref("Establishment"),
        sale: ref("VendasSale"),
        quote: ref("VendasQuote"),
        text: { type: "string", description: "Texto pronto em colunas fixas (comprovante não fiscal)." },
      },
    },
    VendasFiscalPreview: {
      type: "object",
      properties: {
        model: { enum: ["nfce", "nfe"] },
        ready: { type: "boolean" },
        provider: { type: ["object", "null"] },
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              message: { type: "string" },
              line: integer,
              product_id: nullable("string"),
            },
          },
        },
        document: { type: "object", description: "Documento neutro (leiaute 4.00): emitter, recipient, items, totals, payments (tPag)." },
      },
    },
    VendasFiscalEmit: {
      type: "object",
      properties: {
        model: { enum: ["nfce", "nfe"], default: "nfce" },
        recipient: { type: "object", description: "NF-e: document, name, ie, email, address{street, number, district, city, city_code, uf, cep}." },
      },
    },
    VendasFiscalDocument: {
      type: "object",
      properties: {
        id: { type: "string" },
        sale_id: { type: "string" },
        model: { enum: ["nfce", "nfe"] },
        environment: { enum: ["homologacao", "producao"] },
        series: nullable("integer"),
        number: nullable("integer"),
        status: { enum: ["pending", "processing", "authorized", "rejected", "cancelled", "error"] },
        provider: { type: "string" },
        access_key: nullable("string"),
        protocol: nullable("string"),
        pdf_url: nullable("string"),
        xml_url: nullable("string"),
        message: { type: "string" },
        created: integer,
        updated: integer,
      },
    },
    VendasGrid: {
      type: "object",
      properties: {
        categories: { type: "array", items: ref("VendasCategory") },
        products: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              category_id: nullable("string"),
              name: { type: "string" },
              price_cents: cents,
              unit: { type: "string" },
              fractional: { type: "boolean" },
              ean: nullable("string"),
              sku: nullable("string"),
              photo_media_id: nullable("string"),
              photo_path: nullable("string"),
              track_stock: { type: "boolean" },
              stock: nullable("number"),
              low_stock: { type: "boolean" },
              out_of_stock: { type: "boolean" },
              position: integer,
            },
          },
        },
        generated_at: integer,
      },
    },
    CaixaRegister: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        active: { type: "boolean" },
        position: integer,
        session: { type: ["object", "null"], description: "Sessão aberta: id, number, opened_by, opened_at, opening_cents." },
        created: integer,
        updated: integer,
      },
    },
    CaixaRegisterInput: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", maxLength: 40 },
        active: { type: "boolean" },
        position: integer,
      },
    },
    CaixaOpen: {
      type: "object",
      properties: {
        opening_cents: { ...cents, description: "Troco inicial." },
        note: { type: "string", maxLength: 300 },
      },
    },
    CaixaMoveInput: {
      type: "object",
      required: ["kind", "amount_cents"],
      properties: {
        kind: { enum: ["withdrawal", "supply"], description: "Sangria ou suprimento." },
        amount_cents: { type: "integer", minimum: 1 },
        note: { type: "string", maxLength: 300 },
      },
    },
    CaixaMove: {
      type: "object",
      properties: {
        id: { type: "string" },
        session_id: { type: "string" },
        kind: { enum: ["withdrawal", "supply"] },
        kind_label: { type: "string" },
        amount_cents: cents,
        note: { type: "string" },
        actor: { type: "string" },
        created: integer,
      },
    },
    CaixaReturnInput: {
      type: "object",
      required: ["sale_id"],
      properties: {
        sale_id: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["index", "quantity"],
            properties: { index: integer, quantity },
          },
          description: "Sem items, devolve tudo o que falta.",
        },
        method: { enum: [...PAYMENT_METHODS] },
        reason: { type: "string" },
      },
    },
    CaixaClose: {
      type: "object",
      required: ["counted_cents"],
      properties: {
        counted_cents: { ...cents, description: "Dinheiro contado na gaveta." },
        note: { type: "string", maxLength: 500 },
      },
    },
    CaixaSummary: {
      type: "object",
      properties: {
        opening_cents: cents,
        supplies_cents: cents,
        withdrawals_cents: cents,
        sales: { type: "object" },
        by_method: { type: "array", items: { type: "object" } },
        change_cents: cents,
        returns: { type: "object" },
        cash: {
          type: "object",
          properties: {
            sales_cents: integer,
            returns_cents: integer,
            expected_cents: integer,
          },
        },
      },
    },
    CaixaSession: {
      type: "object",
      properties: {
        id: { type: "string" },
        number: integer,
        register_id: { type: "string" },
        register_name: nullable("string"),
        status: { enum: ["open", "closed"] },
        opened_by: { type: "string" },
        opened_at: integer,
        opening_cents: cents,
        closed_by: nullable("string"),
        closed_at: nullable("integer"),
        counted_cents: nullable("integer"),
        expected_cash_cents: nullable("integer"),
        difference_cents: nullable("integer"),
        summary: { anyOf: [ref("CaixaSummary"), { type: "null" }] },
      },
    },
  };
}

const read = "conversations:read",
  write = "conversations:write",
  billing = "billing:write";
const v = "/profiles/{profile}/vendas";
const cx = "/profiles/{profile}/caixa";

export const vendasOperations: [string, string, string, string?, string?][] = [
  ["get", v, "Vendas: regras, formas de pagamento e contadores", read],
  ["get", `${v}/categories`, "Vendas: categorias do catálogo", read],
  ["post", `${v}/categories`, "Vendas: criar categoria", "", "VendasCategoryInput"],
  ["put", `${v}/categories/{id}`, "Vendas: alterar categoria", "", "VendasCategoryInput"],
  ["delete", `${v}/categories/{id}`, "Vendas: excluir categoria", ""],
  ["get", `${v}/products`, "Vendas: produtos", read],
  ["post", `${v}/products`, "Vendas: criar produto", "", "VendasProductInput"],
  ["get", `${v}/products/{id}`, "Vendas: produto", read],
  ["put", `${v}/products/{id}`, "Vendas: alterar produto", "", "VendasProductInput"],
  ["delete", `${v}/products/{id}`, "Vendas: arquivar ou excluir produto", ""],
  ["get", `${v}/lookup`, "Vendas: produto pelo código de barras ou SKU", read],
  ["get", `${v}/catalog`, "Vendas: catálogo sem custo nem saldo (bots)", read],
  ["get", `${v}/stock/moves`, "Vendas: movimentos de estoque", read],
  ["post", `${v}/stock/moves`, "Vendas: entrada, saída ou ajuste de estoque", write, "VendasStockMoveInput"],
  ["get", `${v}/quotes`, "Vendas: orçamentos", read],
  ["post", `${v}/quotes`, "Vendas: criar orçamento", write, "VendasQuoteInput"],
  ["get", `${v}/quotes/{id}`, "Vendas: orçamento", read],
  ["put", `${v}/quotes/{id}`, "Vendas: alterar orçamento", write, "VendasQuoteInput"],
  ["get", `${v}/quotes/{id}/print`, "Vendas: orçamento para imprimir", read],
  ["post", `${v}/quotes/{id}/send`, "Vendas: enviar orçamento ao cliente", write, "VendasQuoteSend"],
  ["post", `${v}/quotes/{id}/decision`, "Vendas: registrar aprovação ou recusa", write, "VendasQuoteDecision"],
  ["post", `${v}/quotes/{id}/convert`, "Vendas: converter orçamento em venda", billing, "VendasQuoteConvert"],
  ["post", `${v}/quotes/{id}/cancel`, "Vendas: cancelar orçamento", write, "VendasSaleCancel"],
  ["get", `${v}/sales`, "Vendas: vendas", read],
  ["post", `${v}/sales`, "Vendas: registrar venda", billing, "VendasSaleCreate"],
  ["get", `${v}/sales/{id}`, "Vendas: venda com devoluções e notas", read],
  ["get", `${v}/sales/{id}/receipt`, "Vendas: comprovante não fiscal", read],
  ["post", `${v}/sales/{id}/cancel`, "Vendas: cancelar venda", billing, "VendasSaleCancel"],
  ["post", `${v}/sales/{id}/return`, "Vendas: devolução parcial ou total", billing, "VendasSaleReturn"],
  ["get", `${v}/sales/{id}/fiscal`, "Vendas: prévia da nota fiscal e pendências", read],
  ["post", `${v}/sales/{id}/fiscal/emit`, "Vendas: emitir nota fiscal pelo emissor", billing, "VendasFiscalEmit"],
  ["get", `${v}/fiscal`, "Vendas: emitente, emissores e catálogo sem NCM", read],
  ["get", `${v}/conversations/{id}`, "Vendas: orçamentos do cliente da conversa (bot)", read],
  ["get", cx, "Caixa: caixas, sessões abertas e formas de pagamento", read],
  ["post", `${cx}/registers`, "Caixa: criar caixa", "", "CaixaRegisterInput"],
  ["put", `${cx}/registers/{id}`, "Caixa: alterar caixa", "", "CaixaRegisterInput"],
  ["post", `${cx}/registers/{id}/open`, "Caixa: abrir com troco inicial", billing, "CaixaOpen"],
  ["get", `${cx}/grid`, "Caixa: grade de produtos para venda por toque", read],
  ["get", `${cx}/lookup`, "Caixa: produto pelo código de barras ou SKU", read],
  ["get", `${cx}/sessions`, "Caixa: sessões", read],
  ["get", `${cx}/sessions/{id}`, "Caixa: sessão com resumo, movimentos e vendas", read],
  ["get", `${cx}/sessions/{id}/report`, "Caixa: relatório de fechamento para imprimir", read],
  ["post", `${cx}/sessions/{id}/sales`, "Caixa: vender", billing, "VendasSaleCreate"],
  ["post", `${cx}/sessions/{id}/moves`, "Caixa: sangria ou suprimento", billing, "CaixaMoveInput"],
  ["post", `${cx}/sessions/{id}/returns`, "Caixa: devolução com dinheiro do caixa", billing, "CaixaReturnInput"],
  ["post", `${cx}/sessions/{id}/close`, "Caixa: fechar com o dinheiro contado", billing, "CaixaClose"],
];

/** Descrições, parâmetros e respostas das rotas de Vendas e Caixa. */
export function describeVendasOperation(
  path: string,
  method: string,
  entry: any,
  success: any,
) {
  const caixa = path.startsWith(cx);
  entry.tags = [caixa ? "Caixa" : "Vendas"];
  entry.description += caixa
    ? " Módulo Caixa (caixa), que depende de Vendas; desligado, 409 module_disabled. Abrir, vender, sangria, suprimento, devolução e fechar: administrador ou pessoa com o papel caixa:cashier (sem ele, 403 role_required); aplicação, com billing:write. GET /caixa diz em can_operate se quem chama pode operar."
    : " Módulo Vendas e orçamento (vendas); desligado, 409 module_disabled.";
  const schema = (value: any) =>
    (success.content["application/json"].schema = value);
  const query = (name: string, description: string) =>
    entry.parameters.push({ in: "query", name, schema: { type: "string" }, description });
  if (method !== "get" && /\/(categories|products)(\/\{id\})?$|\/registers(\/\{id\})?$/.test(path))
    entry.description += " Somente administradores (sessão de pessoa).";
  if (path === v) return;
  if (path.endsWith("/categories")) return schema(method === "get" ? list("VendasCategory") : ref("VendasCategory"));
  if (path.endsWith("/categories/{id}")) return method === "put" ? schema(ref("VendasCategory")) : undefined;
  if (path.endsWith("/products") && method === "get") {
    query("q", "Nome, SKU (contém) ou EAN (igual).");
    query("category_id", "Categoria; none para sem categoria.");
    query("active", "1 (padrão), 0 ou all.");
    query("low", "1: só estoque no mínimo ou abaixo.");
    query("limit", "Até 500 (padrão 100).");
    query("cursor", "next_cursor da página anterior.");
    return schema(list("VendasProduct"));
  }
  if (path.includes("/products")) {
    if (method === "delete") {
      entry.description += " Produto com movimentos, vendas ou orçamentos é arquivado (active=false); senão, excluído.";
      return;
    }
    if (method !== "get")
      entry.description += " EAN ou SKU repetidos: 409 ean_taken ou sku_taken.";
    return schema(ref("VendasProduct"));
  }
  if (path.endsWith("/lookup")) {
    query("code", "EAN lido pelo leitor ou SKU.");
    entry.description += " Sem produto ativo: 404 product_not_found.";
    return schema(ref("VendasProduct"));
  }
  if (path.endsWith("/catalog")) {
    query("q", "Busca.");
    query("category_id", "Categoria.");
    return;
  }
  if (path.endsWith("/stock/moves")) {
    if (method === "get") {
      for (const q of ["product_id", "type", "from", "to", "limit", "cursor"]) query(q, q);
      return schema(list("VendasStockMove"));
    }
    entry.description +=
      " Entrada: qualquer pessoa da equipe; saída e ajuste: administrador; aplicações: billing:write. Saída sem saldo: 409 out_of_stock. O lote é atômico.";
    return;
  }
  if (path.endsWith("/print") || path.endsWith("/receipt")) {
    query("columns", "32 (58 mm), 42 ou 48 (80 mm).");
    entry.description += " Dados estruturados para o ThermalPrinterKit e o texto pronto.";
    return schema(ref("VendasReceipt"));
  }
  if (path.endsWith("/quotes") && method === "get") {
    for (const q of ["status", "conversation_id", "q", "limit", "cursor"]) query(q, q);
    return schema(list("VendasQuote"));
  }
  if (path.endsWith("/send"))
    entry.description +=
      " Fixa a validade (fim do dia em Brasília), sobe a versão e manda ao cliente: o texto com os itens e os botões Aprovar/Recusar (via buttons, padrão) ou o link do passo web (via link). Sem conversa: 409 no_conversation; com notify=false só registra. Publica vendas.quote_sent.";
  if (path.endsWith("/decision"))
    entry.description += " Só orçamento enviado e válido: 409 quote_not_pending ou quote_expired.";
  if (path.endsWith("/convert")) {
    entry.description +=
      " Equipe: só aprovado (409 quote_not_approved); administrador também rascunho, enviado ou vencido. Preços e descontos do orçamento, sem o limite de desconto. Repetir devolve a mesma venda.";
    return schema({ type: "object", properties: { quote: ref("VendasQuote"), sale: ref("VendasSale") } });
  }
  if (path.includes("/quotes")) return schema(ref("VendasQuote"));
  if (path.endsWith("/sales") && method === "get") {
    for (const q of ["status", "source", "session_id", "conversation_id", "q", "from", "to", "limit", "cursor"])
      query(q, q);
    return schema(list("VendasSale"));
  }
  if ((path.endsWith("/sales") || path.endsWith("/sessions/{id}/sales")) && method === "post")
    entry.description +=
      " Numera a venda e baixa o estoque no mesmo lote: sem saldo, nada é gravado (409 out_of_stock). Desconto da equipe acima do limite: 403 discount_limit. Pix ou link do Mercado Pago deixam a venda aguardando pagamento, com o estoque reservado até o webhook (vencida ou cancelada, o estoque volta).";
  if (path.endsWith("/cancel") && path.includes("/sales"))
    entry.description +=
      " Administrador (ou a equipe, com operator_can_cancel). Devolve o estoque restante. Venda de sessão de caixa fechada: 409 session_closed (use devolução).";
  if (path.endsWith("/return") || path.endsWith("/returns")) {
    entry.description += " Devolve o estoque e registra o valor devolvido (proporcional ao desconto).";
    return schema(ref("VendasReturnResult"));
  }
  if (path.endsWith("/fiscal") && path.includes("/sales")) {
    query("model", "nfce (padrão) ou nfe.");
    return schema(ref("VendasFiscalPreview"));
  }
  if (path.endsWith("/fiscal/emit")) {
    entry.description +=
      " Sem emissor configurado: 409 fiscal_provider_not_configured. Com pendências: 409 fiscal_not_ready (veja a prévia).";
    return schema(ref("VendasFiscalDocument"));
  }
  if (path.endsWith("/fiscal")) return;
  if (path.includes("/sales")) return schema(ref("VendasSale"));
  if (path.endsWith("/conversations/{id}")) return;
  // Caixa
  if (path === cx) return;
  if (path.endsWith("/grid")) return schema(ref("VendasGrid"));
  if (path.includes("/registers") && !path.endsWith("/open")) return schema(ref("CaixaRegister"));
  if (path.endsWith("/open")) {
    entry.description += " Um caixa tem no máximo uma sessão aberta: 409 session_open.";
    return schema(ref("CaixaSession"));
  }
  if (path.endsWith("/moves")) {
    entry.description += " Sangria acima do dinheiro esperado: 409 insufficient_cash.";
    return schema(ref("CaixaMove"));
  }
  if (path.endsWith("/close"))
    entry.description += " Quem abriu ou um administrador. Congela o resumo e a diferença (contado − esperado).";
  if (path.endsWith("/report")) {
    query("columns", "32, 42 ou 48.");
    return;
  }
  if (path.endsWith("/sessions")) {
    for (const q of ["register_id", "status", "limit", "cursor"]) query(q, q);
    return schema(list("CaixaSession"));
  }
  if (path.includes("/sessions") && !path.endsWith("/sales")) return schema(ref("CaixaSession"));
  if (path.endsWith("/sales")) return schema(ref("VendasSale"));
}
