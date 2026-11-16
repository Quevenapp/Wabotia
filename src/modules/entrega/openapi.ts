// OpenAPI do módulo Entrega (docs/ENTREGA.md, docs/API.md "Entrega"). Ligado
// em src/modules/openapi.ts: esquemas, operações e descrições.
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string, description?: string) => ({
  type: [type, "null"],
  ...(description ? { description } : {}),
});
const point = {
  type: "object",
  required: ["lat", "lng"],
  properties: {
    lat: { type: "number", minimum: -90, maximum: 90 },
    lng: { type: "number", minimum: -180, maximum: 180 },
  },
};
const appParams = {
  type: "object",
  description:
    "Parâmetros do GPS e do envio, decididos pelo servidor: o app lê a posição a cada sample_seconds e envia o lote a cada upload_seconds (menor perto do destino).",
  properties: {
    sample_seconds: { type: "integer" },
    upload_seconds: { type: "integer" },
    max_batch: { type: "integer" },
    max_accuracy_m: { type: "integer" },
    stale_minutes: { type: "integer" },
  },
};

export function entregaSchemas() {
  return {
    EntregaDelivery: {
      type: "object",
      properties: {
        id: { type: "string" },
        source: { type: "string", enum: ["pedido", "manual"] },
        source_ref: nullable("string", "Id do pedido (source pedido)."),
        label: { type: "string", description: "Pedido nº 12" },
        conversation_id: nullable("string"),
        customer_name: { type: "string" },
        address_text: { type: "string" },
        destination: {
          oneOf: [
            {
              type: "object",
              properties: {
                lat: { type: "number" },
                lng: { type: "number" },
                source: { type: "string", enum: ["app", "panel", "customer"] },
              },
            },
            { type: "null" },
          ],
        },
        courier: {
          oneOf: [
            {
              type: "object",
              properties: { id: { type: "string" }, name: { type: "string" } },
            },
            { type: "null" },
          ],
        },
        status: {
          type: "string",
          enum: ["pending", "assigned", "en_route", "delivered", "cancelled"],
        },
        status_label: { type: "string" },
        position: {
          description:
            "Última posição do entregador, só com a rota em andamento (en_route).",
          oneOf: [
            {
              type: "object",
              properties: {
                lat: { type: "number" },
                lng: { type: "number" },
                accuracy_m: nullable("number"),
                speed_mps: nullable("number"),
                battery: nullable("integer"),
                at: { type: "integer" },
              },
            },
            { type: "null" },
          ],
        },
        signal: {
          type: ["string", "null"],
          enum: ["ok", "stale", "none", null],
          description: "Só em en_route: ok, stale (sem posição recente) ou none.",
        },
        eta: {
          oneOf: [
            {
              type: "object",
              properties: {
                at: { type: "integer" },
                minutes: { type: "integer" },
                distance_m: nullable("integer", "Linha reta até o destino."),
              },
            },
            { type: "null" },
          ],
        },
        arriving: { type: "boolean" },
        updates_sent: { type: "integer" },
        tracking_step_id: nullable("string"),
        note: { type: "string" },
        cancel_reason: nullable("string"),
        assigned_at: nullable("integer"),
        started_at: nullable("integer"),
        arriving_at: nullable("integer"),
        delivered_at: nullable("integer"),
        cancelled_at: nullable("integer"),
        position_purged: { type: "boolean" },
        created_by: { type: "string" },
        created: { type: "integer" },
        updated: { type: "integer" },
      },
    },
    EntregaCreate: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["pedido", "manual"], default: "manual" },
        ref_id: { type: "string", description: "Id do pedido (source pedido)." },
        label: { type: "string", maxLength: 80, description: "source manual" },
        conversation_id: { type: "string", description: "source manual" },
        customer_name: { type: "string", maxLength: 120 },
        address_text: { type: "string", maxLength: 300 },
        destination: point,
        courier_id: {
          type: "string",
          description: 'Pessoa da lista de entregadores, ou "me".',
        },
        note: { type: "string", maxLength: 500 },
      },
    },
    EntregaAssign: {
      type: "object",
      required: ["courier_id"],
      properties: { courier_id: { type: "string" } },
    },
    EntregaStart: {
      type: "object",
      properties: {
        destination: {
          ...point,
          description:
            "Destino geocodificado no aparelho (Geocoder do Android, CLGeocoder do iOS).",
        },
      },
    },
    EntregaDone: {
      type: "object",
      properties: { note: { type: "string", maxLength: 500 } },
    },
    EntregaCancel: {
      type: "object",
      required: ["reason"],
      properties: { reason: { type: "string", maxLength: 300 } },
    },
    EntregaPositions: {
      type: "object",
      required: ["points"],
      properties: {
        points: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            required: ["t", "lat", "lng"],
            properties: {
              t: { type: "integer", description: "Instante da leitura (ms Unix)." },
              lat: { type: "number" },
              lng: { type: "number" },
              accuracy: { type: "number", description: "Metros; acima de 300 é ignorada." },
              speed: { type: "number", description: "m/s" },
            },
          },
        },
        battery: { type: "integer", minimum: 0, maximum: 100 },
      },
    },
    EntregaPositionsResult: {
      type: "object",
      properties: {
        active: {
          type: "boolean",
          description: "false: a rota terminou; o app para o GPS e descarta a fila.",
        },
        status: { type: "string" },
        accepted: { type: "integer" },
        ignored: { type: "integer" },
        last_at: nullable("integer"),
        eta: {
          oneOf: [
            {
              type: "object",
              properties: {
                minutes: { type: "integer" },
                at: { type: "integer" },
                distance_m: { type: "integer" },
              },
            },
            { type: "null" },
          ],
        },
        arriving: { type: "boolean" },
        app: appParams,
      },
    },
    EntregaOverview: {
      type: "object",
      properties: {
        courier: { type: "boolean", description: "Quem pergunta é entregador." },
        couriers: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, name: { type: "string" } },
          },
        },
        app: appParams,
        updates: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["eta", "location", "eta_and_location", "off"] },
            every_minutes: { type: "integer" },
            max: { type: "integer" },
          },
        },
        tracking_link: { type: "boolean" },
        arriving_radius_m: { type: "integer" },
        speed_kmh: { type: "integer" },
        route_provider: { type: "string" },
        retention_hours: { type: "integer" },
      },
    },
  };
}

const read = "conversations:read",
  write = "conversations:write";
const base = "/profiles/{profile}/entrega";

export const entregaOperations: [string, string, string, string?, string?][] = [
  ["get", base, "Entrega: parâmetros do app e entregadores", read],
  ["get", `${base}/deliveries`, "Entrega: lista de entregas", read],
  ["get", `${base}/deliveries/{id}`, "Entrega: detalhe com histórico", read],
  ["get", `${base}/mine`, "Entrega: entregas do entregador (app)", read],
  [
    "get",
    `${base}/available`,
    "Entrega: pedidos com entrega ainda sem entrega aberta",
    read,
  ],
  ["post", `${base}/deliveries`, "Entrega: criar entrega", write, "EntregaCreate"],
  [
    "post",
    `${base}/deliveries/{id}/assign`,
    "Entrega: atribuir ou assumir",
    write,
    "EntregaAssign",
  ],
  [
    "post",
    `${base}/deliveries/{id}/destination`,
    "Entrega: marcar o destino no mapa",
    write,
    "EntregaStart",
  ],
  [
    "post",
    `${base}/deliveries/{id}/start`,
    "Entrega: sair para a entrega (iniciar a rota)",
    write,
    "EntregaStart",
  ],
  [
    "post",
    `${base}/deliveries/{id}/positions`,
    "Entrega: lote de posições do entregador",
    "",
    "EntregaPositions",
  ],
  [
    "post",
    `${base}/deliveries/{id}/delivered`,
    "Entrega: concluir (entregue)",
    write,
    "EntregaDone",
  ],
  [
    "post",
    `${base}/deliveries/{id}/cancel`,
    "Entrega: cancelar",
    write,
    "EntregaCancel",
  ],
];

export function describeEntregaOperation(
  path: string,
  method: string,
  entry: any,
  success: any,
) {
  entry.tags = ["Entrega"];
  entry.description +=
    " Módulo Entrega (entrega); desligado, 409 module_disabled. Aplicação sem contacts:read não recebe cliente, endereço, destino nem posição. Veja docs/ENTREGA.md.";
  const schema = (value: any) =>
    (success.content["application/json"].schema = value);
  if (path === base) return schema(ref("EntregaOverview"));
  if (path.endsWith("/positions")) {
    // A destination usa o mesmo corpo que start: {lat,lng} vai no topo.
    entry.description +=
      " Só o entregador da entrega (sessão de pessoa), só com a rota iniciada. Rota de telemetria: fora da fila de comandos, sem Idempotency-Key; pontos repetidos ou mais velhos que a última posição são ignorados, então repetir o mesmo lote é seguro. Uma escrita no banco por lote. Com active=false, a entrega terminou: pare o GPS e descarte a fila. Leia a posição a cada app.sample_seconds e envie a cada app.upload_seconds (a resposta pode mudar os dois).";
    return schema(ref("EntregaPositionsResult"));
  }
  if (path.endsWith("/destination"))
    entry.description +=
      ' Corpo {"lat":…,"lng":…} no topo. O entregador marca pelo app (geocodificação no aparelho) ou a equipe pelo painel.';
  if (path.endsWith("/start"))
    entry.description +=
      " Só o entregador atribuído. No Pedido, o pedido vai para Saiu para entrega (o Pedido avisa o cliente) e o cliente recebe o botão Acompanhar; sem destino, recebe também o pedido de localização. Publica entrega.started.";
  if (path.endsWith("/delivered"))
    entry.description +=
      " O entregador ou a equipe. No Pedido, o pedido vai para Entregue (pedido_error traz o motivo se o Pedido recusar). Publica entrega.delivered.";
  if (path.endsWith("/cancel"))
    entry.description +=
      " O entregador ou a equipe. Avisa o cliente se ele já recebeu o aviso de saída; o pedido do Pedido não muda. Publica entrega.cancelled.";
  if (path.endsWith("/assign"))
    entry.description +=
      ' Antes da saída. "me" assume a entrega (entregador da lista).';
  if (method === "post" && path.endsWith("/deliveries"))
    entry.description +=
      " source pedido: ref_id do pedido com entrega (recebido, em preparo ou saiu para entrega); um pedido só tem uma entrega aberta (409 delivery_exists).";
  if (path.endsWith("/deliveries") && method === "get") {
    entry.parameters.push(
      ...["status", "open", "courier", "conversation_id", "limit"].map(
        (name) => ({ in: "query", name, schema: { type: "string" } }),
      ),
    );
    return schema({
      type: "object",
      properties: { data: { type: "array", items: ref("EntregaDelivery") } },
    });
  }
  if (path.endsWith("/available") || path.endsWith("/mine")) return;
  schema(ref("EntregaDelivery"));
}
