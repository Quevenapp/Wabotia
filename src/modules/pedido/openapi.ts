// OpenAPI do módulo Pedido (docs/PEDIDO.md, docs/API.md "Pedido"). Ligado em
// src/modules/openapi.ts: esquemas, operações e descrições.

const ORDER_STATUSES = [
  "awaiting_payment",
  "received",
  "preparing",
  "ready",
  "out_for_delivery",
  "delivered",
  "cancelled",
];
const PAYMENT_STATUSES = [
  "choosing",
  "pending",
  "awaiting",
  "paid",
  "expired",
  "failed",
  "refunded",
  "cancelled",
];
const METHODS = ["pix", "link", "cash", "card"];
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string, description?: string) => ({
  type: [type, "null"],
  ...(description ? { description } : {}),
});

export function pedidoSchemas() {
  const option = {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string", maxLength: 60 },
      price_cents: { type: "integer", minimum: 0 },
      available: { type: "boolean" },
    },
  };
  return {
    PedidoCategory: {
      type: "object",
      properties: {
        id: { type: "string", readOnly: true },
        name: { type: "string", maxLength: 60 },
        description: { type: "string", maxLength: 300 },
        position: { type: "integer", minimum: 0 },
        created: { type: "integer", readOnly: true },
        updated: { type: "integer", readOnly: true },
      },
    },
    PedidoCategoryInput: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", maxLength: 60 },
        description: { type: "string", maxLength: 300 },
        position: { type: "integer", minimum: 0, maximum: 10000 },
      },
    },
    PedidoItem: {
      type: "object",
      properties: {
        id: { type: "string", readOnly: true },
        category_id: { type: "string" },
        name: { type: "string", maxLength: 80 },
        description: { type: "string", maxLength: 300 },
        price_cents: { type: "integer", minimum: 0, maximum: 10000000 },
        photo_media_id: nullable(
          "string",
          "Foto JPG ou PNG enviada por POST /profiles/{profile}/media; leia em /media/{id}/content.",
        ),
        image_url: nullable(
          "string",
          "Foto pública HTTPS mostrada na página do carrinho.",
        ),
        available: {
          type: "boolean",
          description: "false: esgotado (aparece sem poder pedir).",
        },
        max_quantity: { type: "integer", minimum: 1, maximum: 99 },
        retailer_id: nullable(
          "string",
          "product_retailer_id do catálogo da Meta; único na área.",
        ),
        position: { type: "integer" },
        group_ids: {
          type: "array",
          items: { type: "string" },
          description: "Grupos de adicionais, na ordem mostrada (até 10).",
        },
        created: { type: "integer", readOnly: true },
        updated: { type: "integer", readOnly: true },
      },
    },
    PedidoItemInput: {
      type: "object",
      description:
        "No PUT, os campos ausentes continuam como estão. group_ids, quando enviado, substitui a lista.",
      required: ["category_id", "name", "price_cents"],
      properties: {
        category_id: { type: "string" },
        name: { type: "string", maxLength: 80 },
        description: { type: "string", maxLength: 300 },
        price_cents: { type: "integer", minimum: 0, maximum: 10000000 },
        photo_media_id: nullable("string"),
        image_url: nullable("string"),
        available: { type: "boolean" },
        max_quantity: { type: "integer", minimum: 1, maximum: 99 },
        retailer_id: nullable("string"),
        position: { type: "integer", minimum: 0, maximum: 10000 },
        group_ids: { type: "array", items: { type: "string" }, maxItems: 10 },
      },
    },
    PedidoGroup: {
      type: "object",
      description:
        "Grupo de adicionais reutilizável. min 1 e max 1 é escolha única (ponto, tamanho); min 0 deixa opcional.",
      properties: {
        id: { type: "string", readOnly: true },
        name: { type: "string", maxLength: 60 },
        min: { type: "integer", minimum: 0 },
        max: { type: "integer", minimum: 1 },
        options: { type: "array", items: option, minItems: 1, maxItems: 30 },
        created: { type: "integer", readOnly: true },
        updated: { type: "integer", readOnly: true },
      },
    },
    PedidoGroupInput: {
      type: "object",
      required: ["name", "options"],
      properties: {
        name: { type: "string", maxLength: 60 },
        min: { type: "integer", minimum: 0, default: 0 },
        max: { type: "integer", minimum: 1, default: 1 },
        options: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: {
            type: "object",
            required: ["name"],
            properties: {
              id: {
                type: "string",
                description:
                  "Mantenha o id para editar; sem id, o servidor cria.",
              },
              name: { type: "string", maxLength: 60 },
              price_cents: { type: "integer", minimum: 0, default: 0 },
              available: { type: "boolean" },
            },
          },
        },
      },
    },
    PedidoMenu: {
      type: "object",
      properties: {
        categories: {
          type: "array",
          items: {
            allOf: [
              ref("PedidoCategory"),
              {
                type: "object",
                properties: {
                  items: { type: "array", items: ref("PedidoItem") },
                },
              },
            ],
          },
        },
        groups: { type: "array", items: ref("PedidoGroup") },
        images: {
          type: "array",
          items: {
            type: "object",
            properties: {
              media_id: { type: "string" },
              caption: { type: "string" },
              position: { type: "integer" },
              name: { type: "string" },
              type: { type: "string" },
            },
          },
        },
      },
    },
    PedidoMenuImages: {
      type: "object",
      required: ["images"],
      properties: {
        images: {
          type: "array",
          maxItems: 10,
          items: {
            type: "object",
            required: ["media_id"],
            properties: {
              media_id: {
                type: "string",
                description: "Imagem JPG/PNG ou PDF enviada por POST /media.",
              },
              caption: { type: "string", maxLength: 300 },
            },
          },
        },
      },
    },
    PedidoAvailability: {
      type: "object",
      required: ["available"],
      properties: { available: { type: "boolean" } },
    },
    PedidoOptionAvailability: {
      type: "object",
      required: ["option_id", "available"],
      properties: {
        option_id: { type: "string" },
        available: { type: "boolean" },
      },
    },
    PedidoPause: {
      type: "object",
      required: ["paused"],
      properties: {
        paused: { type: "boolean" },
        message: {
          type: "string",
          maxLength: 300,
          description: 'Texto opcional ao cliente ("Voltamos às 19h").',
        },
      },
    },
    PedidoOverview: {
      type: "object",
      properties: {
        config: {
          type: "object",
          description:
            "Chave pedido de PUT /settings, já com os padrões: store_name, hours [{weekday 0-6, start, end}] em Brasília, pickup, delivery, delivery_fee_cents, minimum_cents, pickup_minutes, delivery_minutes, pickup_address, payments {pix, link, cash, card}, pay_before_prepare, payment_minutes, cart_minutes, alerts {received, preparing, ready, out_for_delivery}, texts.",
        },
        store: {
          type: "object",
          properties: {
            open: { type: "boolean" },
            reason: { enum: ["open", "paused", "closed"] },
            paused: { type: "boolean" },
            pause_message: { type: "string" },
            paused_at: nullable("integer"),
            paused_by: nullable("string"),
            closes_at: nullable("integer"),
            opens_at: nullable("integer"),
            message: {
              type: "string",
              description: "Texto que o cliente recebe com a loja fechada.",
            },
            hours_text: { type: "string" },
            eta: { type: "string" },
          },
        },
        payments: {
          type: "object",
          properties: {
            online_ready: {
              type: "boolean",
              description:
                "Cobrança ligada e conta do Mercado Pago configurada.",
            },
            offered: { type: "array", items: { enum: METHODS } },
          },
        },
        menu: {
          type: "object",
          properties: {
            categories: { type: "integer" },
            items: { type: "integer" },
            available_items: { type: "integer" },
          },
        },
      },
    },
    PedidoOrderLine: {
      type: "object",
      properties: {
        item_id: { type: "string" },
        slot: {
          type: "integer",
          description:
            "Montagem do item (0, 1…): o mesmo item_id pode vir em várias linhas com adicionais diferentes. Não agrupe por item_id.",
        },
        name: { type: "string" },
        quantity: { type: "integer" },
        unit_cents: {
          type: "integer",
          description: "Preço do item + adicionais, por unidade.",
        },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              group_id: { type: "string" },
              group: { type: "string" },
              id: { type: "string" },
              name: { type: "string" },
              price_cents: { type: "integer" },
            },
          },
        },
        note: { type: "string" },
        total_cents: { type: "integer" },
      },
    },
    PedidoOrder: {
      type: "object",
      description:
        "Pedido. Valores em centavos; datas em ms (Unix). lines é a cópia do que o cliente confirmou.",
      properties: {
        id: { type: "string" },
        number: {
          type: "integer",
          description: "Sequencial por área de atendimento.",
        },
        status: { enum: ORDER_STATUSES },
        status_label: { type: "string" },
        status_at: { type: "integer", description: "Entrou no estado atual." },
        customer: {
          type: "object",
          properties: {
            name: { type: "string" },
            phone: { type: "string", description: "Só dígitos, com DDI." },
            contact_id: nullable("string"),
            conversation_id: nullable("string"),
          },
        },
        source: { enum: ["cart", "catalog", "panel", "api"] },
        web_step_id: nullable("string"),
        fulfillment: { enum: ["pickup", "delivery"] },
        fulfillment_label: { type: "string" },
        delivery: {
          type: ["object", "null"],
          description:
            "Só no quadro e no detalhe: entregador e previsão de chegada do pedido de entrega, vindos do módulo que acompanha a entrega (Entrega); null sem ele.",
          properties: {
            status: { type: "string" },
            status_label: { type: "string" },
            courier_id: nullable("string"),
            courier_name: nullable("string"),
            eta_at: nullable("integer"),
            eta_minutes: nullable("integer"),
            position_at: nullable("integer"),
          },
        },
        address: {
          type: ["object", "null"],
          properties: {
            street: { type: "string" },
            district: { type: "string" },
            complement: { type: "string" },
            reference: { type: "string" },
          },
        },
        address_text: { type: "string" },
        lines: { type: "array", items: ref("PedidoOrderLine") },
        item_count: { type: "integer" },
        subtotal_cents: { type: "integer" },
        delivery_fee_cents: { type: "integer" },
        total_cents: { type: "integer" },
        note: { type: "string", description: "Observação do cliente." },
        notes: {
          type: "string",
          description:
            "Observações internas; nunca vão ao cliente nem à comanda.",
        },
        eta_minutes: nullable("integer"),
        eta_at: nullable("integer", "Ida para o preparo + tempo estimado."),
        payment: {
          type: "object",
          properties: {
            method: { type: ["string", "null"], enum: [...METHODS, null] },
            method_label: nullable("string"),
            online: { type: "boolean" },
            status: { enum: PAYMENT_STATUSES },
            status_label: { type: "string" },
            payment_id: nullable(
              "string",
              "Cobrança do núcleo (GET /payments/{id}).",
            ),
            due_at: nullable("integer"),
            paid_at: nullable("integer"),
            paid_by: nullable(
              "string",
              "provider (webhook confirmado) ou quem registrou a baixa.",
            ),
            error: nullable("string"),
            change_for_cents: nullable("integer", "Troco para (dinheiro)."),
            needs_refund: {
              type: "boolean",
              description: "Pago depois de cancelado: estornar no provedor.",
            },
          },
        },
        next_statuses: {
          type: "array",
          items: { enum: ORDER_STATUSES },
          description: "Botões a mostrar (POST …/status).",
        },
        cancel_reason: nullable("string"),
        cancelled_by: nullable("string"),
        confirmed_at: nullable("integer"),
        preparing_at: nullable("integer"),
        ready_at: nullable("integer"),
        dispatched_at: nullable("integer"),
        delivered_at: nullable("integer"),
        cancelled_at: nullable("integer"),
        created_by: { type: "string" },
        created: { type: "integer" },
        updated: { type: "integer" },
        history: {
          type: "array",
          description: "Só no detalhe.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              kind: { enum: ["created", "status", "payment", "edit"] },
              from_status: nullable("string"),
              to_status: nullable("string"),
              actor: { type: "string" },
              note: { type: "string" },
              created: { type: "integer" },
            },
          },
        },
      },
    },
    PedidoOrderCreate: {
      type: "object",
      required: ["items"],
      description:
        "Pedido de balcão ou de integração, calculado no servidor com o cardápio atual (sem pedido mínimo e sem conferir o horário).",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 100,
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
                description: '{"<group_id>": ["<option_id>", …]}',
              },
              note: { type: "string", maxLength: 140 },
            },
          },
          description:
            "Repita o item_id para montagens diferentes do mesmo item (até 10).",
        },
        fulfillment: { enum: ["pickup", "delivery"] },
        address: {
          type: "object",
          properties: {
            street: { type: "string" },
            district: { type: "string" },
            complement: { type: "string" },
            reference: { type: "string" },
          },
        },
        delivery_fee_cents: { type: "integer", minimum: 0 },
        customer_name: { type: "string", maxLength: 80 },
        phone: { type: "string", maxLength: 40 },
        conversation_id: { type: "string" },
        payment_method: { enum: METHODS },
        note: { type: "string", maxLength: 300 },
        notes: { type: "string", maxLength: 2000 },
        notify: {
          type: "boolean",
          default: true,
          description: "Com conversa, envia o resumo ao cliente.",
        },
      },
    },
    PedidoOrderUpdate: {
      type: "object",
      properties: {
        notes: { type: "string", maxLength: 2000 },
        customer_name: { type: "string", maxLength: 80 },
        eta_minutes: { type: ["integer", "null"], minimum: 0, maximum: 1440 },
      },
    },
    PedidoStatusChange: {
      type: "object",
      required: ["status"],
      properties: {
        status: { enum: ORDER_STATUSES },
        note: { type: "string", maxLength: 500 },
        reason: {
          type: "string",
          maxLength: 300,
          description: "Cancelamento: motivo enviado ao cliente.",
        },
        notify: { type: "boolean", default: true },
      },
    },
    PedidoPaid: {
      type: "object",
      properties: { note: { type: "string", maxLength: 300 } },
    },
    PedidoPaymentMethod: {
      type: "object",
      required: ["method"],
      properties: { method: { enum: METHODS } },
    },
    PedidoBoard: {
      type: "object",
      properties: {
        generated_at: { type: "integer" },
        store: {
          type: "object",
          properties: {
            open: { type: "boolean" },
            reason: { enum: ["open", "paused", "closed"] },
            paused: { type: "boolean" },
            message: { type: "string" },
          },
        },
        columns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              status: { enum: ORDER_STATUSES.slice(0, 5) },
              label: { type: "string" },
              orders: {
                type: "array",
                items: {
                  allOf: [
                    ref("PedidoOrder"),
                    {
                      type: "object",
                      properties: {
                        minutes_in_status: { type: "integer" },
                        late: {
                          type: "boolean",
                          description:
                            "Passou do alerta do estado ou, esperando pagamento, do prazo.",
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
        today: {
          type: "object",
          properties: {
            since: { type: "integer" },
            orders: { type: "integer" },
            delivered: { type: "integer" },
            cancelled: { type: "integer" },
            total_cents: { type: "integer" },
          },
        },
      },
    },
    PedidoDeliverySlipRequest: {
      type: "object",
      properties: {
        columns: { enum: [32, 42, 48], default: 32 },
      },
    },
    PedidoDeliverySlip: {
      allOf: [
        ref("PedidoTicket"),
        {
          type: "object",
          properties: {
            slip: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  description: "ENTREGA · Pedido nº 12",
                },
                qr: {
                  type: "string",
                  description:
                    "Conteúdo do QR (vale uma leitura; é um acesso: não envie a terceiros para desenhar).",
                },
                lines: { type: "array", items: { type: "string" } },
                expires_at: nullable("integer"),
                delivery_id: nullable("string"),
              },
            },
            slip_text: {
              type: "object",
              description: "Título e linhas já centrados nas colunas.",
              properties: {
                title: { type: "string" },
                lines: { type: "string" },
              },
            },
          },
        },
      ],
    },
    PedidoTicket: {
      type: "object",
      properties: {
        columns: { enum: [32, 42, 48] },
        establishment: ref("Establishment"),
        order: ref("PedidoOrder"),
        text: {
          type: "string",
          description:
            "Comanda pronta em texto monoespaçado, linhas de até `columns` caracteres.",
        },
      },
    },
  };
}

const read = "conversations:read",
  write = "conversations:write";
const base = "/profiles/{profile}/pedido";

export const pedidoOperations: [string, string, string, string?, string?][] = [
  ["get", base, "Pedido: regras da loja, situação e pagamentos", read],
  [
    "get",
    `${base}/conversations/{id}`,
    "Pedido: pedidos em andamento do cliente de uma conversa (bot)",
    read,
  ],
  [
    "post",
    `${base}/store/pause`,
    "Pedido: pausar a loja ou voltar a receber pedidos",
    write,
    "PedidoPause",
  ],
  ["get", `${base}/menu`, "Pedido: cardápio completo", read],
  [
    "get",
    `${base}/itens`,
    "Pedido: itens para o bot montar o pedido, sem preços",
    read,
  ],
  ["get", `${base}/items/{id}`, "Pedido: item do cardápio", read],
  [
    "post",
    `${base}/categories`,
    "Pedido: criar categoria",
    "",
    "PedidoCategoryInput",
  ],
  [
    "put",
    `${base}/categories/{id}`,
    "Pedido: alterar categoria",
    "",
    "PedidoCategoryInput",
  ],
  ["delete", `${base}/categories/{id}`, "Pedido: excluir categoria vazia", ""],
  ["post", `${base}/items`, "Pedido: criar item", "", "PedidoItemInput"],
  ["put", `${base}/items/{id}`, "Pedido: alterar item", "", "PedidoItemInput"],
  ["delete", `${base}/items/{id}`, "Pedido: excluir item", ""],
  [
    "post",
    `${base}/items/{id}/availability`,
    "Pedido: marcar item esgotado ou disponível",
    write,
    "PedidoAvailability",
  ],
  [
    "post",
    `${base}/groups`,
    "Pedido: criar grupo de adicionais",
    "",
    "PedidoGroupInput",
  ],
  [
    "put",
    `${base}/groups/{id}`,
    "Pedido: alterar grupo de adicionais",
    "",
    "PedidoGroupInput",
  ],
  ["delete", `${base}/groups/{id}`, "Pedido: excluir grupo de adicionais", ""],
  [
    "post",
    `${base}/groups/{id}/availability`,
    "Pedido: marcar uma opção esgotada ou disponível",
    write,
    "PedidoOptionAvailability",
  ],
  [
    "put",
    `${base}/menu-images`,
    "Pedido: imagens do cardápio enviadas no WhatsApp",
    "",
    "PedidoMenuImages",
  ],
  ["get", `${base}/board`, "Pedido: quadro da cozinha", read],
  ["get", `${base}/orders`, "Pedido: lista de pedidos", read],
  [
    "post",
    `${base}/orders`,
    "Pedido: registrar pedido (balcão, integração)",
    write,
    "PedidoOrderCreate",
  ],
  ["get", `${base}/orders/{id}`, "Pedido: detalhe com histórico", read],
  [
    "patch",
    `${base}/orders/{id}`,
    "Pedido: observações internas e tempo estimado",
    write,
    "PedidoOrderUpdate",
  ],
  [
    "post",
    `${base}/orders/{id}/status`,
    "Pedido: mudar o estado",
    write,
    "PedidoStatusChange",
  ],
  [
    "post",
    `${base}/orders/{id}/paid`,
    "Pedido: registrar pagamento recebido na hora",
    write,
    "PedidoPaid",
  ],
  [
    "post",
    `${base}/orders/{id}/payment`,
    "Pedido: definir a forma de pagamento",
    write,
    "PedidoPaymentMethod",
  ],
  ["get", `${base}/orders/{id}/ticket`, "Pedido: comanda para imprimir", read],
  [
    "post",
    `${base}/orders/{id}/delivery-slip`,
    "Pedido: via de entrega com o QR do entregador",
    write,
    "PedidoDeliverySlipRequest",
  ],
];

/** Descrições, parâmetros e respostas das rotas do Pedido. */
export function describePedidoOperation(
  path: string,
  method: string,
  entry: any,
  success: any,
) {
  entry.tags = ["Pedido"];
  entry.description +=
    " Módulo Pedido (pedido); desligado, 409 module_disabled.";
  const schema = (value: any) =>
    (success.content["application/json"].schema = value);
  const admin =
    method !== "get" &&
    /\/pedido\/(categories|items|groups)(\/\{id\})?$|\/menu-images$/.test(path);
  if (admin)
    entry.description +=
      " Somente administradores (sessão de pessoa). Os pedidos já feitos guardam uma cópia das linhas e não mudam.";
  if (path === base) return schema(ref("PedidoOverview"));
  if (path.endsWith("/store/pause")) {
    entry.description +=
      " Qualquer pessoa da equipe. Pausada, o item Cardápio responde a mensagem de pausa e carrinhos abertos são recusados ao concluir (pedido.rejected). Publica pedido.store_changed.";
    return;
  }
  if (path.endsWith("/menu")) return schema(ref("PedidoMenu"));
  if (path.endsWith("/itens")) {
    entry.description +=
      " Ferramenta pedido_itens do bot que atende o cliente: categorias com item_id, nome, descrição, disponível, máximo e as escolhas (grupo_id, mínimo, máximo, opções disponíveis). Sem preços: o valor chega ao cliente pelo resumo do módulo (ação pedido_montar), nunca pelo modelo. Liberada para a chave presa à conversa.";
    return schema({ type: "object" });
  }
  if (path.includes("/categories")) {
    if (method === "delete")
      entry.description += " Categoria com itens: 409 category_not_empty.";
    else schema(ref("PedidoCategory"));
    return;
  }
  if (path.includes("/items")) {
    if (path.endsWith("/availability"))
      entry.description +=
        " Qualquer pessoa da equipe (a cozinha). Esgotado aparece no carrinho sem quantidade; um carrinho já aberto com o item é recusado ao concluir.";
    if (method === "post" && path.endsWith("/items"))
      entry.description +=
        " retailer_id repetido na área: 409 retailer_id_taken.";
    if (method !== "delete") schema(ref("PedidoItem"));
    return;
  }
  if (path.includes("/groups")) {
    if (path.endsWith("/availability"))
      entry.description += " Qualquer pessoa da equipe.";
    if (method !== "delete") schema(ref("PedidoGroup"));
    return;
  }
  if (path.endsWith("/menu-images")) return;
  if (path.endsWith("/board")) {
    entry.description +=
      " Uma coluna por estado em andamento (do mais antigo ao mais novo), com minutes_in_status e late; mais a situação da loja e o resumo do dia (Brasília). Os apps podem reler a cada 15 s ou ao receber pedido.* em GET /events.";
    return schema(ref("PedidoBoard"));
  }
  if (path.endsWith("/delivery-slip")) {
    entry.description +=
      " Ao despachar: a comanda e a parte do entregador (QR do acesso sem login) preparada pelo módulo Entrega, que cria a entrega do pedido se ainda não houver. Gerar de novo revoga o QR anterior (vale a última via). Imprima text, depois slip.title, o QR com o conteúdo de slip.qr e slip.lines. Pedido de retirada: 409 not_delivery; entregue ou cancelado: 409 order_closed; sem a Entrega ligada: 409 delivery_unavailable.";
    return schema(ref("PedidoDeliverySlip"));
  }
  if (path.endsWith("/ticket")) {
    entry.description +=
      " Dados do estabelecimento e do pedido para os apps imprimirem pelo ThermalPrinterKit, e o texto pronto em colunas fixas.";
    entry.parameters.push({
      in: "query",
      name: "columns",
      schema: { enum: ["32", "42", "48"], default: "32" },
      description: "32 na bobina de 58 mm, 48 na de 80 mm.",
    });
    return schema(ref("PedidoTicket"));
  }
  if (path.endsWith("/orders") && method === "get") {
    entry.description +=
      " Ordena por número decrescente; next_cursor vai em cursor. counts traz o total por estado da área.";
    entry.parameters.push(
      ...[
        "status",
        "open",
        "q",
        "phone",
        "conversation_id",
        "from",
        "to",
        "limit",
        "cursor",
      ].map((name) => ({ in: "query", name, schema: { type: "string" } })),
    );
    return schema({
      type: "object",
      properties: {
        data: { type: "array", items: ref("PedidoOrder") },
        next_cursor: { type: ["string", "null"] },
        counts: {
          type: "object",
          properties: Object.fromEntries(
            ORDER_STATUSES.map((s) => [s, { type: "integer" }]),
          ),
        },
      },
    });
  }
  if (path.endsWith("/orders") && method === "post")
    entry.description +=
      " Itens e adicionais conferidos com a mesma regra da página de carrinho (mínimo e máximo por grupo, esgotado, quantidade máxima). Com payment_method cash ou card vai direto para o preparo; pix ou link exigem conversation_id e enviam a cobrança.";
  if (path.endsWith("/status"))
    entry.description +=
      " Transições: aguardando pagamento → recebido ou cancelado; recebido → em preparo, pronto (retirada) ou saiu para entrega (entrega), ou cancelado; em preparo → pronto ou saiu para entrega, recebido ou cancelado; pronto ou saiu para entrega → entregue, em preparo ou cancelado. Outras: 409 invalid_transition. Avisa o cliente com o texto do estado (modelo de notificação fora da janela de 24 h). Publica pedido.status_changed.";
  if (path.endsWith("/paid"))
    entry.description +=
      " Pagamento feito na hora (dinheiro, maquininha) ou por fora depois de uma cobrança vencida. Cobrança online aberta: 409 payment_online (só o provedor confirma); já pago: 409 already_paid.";
  if (path.endsWith("/payment"))
    entry.description +=
      " Só com o pedido aguardando a escolha (ou com a cobrança não gerada); senão 409 payment_chosen.";
  schema(ref("PedidoOrder"));
}
