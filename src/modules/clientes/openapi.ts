// OpenAPI do Cadastro de clientes (docs/CLIENTES.md, docs/API.md "Cadastro
// de clientes"). Ligado em src/modules/openapi.ts.
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string) => ({ type: [type, "null"] });

export function clientesSchemas() {
  const address = {
    type: "object",
    description:
      "Endereço do destinatário. Mascarado: cep, street, number, complement e district viram •••; city, uf e city_ibge ficam.",
    properties: {
      cep: { type: "string" },
      street: { type: "string" },
      number: { type: "string" },
      complement: { type: "string" },
      district: { type: "string" },
      city: { type: "string" },
      city_ibge: { type: "string", description: "Código IBGE do município (7 dígitos)." },
      uf: { type: "string" },
    },
  };
  return {
    ClientesCustomer: {
      type: "object",
      description:
        "Ficha do cliente. Por padrão mascarada (masked: true): CPF, CNPJ de pessoa física, e-mail, telefones, endereço e IE/IM de pessoa física. Sem máscara só pela revelação auditada.",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["active", "erasing", "erased"] },
        kind: { type: "string", enum: ["pf", "pj"] },
        name: { type: "string" },
        trade_name: { type: "string" },
        document_type: { ...nullable("string"), enum: ["cpf", "cnpj", null] },
        individual_business: { type: "boolean", description: "CNPJ de MEI ou empresário individual (mascarado como dado pessoal)." },
        has_document: { type: "boolean" },
        document_display: nullable("string"),
        document: { type: "string", description: "Só na revelação." },
        ie: { type: "string" },
        ie_indicator: { type: "string", enum: ["1", "2", "9"] },
        im: { type: "string" },
        email: { type: "string" },
        phones: {
          type: "array",
          items: {
            type: "object",
            properties: {
              phone: { type: "string" },
              label: { type: "string" },
              verified: { type: "boolean", description: "Confirmado pelo próprio canal (o cliente preencheu pela conversa)." },
            },
          },
        },
        address,
        notes: { type: "string", description: "Observações da equipe; aplicação só com notes:read." },
        source: { type: "string", enum: ["self", "panel", "api"] },
        masked: { type: "boolean" },
        revealable: { type: "boolean", description: "Quem lê pode pedir a revelação." },
        fiscal_ready: {
          type: "object",
          properties: { nfce: { type: "boolean" }, nfe: { type: "boolean" }, nfse: { type: "boolean" } },
        },
        version: { type: "integer" },
        created: { type: "integer" },
        updated: { type: "integer" },
        erased_at: nullable("integer"),
      },
    },
    ClientesCustomerInput: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["pf", "pj"] },
        name: { type: "string", maxLength: 150 },
        trade_name: { type: "string", maxLength: 150 },
        document: { type: "string", description: "CPF ou CNPJ (o alfanumérico também), com ou sem pontuação." },
        individual_business: { type: "boolean" },
        ie: { type: "string", description: "Dígitos ou ISENTO." },
        ie_indicator: { type: "string", enum: ["1", "2", "9"] },
        im: { type: "string" },
        email: { type: "string" },
        cep: { type: "string" },
        street: { type: "string" },
        number: { type: "string" },
        complement: { type: "string" },
        district: { type: "string" },
        city: { type: "string" },
        city_ibge: { type: "string" },
        uf: { type: "string" },
        notes: { type: "string" },
        phones: { type: "array", items: { type: "string" }, description: "Só na criação; depois, /phones." },
        expected_version: { type: "integer", description: "Obrigatório no PATCH." },
      },
    },
    ClientesTimelineItem: {
      type: "object",
      properties: {
        at: { type: "integer" },
        module: { type: "string", description: "core, clientes ou o id do módulo dono." },
        kind: { type: "string" },
        ref_id: { type: "string" },
        title: { type: "string" },
        status: nullable("string"),
        conversation_id: nullable("string"),
      },
    },
    ClientesErasure: {
      type: "object",
      properties: {
        id: { type: "string" },
        customer_id: { type: "string" },
        status: { type: "string", enum: ["awaiting_confirmation", "processing", "done", "cancelled", "expired"] },
        requested_via: { type: "string", enum: ["whatsapp", "menu", "link", "panel"] },
        confirmed_via: { ...nullable("string"), enum: ["button", "text", "link", null] },
        confirmed_at: nullable("integer"),
        expires_at: { type: "integer" },
        kept: { type: "object", description: "Vínculos guardados: conversation_ids, ticket_ids, fiscal_documents, fiscal_retention_until." },
        modules: { type: "object", description: "Resumo por módulo (status done/error, erased, kept, note)." },
        completed_at: nullable("integer"),
      },
    },
    ClientesFiscalRecipient: {
      type: "object",
      description: "Destinatário da nota no formato do FiscalProvider de Vendas.",
      properties: {
        document: { type: "string" },
        document_type: nullable("string"),
        name: { type: "string" },
        trade_name: { type: "string" },
        ie: { type: "string" },
        ie_indicator: { type: "string" },
        im: { type: "string" },
        email: { type: "string" },
        address: { ...nullable("object") },
      },
    },
  };
}

const read = "conversations:read",
  write = "contacts:write";
const base = "/profiles/{profile}/clientes";

export const clientesOperations: [string, string, string, string?, string?][] = [
  ["get", `${base}/customers`, "Clientes: lista mascarada, com busca", read],
  ["post", `${base}/customers`, "Clientes: criar ficha", write],
  ["get", `${base}/customers/{id}`, "Clientes: ficha mascarada, aceites, notas e exclusão aberta", read],
  ["patch", `${base}/customers/{id}`, "Clientes: corrigir ficha", write],
  ["get", `${base}/customers/{id}/timeline`, "Clientes: linha do tempo do relacionamento", read],
  ["get", `${base}/customers/{id}/reveal`, "Clientes: ver sem máscara (com motivo, auditado)", read],
  ["get", `${base}/customers/{id}/fiscal-recipient`, "Clientes: destinatário da nota (auditado)", "contacts:read"],
  ["get", `${base}/customers/{id}/access-log`, "Clientes: quem viu os dados da ficha", "contacts:read"],
  ["post", `${base}/customers/{id}/phones`, "Clientes: acrescentar telefone", write],
  ["post", `${base}/customers/{id}/phones/remove`, "Clientes: tirar telefone", write],
  ["post", `${base}/customers/{id}/erasure`, "Clientes: pedir ao titular a confirmação da exclusão", write],
  ["get", `${base}/conversations/{id}`, "Clientes: ficha do cliente da conversa", read],
  ["post", `${base}/invites`, "Clientes: enviar o link do autocadastro na conversa", "conversations:write"],
  ["get", `${base}/erasures`, "Clientes: histórico de exclusões", "contacts:read"],
  ["get", `${base}/erasures/{id}`, "Clientes: um pedido de exclusão", "contacts:read"],
  ["post", `${base}/erasures/{id}/cancel`, "Clientes: cancelar pedido ainda não confirmado", write],
  ["get", `${base}/access-log`, "Clientes: auditoria de revelações da área", "contacts:read"],
  ["post", `${base}/fiscal-documents`, "Clientes: vincular nota emitida à ficha", write],
];

export function describeClientesOperation(
  path: string,
  method: string,
  entry: any,
  success: any,
) {
  entry.tags = ["Cadastro de clientes"];
  entry.description +=
    " Módulo Cadastro de clientes (clientes); desligado, 409 module_disabled. Dados pessoais saem mascarados para todos; veja docs/CLIENTES.md.";
  const schema = (value: any) => (success.content["application/json"].schema = value);
  const add = (name: string, required = false, description?: string) =>
    entry.parameters.push({ in: "query", name, required, schema: { type: "string" }, ...(description ? { description } : {}) });
  if (path.endsWith("/customers") && method === "get") {
    add("q", false, "Nome; CPF/CNPJ ou telefone completos só para pessoas e aplicações com contacts:read (busca exata).");
    add("status", false, "active (padrão), erasing, erased ou all.");
    add("cursor");
    add("limit");
    return schema({ type: "object", properties: { data: { type: "array", items: ref("ClientesCustomer") }, next_cursor: nullable("string") } });
  }
  if (path.endsWith("/reveal")) {
    entry.description +=
      " Administrador; pessoa da equipe se a regra reveal da área for team; aplicação com contacts:read (chave presa à conversa, nunca). Cada chamada grava quem, quando, campos e motivo (GET …/access-log). Sem permissão: 403 reveal_forbidden.";
    add("reason", true, "Motivo (5 a 300 caracteres).");
    add("fields", false, "document,email,phones,address,ie,im (padrão: todos).");
    return schema(ref("ClientesCustomer"));
  }
  if (path.endsWith("/fiscal-recipient")) {
    entry.description += " Para o emissor de nota. Registro de acesso fiscal com o motivo.";
    add("reason", true);
    return schema(ref("ClientesFiscalRecipient"));
  }
  if (path.endsWith("/timeline")) {
    entry.description +=
      " Lida na hora, sem cópia: conversas e protocolos do núcleo e as rotas públicas dos módulos ligados (Vendas, Pedido, OS, Reserva, Agenda, Mensalidade, Suporte), com as permissões de quem lê.";
    add("limit");
    return schema({ type: "object", properties: { data: { type: "array", items: ref("ClientesTimelineItem") }, skipped: { type: "array" } } });
  }
  if (path.endsWith("/erasure")) {
    entry.description +=
      ' Só envia ao titular a confirmação (botões ou, com {"channel":"link"}, link de uso único) na conversa de um telefone da ficha. A equipe nunca confirma pelo cliente.';
    return schema(ref("ClientesErasure"));
  }
  if (path.includes("/erasures")) {
    if (method === "get" && path.endsWith("/erasures")) {
      add("status");
      add("customer_id");
      return schema({ type: "object", properties: { data: { type: "array", items: ref("ClientesErasure") } } });
    }
    return schema(ref("ClientesErasure"));
  }
  if (path.endsWith("/customers") || path.endsWith("/customers/{id}") || path.includes("/phones")) {
    if (method !== "get") entry.requestBody = { content: { "application/json": { schema: ref("ClientesCustomerInput") } } };
    return schema(ref("ClientesCustomer"));
  }
}
