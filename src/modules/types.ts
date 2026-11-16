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
  /**
   * Campo do item que aponta para um registro de uma chave de configuração
   * do módulo (por exemplo form_id → forms[].id). O núcleo recusa salvar um
   * item que aponte para um registro inexistente.
   */
  reference?: { field: string; setting: string; label: string };
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
  /**
   * Módulos dos quais este depende ("mensalidade"). Não liga sem eles; com
   * um deles desligado, este conta como desligado. Do outro módulo, use só
   * `src/modules/<id>/public.ts` (docs/MODULOS.md, "Dependência entre módulos").
   */
  requires?: string[];
  /**
   * Papéis que o administrador concede a pessoas da área neste módulo
   * (entregador, garçom, técnico, caixa). A concessão fica em
   * `module_grants` das configurações da área, com o id `<módulo>:<papel>`;
   * o módulo confere com `ctx.granted(actor, papel)` (docs/MODULOS.md,
   * "Papéis por pessoa").
   */
  grants?: ModuleGrant[];
  /**
   * Bot da conversa interna agindo em nome da pessoa (src/bot-actions,
   * docs/MODULOS.md "Ações pelo bot"). Por padrão, toda rota pública do
   * módulo entra no catálogo; aqui o módulo ajusta.
   */
  bot?: ModuleBotOptions;
}

export interface ModuleBotOptions {
  /** Ops ("os.decide") ou caminhos de leitura ("os/…") fora do catálogo (prefixos). */
  deny?: string[];
  /**
   * Ops que exigem sessão com segundo fator ao confirmar (prefixos). As de
   * permissão billing:write já são sensíveis sem declarar.
   */
  sensitive?: string[];
  /** Descrição melhor por op ou caminho de leitura; aparece primeiro na busca. */
  hints?: Record<string, string>;
}

/** Papel concedido por pessoa e por área ("technician" vira "os:technician"). */
export interface ModuleGrant {
  /** Minúsculo, sem o módulo: "courier", "waiter", "technician", "cashier". */
  id: string;
  /** Nome no painel ("Entregador"). */
  label: string;
  description: string;
}
