// Operações do backup lógico do ERP (em páginas), com nome estável e
// descrição: as mesmas para a tela (Gestão → Sistema → Backup do ERP), para a
// API e para o catálogo de ações dos bots. Fazer, restaurar e apagar são
// sensíveis: por padrão o bot propõe e uma pessoa confirma. Consultar o
// progresso e listar os backups são leitura comum.
//
// As rotas do Worker (src/erp/api/backup-routes.ts) são só de administrador,
// com o segundo fator nas que mudam algo, e encaminham ao objeto erp:<área>
// (`route`); a lista lê o R2 direto. O contrato do módulo (rotas, catálogo,
// OpenAPI) segue o da NF-e comercial (commercial-nfe/metadata.ts).
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.

export interface ErpBackupOperation {
  name: string;
  method: "GET" | "POST";
  /** Rota interna do objeto erp:<área>; null quando o Worker resolve sozinho (lista e exclusão no R2). */
  route: "/erp-backup" | "/erp-backup-status" | "/erp-restore" | null;
  /** Rota de administrador no Worker, depois de /api/v1/profiles/:profile/. */
  path: string;
  summary: string;
  description: string;
  category: "erp_backup";
  sensitive: boolean;
  bot: { default: "propose" | "run"; configurable: true };
  body: readonly string[];
  required: readonly string[];
  /** Respostas: 200 terminado, 202 em andamento (progresso), 409/413/422 recusado. */
  responses: readonly number[];
}

/** Segmento das rotas no Worker (módulo erp: com o módulo desligado, 409 module_disabled). */
export const ERP_BACKUP_ROUTE = "erp-backup";
const sensitive = { category: "erp_backup", sensitive: true, bot: { default: "propose", configurable: true } } as const;
const reading = { category: "erp_backup", sensitive: false, bot: { default: "run", configurable: true } } as const;

export const ERP_BACKUP_OPERATIONS: readonly ErpBackupOperation[] = Object.freeze([
  {
    name: "erp.backup.start", method: "POST", route: "/erp-backup", path: ERP_BACKUP_ROUTE, ...sensitive,
    summary: "Fazer o backup lógico do ERP da área",
    description: "Grava no armazenamento de arquivos um retrato do ERP da área, em partes comprimidas com manifesto (tabelas, partes, linhas, tamanhos e hashes). Enquanto lê, as alterações do ERP ficam suspensas (cerca de 5 minutos por GiB; as consultas continuam); a coleta do Bling, a fila de integração e as retomadas da NF-e esperam e continuam depois. Credenciais e autorizações em curso não entram; os XML e anexos ficam no armazenamento e só são contados. Se já houver um backup em andamento, devolve o progresso dele.",
    body: [], required: [], responses: [200, 202, 409],
  },
  {
    name: "erp.backup.status", method: "GET", route: "/erp-backup-status", path: `${ERP_BACKUP_ROUTE}/progresso`, ...reading,
    summary: "Ver o progresso do backup ou da restauração do ERP",
    description: "Mostra o trabalho atual ou o último: tipo, fase, percentual, partes e linhas, se a área está parada pela restauração, quanto tempo as alterações ficaram suspensas, resultado ou motivo da falha. Não mostra conteúdo do banco.",
    body: [], required: [], responses: [200],
  },
  {
    name: "erp.backup.restore", method: "POST", route: "/erp-restore", path: `${ERP_BACKUP_ROUTE}/restaurar`, ...sensitive,
    summary: "Restaurar o ERP da área a partir de um backup lógico",
    description: "Volta o ERP da área ao estado do backup: tudo o que foi lançado depois dele se perde; XML e anexos não fazem parte. Confere cada parte (tamanho, hash e linhas) sem mexer no banco e então troca o conteúdo em etapas, com o ERP da área inteiro parado (consultas inclusive) até o fim. Se a troca não puder terminar, o ERP volta ao estado de antes pela recuperação no tempo. Recusa começar se não couber no disco do objeto ou com exclusão ou gravação de XML em andamento. Depois dela a coleta do Bling fica desligada, credenciais não voltam e apagamentos pendentes são aposentados. Para confirmar, informe o nome da área. Aceita backups do formato antigo.",
    body: ["prefix", "confirmacao"], required: ["prefix", "confirmacao"], responses: [200, 202, 400, 404, 409, 413, 422],
  },
  {
    name: "erp.backup.list", method: "GET", route: null, path: ERP_BACKUP_ROUTE, ...reading,
    summary: "Listar os backups do ERP guardados",
    description: "Lista os backups lógicos do ERP da área guardados no armazenamento de arquivos: data, tamanho, linhas e tabelas. Não mostra conteúdo do banco.",
    body: [], required: [], responses: [200],
  },
  {
    name: "erp.backup.delete", method: "POST", route: null, path: `${ERP_BACKUP_ROUTE}/apagar`, ...sensitive,
    summary: "Apagar um backup do ERP guardado",
    description: "Apaga do armazenamento de arquivos um backup lógico do ERP da área (o manifesto e todas as partes). Não mexe no ERP. Recusa apagar o backup que está sendo feito ou restaurado agora.",
    body: ["prefix", "confirmado"], required: ["prefix", "confirmado"], responses: [200, 400, 404, 409],
  },
]);

export const erpBackupOperation = (name: string) => ERP_BACKUP_OPERATIONS.find(operation => operation.name === name) ?? null;
/** A operação de uma rota do Worker (caminho depois de /api/v1/profiles/:profile/). */
export const erpBackupOperationFor = (method: string, path: string) =>
  ERP_BACKUP_OPERATIONS.find(operation => operation.method === (method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase()) && operation.path === path.replace(/\/$/, "")) ?? null;

const propertySchemas: Record<string, Record<string, unknown>> = {
  prefix: { type: "string", description: "Prefixo do backup no armazenamento, como aparece na lista (erp-backups/<área>/<instante>/)." },
  confirmacao: { type: "string", description: "O nome da área, como aparece no painel, para confirmar a restauração." },
  confirmado: { type: "boolean", const: true, description: "Confirma que o backup deve ser apagado." },
};

/** Contrato leve: rotas e operações do módulo erp, catálogo dos bots e OpenAPI. */
export const ERP_BACKUP_MODULE_CONTRACT = {
  routes: [ERP_BACKUP_ROUTE], operations: ["erp.backup."],
  definition: { bot: { sensitive: ERP_BACKUP_OPERATIONS.filter(op => op.sensitive).map(op => op.name),
    hints: Object.fromEntries(ERP_BACKUP_OPERATIONS.map(op => [op.name, op.summary])) } },
  openapi: { paths: Object.fromEntries([...new Set(ERP_BACKUP_OPERATIONS.map(op => op.path))].map(path => [
    `/profiles/{profile}/${path}`,
    Object.fromEntries(ERP_BACKUP_OPERATIONS.filter(op => op.path === path).map(op => [op.method.toLowerCase(), {
      operationId: op.name, summary: op.summary,
      description: `${op.description} Permissão: erp:${op.method === "GET" ? "read" : "write"}. Só administrador${op.method === "GET" ? "" : ", com segundo fator"}. ${op.sensitive ? "Categoria sensível; por padrão o bot propõe e a pessoa confirma." : "Leitura comum."}`,
      parameters: [{ name: "profile", in: "path", required: true, schema: { type: "string" } }],
      ...(op.method === "GET" ? {} : { requestBody: { required: op.required.length > 0, content: { "application/json": { schema: { type: "object", additionalProperties: false,
        properties: Object.fromEntries(op.body.map(key => [key, propertySchemas[key]])), required: [...op.required] } } } } }),
      responses: Object.fromEntries(op.responses.map(code => [String(code), { description: code === 200 ? "Resultado" : code === 202 ? "Em andamento; acompanhe o progresso" : "Recusado, com o motivo" }])),
    }])),
  ])) },
};
