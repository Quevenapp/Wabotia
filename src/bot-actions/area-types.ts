// Contrato das operações dos módulos de área (Condomínio, Ensino, Jurídico e
// Saúde) que o administrador pode liberar a um bot. Só dados: cada módulo
// declara o seu inventário em src/modules/<id>/bot-grants.ts e o núcleo das
// concessões (src/bot-actions/area.ts) lê daqui. Tudo nasce desligado.

export interface AreaBotOperation {
  /** Nome estável: a op da escrita ("saude.record.create") ou "consulta:<caminho>". */
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Caminho depois de /profiles/:profile/, com :parâmetros. */
  path: string;
  /** Nome curto na tela e na busca do bot. */
  title: string;
  /** O que a operação faz, em português, para a tela e para o bot. */
  description: string;
  /** Campos principais do corpo ou da consulta (ajuda o bot a montar o pedido). */
  fields?: readonly string[];
  /** Campos sensíveis só desta operação, além dos do módulo. */
  sensitive_keys?: readonly string[];
}

export interface AreaBotModule {
  /** Id do módulo (src/modules/<id>/definition.ts). */
  module: "condominio" | "ensino" | "juridico" | "saude";
  /** Grupo na tela do bot. */
  title: string;
  /** Aviso mostrado antes de ligar qualquer operação do módulo. */
  warning: string;
  /** Segundo aviso: o bot executar uma escrita sem a pessoa confirmar. */
  direct_warning: string;
  /** Aviso de "incluir campos sensíveis". */
  sensitive_warning: string;
  /** O que conta como campo sensível, em palavras, para a tela. */
  sensitive_label: string;
  /**
   * Campos marcados como sensíveis (nomes de chave nas respostas). Só vão ao
   * bot com a opção "incluir campos sensíveis" ligada para o bot e o módulo.
   */
  sensitive_keys: readonly string[];
  operations: readonly AreaBotOperation[];
}
