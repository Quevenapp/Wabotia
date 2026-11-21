// Endereços antigos do ERP que têm, no Wabotia, uma tela que funciona no lugar. A casca (mount.tsx, antes de
// conferir o destino) e o roteador do ERP (app/App.tsx) levam para a tela nova, em vez de "em implantação" ou de
// uma tela que o servidor não atende.
import { pendingInMotor } from "./motor.ts";

/** Sempre: a tela antiga duplica a nova. */
const MOVED: Readonly<Record<string, string>> = {
  // Notas recebidas: a de Compras (notas do fornecedor, conferência e entrada) substitui a antiga.
  "/notas-recebidas": "/notas-recebidas-compras",
  // A conexão com a SEFAZ é testada no emissor de notas (o certificado fica no emissor, não no ERP).
  "/conexao-sefaz": "/certificado-a1",
};
/** Sem motor no Wabotia (web/erp/motor.ts): a mesma tarefa é feita pelo emissor de notas. */
const MOVED_WITHOUT_MOTOR: Readonly<Record<string, string>> = {
  "/inutilizacoes-nfe": "/certificado-a1",
  "/cartas-correcao": "/historico-fiscal?modelo=55",
  "/numeracao-fiscal": "/certificado-a1",
};

/** O destino novo de um caminho antigo (sem /app/erp), ou null. */
export function movedTarget(pathname: string): string | null {
  if (Object.hasOwn(MOVED, pathname)) return MOVED[pathname];
  if (Object.hasOwn(MOVED_WITHOUT_MOTOR, pathname) && pendingInMotor(pathname)) return MOVED_WITHOUT_MOTOR[pathname];
  return null;
}
