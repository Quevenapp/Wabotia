// Operações do backup lógico do ERP (em páginas), com nome estável e
// descrição, prontas para o catálogo de ações dos bots. Categoria sensível:
// por padrão o bot propõe e uma pessoa confirma. As rotas continuam internas
// (binding do Coordinator, src/erp/hub.ts): não há encaminhamento no Worker
// nem na API pública; este inventário não autoriza expô-las nem retira
// nenhuma recusa existente.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.

export interface ErpBackupOperation {
  name: string;
  method: "GET" | "POST";
  /** Rota interna do objeto erp:<área>. */
  route: "/erp-backup" | "/erp-backup-status" | "/erp-restore";
  summary: string;
  description: string;
  category: "erp_backup";
  sensitive: true;
  bot: { default: "propose"; configurable: true };
  body: readonly string[];
  required: readonly string[];
  /** Respostas: 200 terminado, 202 em andamento (progresso), 409/422 recusado. */
  responses: readonly number[];
}

const sensitive = { category: "erp_backup", sensitive: true, bot: { default: "propose", configurable: true } } as const;

export const ERP_BACKUP_OPERATIONS: readonly ErpBackupOperation[] = Object.freeze([
  {
    name: "erp.backup.start", method: "POST", route: "/erp-backup", ...sensitive,
    summary: "Fazer o backup lógico do ERP da área",
    description: "Grava no armazenamento de arquivos um retrato do ERP da área, em partes comprimidas com manifesto (tabelas, partes, linhas, tamanhos e hashes). Enquanto lê, as alterações do ERP ficam suspensas (as consultas continuam); a coleta do Bling, a fila de integração e as retomadas da NF-e esperam e continuam depois. Credenciais e autorizações em curso não entram; os XML e anexos ficam no armazenamento e só são contados. Se já houver um backup em andamento, devolve o progresso dele.",
    body: [], required: [], responses: [200, 202, 409],
  },
  {
    name: "erp.backup.status", method: "GET", route: "/erp-backup-status", ...sensitive,
    summary: "Ver o progresso do backup ou da restauração do ERP",
    description: "Mostra o trabalho atual ou o último: tipo, fase, percentual, partes e linhas, quanto tempo as alterações ficaram suspensas, resultado ou motivo da falha. Não mostra conteúdo do banco.",
    body: [], required: [], responses: [200],
  },
  {
    name: "erp.backup.restore", method: "POST", route: "/erp-restore", ...sensitive,
    summary: "Restaurar o ERP da área a partir de um backup lógico",
    description: "Confere cada parte do backup (tamanho, hash e linhas) sem mexer no banco e troca o conteúdo inteiro numa transação: ou o ERP fica igual ao backup, ou fica como estava. Alterações ficam suspensas do início ao fim. Recusa começar com exclusão ou gravação de XML em andamento. Depois dela a coleta do Bling fica desligada, credenciais não voltam e apagamentos pendentes são aposentados. Aceita backups do formato antigo.",
    body: ["prefix"], required: ["prefix"], responses: [200, 202, 400, 404, 409, 422],
  },
]);

export const erpBackupOperation = (name: string) => ERP_BACKUP_OPERATIONS.find(operation => operation.name === name) ?? null;
