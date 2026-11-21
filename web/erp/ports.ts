// Portas do ERP (PLANO-FAGOO-PAINEL.md, B): o que o painel do Fagoo recebia do
// Supabase (sessão, segundo fator, endereço da API) passa a vir da casca do
// Wabotia. mount.tsx registra as portas antes de abrir as telas; RealAccess as
// lê ao montar. Sem portas registradas, o ERP mostra "em preparação".
import type { AuthPort } from "./app/lib/real-access";
import type { ChallengePort } from "./session-port";
import type { PeoplePort } from "./people";
import type { EmissorPort } from "./emissor";
import type { CommercialNfePort } from "./commercial-nfe";
import type { RecebidasPort } from "./recebidas";
import type { ProducaoPort } from "./producao";
import type { ContratosPort } from "./contratos-api";
import type { ExpedicaoPort } from "./expedicao-api";
import type { LojasPort } from "./lojas-api";

export type ErpPorts = {
  /** Controlador iniciado pelo hospedeiro; telas legadas criam o próprio quando ausente. */
  controller?: import("./app/lib/real-access").AccessController;
  embedded?: boolean;
  /** Adaptador React do hospedeiro; conserva o contexto sem acoplar as telas ao runtime. */
  accessHost?: import("react").ComponentType<{
    children(host: import("./host-runtime").ErpHostView | null): import("react").ReactNode;
  }>;
  /** Sessão do Wabotia vista como a sessão do Supabase que o controlador espera. */
  auth: AuthPort;
  /**
   * "Confirme que é você": o segundo fator na sessão do Wabotia, quando a
   * política do ERP exige (ERP_MFA_REQUIRED) ou para mudar essa política.
   */
  challenge: ChallengePort;
  /** Pessoas da área com papel erp:* (núcleo; web/erp/people.ts). */
  people: PeoplePort;
  /**
   * Abre Gestão → Pessoas e acessos: convite, papel no ERP, senha, segundo
   * fator e sessões são do núcleo. Só para o administrador do Wabotia.
   */
  openPeople?: () => void;
  /**
   * Abre "Minha conta" do Wabotia (senha e aplicativo autenticador). Ausente
   * enquanto a casca não tiver a tela (origin/feat/login-mfa): o ERP diz onde
   * fica, sem botão.
   */
  openAccount?: () => void;
  /** ID D1, sem conversão; a implementação captura a área de atendimento. */
  openContactProfile?: (contactId: string) => void | Promise<void>;
  /** Ficha única instalada pelo hospedeiro; o componente portado não importa o painel. */
  contactProfileEditor?: import("react").ComponentType<import("./app/components/CatalogEditor").CatalogEditorProps>;
  /**
   * Abre o "Confirme que é você" da casca (o mesmo de qualquer 403
   * mfa_required) e resolve quando a pessoa fecha. Ausente na demonstração: o
   * ERP usa o próprio formulário (web/erp/IdentityChallenge.tsx).
   */
  confirmIdentity?: () => Promise<void>;
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
  /** Emissor de notas (cofre NFapi): estado e configuração (web/erp/emissor.ts). */
  emissor?: EmissorPort;
  /** Preparação e acompanhamento de NF-e modelo 55, isolados por área e sessão. */
  commercialNfe?: CommercialNfePort;
  /** Compras › Notas recebidas: nota do fornecedor, conferência e entrada (web/erp/recebidas.ts). */
  recebidas?: RecebidasPort;
  /** Estoque › Ordens de produção: ordem, apontamento, estorno e planejamento (web/erp/producao.ts). */
  producao?: ProducaoPort;
  /** Financeiro › Contratos: contratos de serviço, faturas, reajuste, renovação e aditivos (web/erp/contratos-api.ts). */
  contratos?: ContratosPort;
  /** Vendas › Expedição: separação, volumes, etiquetas, romaneio e devolução física (web/erp/expedicao-api.ts). */
  expedicao?: ExpedicaoPort;
  /** Cadastros › Lojas e filiais e a barra "Loja em uso" (web/erp/lojas-api.ts). */
  lojas?: LojasPort;
};

let current: ErpPorts | null = null;
export function setErpPorts(ports: ErpPorts | null) {
  current = ports;
}
const installations = new Map<symbol, ErpPorts>();
/** Cada hospedeiro remove apenas a própria instalação. */
export function installErpPorts(ports: ErpPorts): () => void {
  const owner = Symbol("erp-host");
  installations.set(owner, ports);
  return () => { installations.delete(owner); };
}
export const erpPorts = () => [...installations.values()].at(-1) ?? current;
