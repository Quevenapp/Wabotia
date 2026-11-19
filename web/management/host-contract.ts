import type {
  ManagementContext,
  ManagementRouterBridge,
} from "../../src/modules/panel-contract";

export interface Disposable {
  dispose(): void;
}

export type PortedTargetState =
  | "loading"
  | "allowed"
  | "disabled"
  | "denied"
  | "unavailable"
  | "not-found";

export interface ManagementRouterConnection extends Disposable {
  publish(to: string, action: "push" | "replace"): void;
}

export type BindManagementRouter = (
  bridge: ManagementRouterBridge,
) => ManagementRouterConnection;

export interface ErpHostContext {
  profile: string;
  actor: string;
  demo: boolean;
  management: ManagementContext;
  onModules(): void;
  onPeople(): void;
  onLeave(): void;
  onExpired(): void;
  onConfirmIdentity?: () => Promise<void>;
  onAccount?: () => void;
  /** ID do contato D1; a área está capturada neste contexto. */
  openContactProfile?: (contactId: string) => void | Promise<void>;
}

export interface ErpMountProps extends ErpHostContext {
  embedded: true;
  /** Destino do portal de ferramentas; não hospeda o menu de módulos. */
  chromeTarget: HTMLElement | null;
}

export interface CustomerProfileHostOptions {
  context: ErpHostContext;
  /** ID ERP já resolvido pela fase 1; nunca interpretar como ID D1. */
  erpContactId: string;
  onClose(): void;
  onSaved?: () => void;
}

export type MountCustomerProfile = (
  element: HTMLElement,
  options: CustomerProfileHostOptions,
) => Promise<Disposable>;
