/** Contrato puro da casa de gestão; os resolvedores pertencem ao painel. */
export type PanelErpRole =
  | "admin" | "consulta" | "financeiro"
  | "vendas" | "estoque" | "fiscal";

export interface ManagementItem {
  /** Exclusão pela casa única e pela entrada portável; não concede acesso. */
  hidden_when_modules_enabled?: readonly string[];
  id: string;
  module: string;
  /** Requisitos adicionais à parte proprietária, sem conceder papel. */
  requires?: readonly import("../erp/parts.ts").ErpModuleId[];
  group: string;
  groupLabel: string;
  groupOrder: number;
  label: string;
  labelKey?: "workCollection" | "customers";
  icon: string;
  order: number;
  primary?: boolean;
  target:
    | { kind: "native"; page: string }
    | { kind: "ported"; to: string };
  permission:
    | { kind: "page"; page: string }
    | { kind: "erp"; roles?: readonly PanelErpRole[]; resource?: string };
}

export interface ManagementContext {
  statusLoaded: boolean;
  modules: Readonly<Record<string, boolean>>;
  role: string;
  access: readonly string[] | null;
  erpRole: PanelErpRole | null;
  vocabulary?: {
    collection_label?: string;
    customer_plural?: string;
  };
}

export interface ResolvedManagementItem extends ManagementItem {
  href: string;
  resolvedLabel: string;
}

export type CanEnterManagement = (c: ManagementContext) => boolean;
export type ResolveManagement = (
  items: readonly ManagementItem[],
  c: ManagementContext,
) => readonly ResolvedManagementItem[];
export type ManagementLanding = (
  items: readonly ResolvedManagementItem[],
) => string | null;
export type CanonicalManagementUrl = (url: URL) => URL | null;

export interface ManagementRouterBridge {
  navigate(to: string, options?: { replace?: boolean }): Promise<void>;
  dispose(): void;
}
