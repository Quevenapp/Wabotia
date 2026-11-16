// Portas do ERP (PLANO-FAGOO-PAINEL.md, B): o que o painel do Fagoo recebia do
// Supabase (sessão, segundo fator, endereço da API) passa a vir da casca do
// Wabotia. mount.tsx registra as portas antes de abrir as telas; RealAccess as
// lê ao montar. Sem portas registradas, o ERP mostra "em preparação".
import type { AuthPort } from "./app/lib/real-access";
import type { MfaPort } from "./app/lib/account-security";

export type ErpPorts = {
  /** Sessão do Wabotia vista como a sessão do Supabase que o controlador espera. */
  auth: AuthPort;
  /** Segundo fator e troca de senha (Minha conta › Segurança). */
  mfa: MfaPort;
  /** Base da API do ERP desta área: /api/v1/profiles/<área>/erp. */
  apiUrl: string;
  /** fetch com cookie, sem Authorization, só para apiUrl (fetch-port.ts). */
  fetch: typeof fetch;
  /** Demonstração: nada é gravado. */
  demo: boolean;
  /** Administrador do Wabotia (atalho para Gestão → Módulos). */
  admin?: boolean;
  /** Abre Gestão → Módulos no painel. */
  openModules?: () => void;
};

let current: ErpPorts | null = null;
export function setErpPorts(ports: ErpPorts | null) {
  current = ports;
}
export const erpPorts = () => current;
