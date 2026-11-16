// OpenAPI do módulo Mesas (docs/MESAS.md, docs/API.md "Mesas"). Ligado em
// src/modules/openapi.ts: esquemas, operações e descrições.

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string, description?: string) => ({
  type: [type, "null"],
  ...(description ? { description } : {}),
});
const TAB_STATUSES = ["open", "closing", "closed", "cancelled", "merged"];
const PAY_METHODS = ["cash", "card", "pix", "other"];

export function mesasSchemas() {
  const table = {
    name: { type: "string", maxLength: 30 },
    kind: {
      enum: ["table", "card"],
      description: "table: mesa; card: comanda individual.",
    },
    section: {
      type: "string",
      maxLength: 40,
      description: "Ambiente (Salão, Varanda).",
    },
    seats: { type: "integer", minimum: 0, maximum: 99 },
    position: { type: "integer", minimum: 0, maximum: 10000 },
  };
  const paymentInput = {
    type: "object",
    required: ["method", "amount_cents"],
    properties: {
      method: { enum: PAY_METHODS },
      amount_cents: {
        type: "integer",
        minimum: 1,
        description: "Nunca mais que o que falta pagar.",
      },
      tendered_cents: {
        type: "integer",
        description: "Dinheiro: quanto o cliente entregou (calcula o troco).",
      },
      note: { type: "string", maxLength: 120 },
    },
  };
  return {
    MesasTable: {
      type: "object",
      properties: { id: { type: "string", readOnly: true }, ...table },
    },
    MesasTableInput: {
      type: "object",
      description:
        "Uma mesa ({name, …}) ou várias de uma vez ({prefix, from, to, …}: Mesa 1 a Mesa 20, até 100), pulando os nomes que já existem.",
      properties: {
        ...table,
        prefix: { type: "string", maxLength: 20, default: "Mesa" },
        from: { type: "integer", minimum: 0 },
        to: { type: "integer", minimum: 0 },
      },
    },
    MesasConfig: {
      type: "object",
      description: 'Chave "mesas" de PUT /settings (administrador).',
      properties: {
        service_percent: {
          type: "number",
          minimum: 0,
          maximum: 20,
          default: 10,
          description: "Taxa de serviço em %, até uma casa decimal; 0 desliga.",
        },
        service_default: {
          type: "boolean",
          default: true,
          description: "As contas novas já saem com a taxa.",
        },
        split_max: { type: "integer", minimum: 2, maximum: 50, default: 20 },
      },
    },
    MesasBillTotals: {
      type: "object",
      description: "Valores em centavos.",
      properties: {
        subtotal_cents: {
          type: "integer",
          description: "Soma dos pedidos não cancelados.",
        },
        service_on: { type: "boolean" },
        service_percent: { type: "number" },
        service_cents: { type: "integer" },
        total_cents: { type: "integer" },
        paid_cents: { type: "integer" },
        due_cents: { type: "integer", description: "Quanto falta pagar." },
        overpaid_cents: {
          type: "integer",
          description:
            "Pago a mais (pedido cancelado depois de um pagamento parcial): devolver ao cliente.",
        },
      },
    },
    MesasTab: {
      type: "object",
      description: "Conta da mesa. Datas em ms (Unix).",
      properties: {
        id: { type: "string" },
        number: {
          type: "integer",
          description: "Sequencial da conta por área.",
        },
        status: {
          enum: TAB_STATUSES,
          description:
            "open: mesa ocupada; closing: conta pedida (mesa fechando); closed: paga; cancelled: aberta por engano; merged: juntada a outra (merged_into).",
        },
        status_label: { type: "string" },
        table: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" } },
        },
        guests: { type: "integer" },
        customer_name: { type: "string" },
        note: { type: "string" },
        waiter_id: nullable("string", "Garçom responsável."),
        bill: ref("MesasBillTotals"),
        item_count: nullable("integer"),
        orders_count: nullable("integer"),
        kitchen_count: nullable(
          "integer",
          "Pedidos ainda na cozinha (recebido, em preparo).",
        ),
        ready_count: nullable("integer", "Pedidos prontos para servir."),
        opened_by: { type: "string" },
        opened_at: { type: "integer" },
        minutes_open: { type: "integer" },
        bill_requested_at: nullable("integer"),
        closed_by: nullable("string"),
        closed_at: nullable("integer"),
        merged_into: nullable("string"),
        cancel_reason: nullable("string"),
        created: { type: "integer" },
        updated: { type: "integer" },
      },
    },
    MesasPayment: {
      type: "object",
      properties: {
        id: { type: "string" },
        tab_id: { type: "string" },
        method: { enum: PAY_METHODS },
        method_label: { type: "string" },
        amount_cents: { type: "integer" },
        tendered_cents: nullable("integer"),
        change_cents: nullable("integer"),
        note: { type: "string" },
        status: { enum: ["ok", "void"] },
        created_by: { type: "string" },
        created: { type: "integer" },
        voided_by: nullable("string"),
        voided_at: nullable("integer"),
        void_reason: nullable("string"),
      },
    },
    MesasTabDetail: {
      allOf: [
        ref("MesasTab"),
        {
          type: "object",
          properties: {
            orders: {
              type: "array",
              description:
                "Pedidos da conta no quadro da cozinha (inclusive cancelados), do mais antigo.",
              items: ref("PedidoOrder"),
            },
            payments: { type: "array", items: ref("MesasPayment") },
            history: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  kind: {
                    type: "string",
                    description:
                      "opened, order, edit, service, bill, reopened, transfer, merge, merged, payment, payment_void, closed, cancelled",
                  },
                  actor: { type: "string" },
                  note: { type: "string" },
                  created: { type: "integer" },
                },
              },
            },
          },
        },
      ],
    },
    MesasOverview: {
      type: "object",
      description: "Mapa das mesas para o garçom.",
      properties: {
        generated_at: { type: "integer" },
        config: ref("MesasConfig"),
        counts: {
          type: "object",
          properties: {
            free: { type: "integer" },
            occupied: { type: "integer" },
            closing: { type: "integer" },
          },
        },
        sections: { type: "array", items: { type: "string" } },
        tables: {
          type: "array",
          items: {
            allOf: [
              ref("MesasTable"),
              {
                type: "object",
                properties: {
                  state: { enum: ["free", "occupied", "closing"] },
                  state_label: { type: "string" },
                  tab: { oneOf: [ref("MesasTab"), { type: "null" }] },
                },
              },
            ],
          },
        },
      },
    },
    MesasBill: {
      type: "object",
      description:
        "Conta para conferir ou imprimir. Com a conta aberta, é a conta parcial.",
      properties: {
        tab: ref("MesasTab"),
        lines: {
          type: "array",
          description:
            "Itens somados: mesmo item, adicionais, observação e preço numa linha.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              options: { type: "array", items: { type: "string" } },
              note: { type: "string" },
              quantity: { type: "integer" },
              unit_cents: { type: "integer" },
              total_cents: { type: "integer" },
            },
          },
        },
        payments: { type: "array", items: ref("MesasPayment") },
        split: {
          type: ["object", "null"],
          properties: {
            people: { type: "integer" },
            of: {
              enum: ["due", "total"],
              description: "due: o que falta (já houve pagamento); total.",
            },
            shares: {
              type: "array",
              items: { type: "integer" },
              description:
                "Parte de cada pessoa; os centavos que sobram vão para as primeiras. A soma bate.",
            },
          },
        },
        establishment: {
          type: "object",
          description: "Como em GET /profiles/{profile}/establishment.",
        },
        columns: { type: "integer" },
        text: {
          type: "string",
          description: "Conta em texto, colunas fixas (só com columns).",
        },
      },
    },
    MesasTabOpen: {
      type: "object",
      required: ["table_id"],
      properties: {
        table_id: { type: "string" },
        guests: { type: "integer", minimum: 0, maximum: 99 },
        customer_name: { type: "string", maxLength: 80 },
        note: { type: "string", maxLength: 300 },
      },
    },
    MesasTabUpdate: {
      type: "object",
      properties: {
        guests: { type: "integer", minimum: 0, maximum: 99 },
        customer_name: { type: "string", maxLength: 80 },
        note: { type: "string", maxLength: 300 },
        service: {
          type: "boolean",
          description: "Taxa de serviço nesta conta.",
        },
        waiter_id: {
          type: "string",
          description: '"me" assume a mesa; outra pessoa, só administrador.',
        },
      },
    },
    MesasOrderSend: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          description:
            "Como em POST /pedido/orders: o mesmo item_id em várias linhas vira várias montagens (slot).",
          items: {
            type: "object",
            required: ["item_id", "quantity"],
            properties: {
              item_id: { type: "string" },
              quantity: { type: "integer", minimum: 1 },
              options: {
                type: "object",
                additionalProperties: {
                  type: "array",
                  items: { type: "string" },
                },
                description: '{"<group_id>": ["<option_id>"]}',
              },
              note: { type: "string", maxLength: 140 },
            },
          },
        },
        note: { type: "string", maxLength: 300 },
      },
    },
    MesasOrderSent: {
      type: "object",
      properties: { tab: ref("MesasTab"), order: ref("PedidoOrder") },
    },
    MesasTransfer: {
      type: "object",
      required: ["table_id"],
      properties: { table_id: { type: "string" } },
    },
    MesasMerge: {
      type: "object",
      description: "A outra conta, pelo id dela ou pela mesa.",
      properties: { tab_id: { type: "string" }, table_id: { type: "string" } },
    },
    MesasPaymentInput: paymentInput,
    MesasPaymentResult: {
      type: "object",
      properties: { payment: ref("MesasPayment"), tab: ref("MesasTab") },
    },
    MesasPaymentVoid: {
      type: "object",
      required: ["reason"],
      properties: { reason: { type: "string", maxLength: 200 } },
    },
    MesasClose: {
      type: "object",
      properties: {
        payments: {
          type: "array",
          maxItems: 10,
          items: paymentInput,
          description: "Os pagamentos que faltam (até 10).",
        },
      },
    },
    MesasCancel: {
      type: "object",
      properties: { reason: { type: "string", maxLength: 200 } },
    },
  };
}

const read = "conversations:read",
  write = "conversations:write";
const base = "/profiles/{profile}/mesas";

export const mesasOperations: [string, string, string, string?, string?][] = [
  ["get", base, "Mesas: mapa das mesas com a conta de cada uma", read],
  [
    "post",
    `${base}/tables`,
    "Mesas: cadastrar mesas ou comandas",
    "",
    "MesasTableInput",
  ],
  ["put", `${base}/tables/{id}`, "Mesas: alterar mesa", "", "MesasTableInput"],
  ["delete", `${base}/tables/{id}`, "Mesas: apagar mesa livre", ""],
  ["get", `${base}/tabs`, "Mesas: contas por estado e período", read],
  [
    "post",
    `${base}/tabs`,
    "Mesas: abrir a conta da mesa",
    write,
    "MesasTabOpen",
  ],
  ["get", `${base}/tabs/{id}`, "Mesas: conta com pedidos e pagamentos", read],
  [
    "patch",
    `${base}/tabs/{id}`,
    "Mesas: pessoas, nome, taxa de serviço e garçom",
    write,
    "MesasTabUpdate",
  ],
  [
    "post",
    `${base}/tabs/{id}/orders`,
    "Mesas: lançar itens e mandar para a cozinha",
    write,
    "MesasOrderSend",
  ],
  [
    "get",
    `${base}/tabs/{id}/bill`,
    "Mesas: conta parcial, dividida e para imprimir",
    read,
  ],
  ["post", `${base}/tabs/{id}/bill`, "Mesas: o cliente pediu a conta", write],
  [
    "post",
    `${base}/tabs/{id}/reopen`,
    "Mesas: reabrir depois de pedir a conta",
    write,
  ],
  [
    "post",
    `${base}/tabs/{id}/transfer`,
    "Mesas: transferir para outra mesa",
    write,
    "MesasTransfer",
  ],
  [
    "post",
    `${base}/tabs/{id}/merge`,
    "Mesas: juntar outra mesa nesta",
    write,
    "MesasMerge",
  ],
  [
    "post",
    `${base}/tabs/{id}/payments`,
    "Mesas: pagamento parcial",
    write,
    "MesasPaymentInput",
  ],
  [
    "post",
    `${base}/payments/{id}/void`,
    "Mesas: desfazer pagamento",
    write,
    "MesasPaymentVoid",
  ],
  [
    "post",
    `${base}/tabs/{id}/close`,
    "Mesas: fechar a conta",
    write,
    "MesasClose",
  ],
  [
    "post",
    `${base}/tabs/{id}/cancel`,
    "Mesas: cancelar conta aberta por engano",
    write,
    "MesasCancel",
  ],
];

/** Descrições, parâmetros e respostas das rotas das Mesas. */
export function describeMesasOperation(
  path: string,
  method: string,
  entry: any,
  success: any,
) {
  entry.tags = ["Mesas"];
  entry.description +=
    " Módulo Mesas (mesas, depende do Pedido); desligado, 409 module_disabled.";
  const schema = (value: any) =>
    (success.content["application/json"].schema = value);
  if (path === base) {
    entry.description +=
      " Mesas e comandas com o estado (livre, ocupada, fechando) e o resumo da conta aberta. Os apps podem reler ao receber mesas.* ou pedido.status_changed em GET /events.";
    return schema(ref("MesasOverview"));
  }
  if (path.includes("/tables")) {
    entry.description += " Somente administradores (sessão de pessoa).";
    if (method === "post")
      entry.description +=
        " Nome repetido numa mesa só: 409 table_name_taken; numa faixa, os repetidos vêm em skipped.";
    if (method === "delete")
      entry.description += " Com conta aberta: 409 table_in_use.";
    if (method === "post")
      return schema({
        type: "object",
        properties: {
          data: { type: "array", items: ref("MesasTable") },
          skipped: { type: "array", items: { type: "string" } },
        },
      });
    if (method === "put") return schema(ref("MesasTable"));
    return;
  }
  if (path.endsWith("/void")) {
    entry.description +=
      " Só com a conta aberta. Publica mesas.payment_voided.";
    return schema(ref("MesasPaymentResult"));
  }
  if (path.endsWith("/tabs") && method === "get") {
    entry.description +=
      " Padrão: as abertas (open,closing). Ordem por número decrescente; next_cursor vai em cursor.";
    entry.parameters.push(
      ...["status", "table_id", "from", "to", "limit", "cursor"].map(
        (name) => ({ in: "query", name, schema: { type: "string" } }),
      ),
    );
    return schema({
      type: "object",
      properties: {
        data: { type: "array", items: ref("MesasTab") },
        next_cursor: { type: ["string", "null"] },
      },
    });
  }
  if (path.endsWith("/tabs") && method === "post") {
    entry.description +=
      " Mesa com conta aberta: 409 table_occupied. A taxa de serviço segue a configuração. Publica mesas.tab_opened.";
    return schema(ref("MesasTab"));
  }
  if (path.endsWith("/orders")) {
    entry.description +=
      " Itens do cardápio do Pedido (esgotado, adicionais mínimo/máximo e quantidade conferidos como no carrinho), valores no servidor. Vira um pedido numerado do Pedido, em Recebido no quadro da cozinha, com fulfillment table e payment.status tab. Conta com a conta pedida volta a open. Repetir a Idempotency-Key devolve o mesmo pedido. Publica mesas.order_sent e pedido.created. Para cancelar um item já enviado, cancele o pedido em POST /pedido/orders/{id}/status.";
    return schema(ref("MesasOrderSent"));
  }
  if (path.endsWith("/bill") && method === "get") {
    entry.parameters.push(
      {
        in: "query",
        name: "split",
        schema: { type: "string" },
        description:
          "Dividir entre N pessoas (2 até split_max): o que falta pagar ou, sem pagamento, o total.",
      },
      {
        in: "query",
        name: "columns",
        schema: { enum: ["32", "42", "48"] },
        description: "Traz o texto para imprimir: 32 (58 mm) ou 48 (80 mm).",
      },
    );
    return schema(ref("MesasBill"));
  }
  if (path.endsWith("/bill"))
    entry.description +=
      " Mesa fica fechando (closing). Publica mesas.bill_requested.";
  if (path.endsWith("/reopen"))
    entry.description += " Publica mesas.tab_reopened.";
  if (path.endsWith("/transfer"))
    entry.description +=
      " Só para mesa livre (ocupada: 409 table_occupied; use juntar). Os pedidos na cozinha passam a mostrar a mesa nova. Publica mesas.tab_transferred.";
  if (path.endsWith("/merge"))
    entry.description +=
      " Pedidos e pagamentos da outra conta passam para esta, as pessoas somam e a outra mesa fica livre (conta merged). Publica mesas.tab_merged.";
  if (path.endsWith("/payments")) {
    entry.description +=
      " Registro da equipe (nada é cobrado online). Mais que o que falta: 409 amount_exceeds_due; nada a pagar: 409 nothing_due. Publica mesas.payment_added.";
    return schema(ref("MesasPaymentResult"));
  }
  if (path.endsWith("/close")) {
    entry.description +=
      " Registra os pagamentos enviados e fecha; se ainda faltar, 409 tab_unpaid sem gravar nada. A mesa fica livre e os pedidos da conta ficam pagos no Pedido. Publica mesas.tab_closed com o total por forma de pagamento.";
    return schema({
      allOf: [
        ref("MesasTab"),
        {
          type: "object",
          properties: {
            payments: { type: "array", items: ref("MesasPayment") },
          },
        },
      ],
    });
  }
  if (path.endsWith("/cancel"))
    entry.description +=
      " Só sem pedido valendo e sem pagamento: 409 tab_not_empty. Publica mesas.tab_cancelled.";
  if (method === "get" && path.endsWith("/tabs/{id}"))
    return schema(ref("MesasTabDetail"));
  if (method === "patch") entry.description += " Publica mesas.tab_updated.";
  schema(ref("MesasTab"));
}
