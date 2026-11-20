// Visibilidade do cupom fiscal do balcão (NFC-e) no painel. Módulo próprio, sem
// dependências: o caixa e a porta comercial leem a mesma regra. O servidor
// revalida papel, permissões do PDV e partes em cada operação.
export type NfceAction = "read" | "configure" | "emit" | "resume" | "cancel";
interface NfceAccess {
  ready: boolean; role: string | null; demo?: boolean;
  parts: { base: boolean; products: boolean; sales: boolean; fiscal: boolean; pos?: boolean };
}
const roles: Record<NfceAction, string[]> = { read: ["admin", "consulta", "fiscal", "vendas", "financeiro"], configure: ["admin"],
  emit: ["admin", "fiscal", "vendas"], resume: ["admin", "fiscal", "vendas"], cancel: ["admin", "fiscal", "vendas"] };
/** Com Fiscal ou Caixa / PDV desligados, o caixa não mostra nada de cupom. */
export function canNfce(access: NfceAccess, action: NfceAction): boolean {
  return access.ready && !access.demo && access.parts.base && access.parts.fiscal && access.parts.pos === true &&
    roles[action].includes(access.role ?? "") && (action !== "emit" || access.parts.products && access.parts.sales);
}
