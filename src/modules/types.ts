// Contrato de um módulo embutido (docs/MODULOS.md). A declaração é só dados:
// o núcleo lê daqui o que mostrar no painel, que itens de menu do WhatsApp
// aceitar, que rotas e operações pertencem ao módulo e que eventos ele publica.

/** Lugar do painel que o módulo ocupa. */
export interface ModuleNavItem {
  /**
   * Para `place: "rail"`, a área do trilho (web/lib/routes.ts); para
   * `place: "admin"`, a página de Gestão (web/workspace-navigation.ts).
   */
  id: string;
  label: string;
  place: "rail" | "admin";
  /** Só administradores veem. */
  admin: boolean;
}

/** Tipo de item de menu do WhatsApp oferecido pelo módulo. */
export interface ModuleMenuType {
  /** Valor de `type` no item de menu salvo nas configurações da área. */
  type: string;
  label: string;
  description: string;
}

/** Chave das configurações da área (PUT /settings) que pertence ao módulo. */
export interface ModuleSettingKey {
  key: string;
  description: string;
}

export interface ModuleDefinition {
  /** Identificador estável, minúsculo: "queue", "forms", "agenda". */
  id: string;
  name: string;
  /** Versão do contrato do módulo (semver), independente da do servidor. */
  version: string;
  description: string;
  /** Vem com o servidor (todas as verticais da onda 2 também vêm). */
  builtin: boolean;
  /** Estado de uma área sem registro em profile_modules. */
  default_enabled: boolean;
  navigation: ModuleNavItem[];
  menu_item_types: ModuleMenuType[];
  /** Tipos de evento publicados (tabela events, webhooks, tempo real). */
  events: string[];
  settings: ModuleSettingKey[];
  /**
   * Primeiro segmento das rotas em /api/v1/profiles/:profile/ que pertencem
   * ao módulo. Com o módulo desligado elas respondem 409 module_disabled.
   */
  routes: string[];
  /** Prefixos das operações do Coordinator ("queue.", "counter."). */
  operations: string[];
  /** Permissões de aplicação que o módulo usa (lista de service.ts). */
  scopes: string[];
}
