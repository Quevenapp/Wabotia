// Campos próprios de contato: rotas do Wabotia em
// /api/v1/profiles/:profile/erp-contato-campos (./routes.ts) e as operações
// que o administrador pode liberar a um bot (src/modules/erp/bot-access.ts).
// Contrato leve: sem dependência do motor nem do painel.

export const ERP_CONTACT_FIELDS_ROUTE = "erp-contato-campos";

export interface ErpContactFieldOperation {
  name: string; method: "GET" | "POST" | "PUT"; path: string; sensitive: boolean; summary: string; description: string;
  params: { type: "object"; properties: Record<string, unknown>; required: string[] };
}
const uuid = { type: "string", format: "uuid" };

/** Operações dos bots: ler e gravar os campos próprios de um contato do ERP. Campo sensível só depois de liberado pelo administrador. */
export const ERP_CONTACT_FIELD_OPERATIONS: readonly ErpContactFieldOperation[] = Object.freeze([
  {
    name: "erp.contato.campos.definicoes", method: "GET", path: ERP_CONTACT_FIELDS_ROUTE, sensitive: false,
    summary: "Ver os campos próprios de contato do ERP",
    description: "Lista os campos próprios que a empresa criou para clientes, fornecedores, vendedores e transportadoras (nome, tipo, opções da lista, obrigatório e para quais tipos de contato). Campo sensível só aparece se o administrador liberou. Só consulta.",
    params: { type: "object", properties: {}, required: [] },
  },
  {
    name: "erp.contato.campos.ler", method: "GET", path: `${ERP_CONTACT_FIELDS_ROUTE}/contato/:id`, sensitive: false,
    summary: "Ler os campos próprios de um contato do ERP",
    description: "Mostra os campos próprios de um contato do ERP (o id é o do cadastro no ERP, erp_contact_id do contato) com os valores preenchidos. Campo sensível só aparece se o administrador liberou. Só consulta.",
    params: { type: "object", properties: { id: uuid }, required: ["id"] },
  },
  {
    name: "erp.contato.campos.gravar", method: "PUT", path: `${ERP_CONTACT_FIELDS_ROUTE}/contato/:id`, sensitive: true,
    summary: "Gravar campos próprios de um contato do ERP",
    description: "Preenche ou limpa (null) campos próprios de um contato do ERP: valores pelo id do campo, como texto (número com vírgula ou ponto, data DD/MM/AAAA, lista pelo nome da opção, Sim ou Não). Só os campos enviados mudam; obrigatório não pode ser limpo. Campo sensível só se o administrador liberou. O bot propõe e a pessoa confirma.",
    params: { type: "object", required: ["id", "command_id", "valores"], properties: {
      id: uuid, command_id: uuid,
      valores: { type: "object", description: "Id do campo → valor em texto (ou null para limpar). Até 60 campos.", additionalProperties: { type: ["string", "boolean", "number", "null"] } },
    } },
  },
]);

/** A operação de um caminho depois de /api/v1/profiles/:profile/ (só as dos bots). */
export function erpContactFieldOperationFor(method: string, path: string): ErpContactFieldOperation | null {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const parts = path.replace(/\/$/, "").split("/");
  return ERP_CONTACT_FIELD_OPERATIONS.find(op => {
    const pattern = op.path.split("/");
    return op.method === verb && pattern.length === parts.length && pattern.every((s, i) => s.startsWith(":") ? parts[i] !== "" : s === parts[i]);
  }) ?? null;
}

/** Contrato do módulo erp: rota, operações e categoria sensível no catálogo dos bots. */
export const ERP_CONTACT_FIELDS_MODULE_CONTRACT = {
  routes: [ERP_CONTACT_FIELDS_ROUTE], operations: ["erp.contato.campos."],
  definition: { bot: { sensitive: ERP_CONTACT_FIELD_OPERATIONS.filter(op => op.sensitive).map(op => op.name),
    hints: Object.fromEntries(ERP_CONTACT_FIELD_OPERATIONS.map(op => [op.name, op.summary])) } },
} as const;
