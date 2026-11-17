// Wabotia: cache de sessão do controlador do ERP (web/erp/app/lib/real-access.ts).
//
// Cada chamada à API do ERP custa cerca de 0,57 s. Várias telas leem as mesmas
// configurações (barra do topo, preferências, taxonomias, permissões por área) e
// as releem ao voltar. Este módulo guarda, por controlador (um por área de
// serviço / apiUrl), as respostas de GETs explicitamente marcados como estáveis.
//
// Regras (aprovadas na sessão de latência, levantamento 9.4):
// - Só entra no cache um GET cujo caminho está numa das listas abaixo. Todo o
//   resto continua indo ao servidor como antes, sem cache e sem compartilhar
//   pedidos em voo.
// - A chave é apiUrl + ator + papel + caminho completo (com a consulta). Quem
//   monta a chave é o controlador.
// - Erros nunca ficam guardados; só respostas OK.
// - Cada chamador recebe uma cópia (structuredClone): ninguém altera o que
//   está guardado.
// - Dois GETs iguais ao mesmo tempo de um caminho destas listas compartilham um
//   único pedido. Se um chamador cancela, o pedido continua para os outros; se
//   todos cancelam, o pedido é cancelado.
// - A permissão continua sendo do servidor: uma resposta guardada só evita
//   repetir uma leitura que o servidor já autorizou para o mesmo ator e papel.
//
// Invalidação (feita pelo controlador):
// - escrita (qualquer método diferente de GET) — ver writeScope();
// - fim de sessão (cancel(): 401, logout, troca de sessão, parada do
//   controlador) — clear();
// - troca de papel ou de recursos detectada pelo /v1/me — clear();
// - qualquer 401/403 de qualquer chamada — dropPermissions();
// - troca de área: o controlador é recriado com outro apiUrl e o cache é dele.

/** TTL das configurações estáveis. */
export const STABLE_TTL_MS = 5 * 60_000;
/** TTL curto dos envelopes de permissão por área. */
export const PERMISSIONS_TTL_MS = 30_000;
/** Limite de entradas guardadas por controlador (as mais antigas saem primeiro). */
export const MAX_ENTRIES = 200;

export type CacheKind = "estavel" | "permissoes" | "em-voo";
export interface CachePolicy {
  kind: CacheKind;
  /** Tempo de vida da resposta guardada; 0 = só compartilha o pedido em voo. */
  ttl: number;
}

const TIPO = "[a-z_]{1,40}"; // tipo de documento: sales_orders, purchase_orders...

/**
 * Configurações estáveis (TTL de 5 minutos). Cada uma: por que é segura.
 */
const STABLE: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /^\/v1\/sistema\/perfil$/,
    reason:
      "barra do topo e Início (S2/H4): nome e e-mail do usuário, papel e nome da empresa; muda só por edição de cadastro (escrita de configuração limpa tudo)",
  },
  {
    pattern: /^\/v1\/preferencias\/(?!comandos(?:\/|$))[a-z0-9-]{1,64}$/,
    reason:
      "páginas de Preferências (S5, P5, D3, D6, V2, F4): versionadas com CAS; salvar com versão velha é recusado pelo servidor (409); a leitura de comandos fica fora",
  },
  {
    pattern:
      /^\/v1\/preferencias-listas\/(?!comandos(?:\/|$))[a-z0-9_.-]{1,80}$/,
    reason:
      "listagens customizadas (P6, C2, C3, F5/F6): de cada usuário, só ele as muda; versionadas com CAS; a leitura de comandos fica fora",
  },
  {
    pattern:
      /^\/v1\/cadastros\/taxonomias\/(?:categorias-produtos|tags|grupos-tags)$/,
    reason:
      "taxonomias (P2-P4, C6/C7): opções de seletor; o servidor confere cada gravação",
  },
  {
    pattern: /^\/v1\/cadastros\/tipos-contato$/,
    reason: "tipos de contato (C4): opções de seletor",
  },
  {
    pattern: /^\/v1\/cadastros\/vendedores\/opcoes(?:\?[^#]*)?$/,
    reason:
      "opções de vendedor dos seletores: o servidor confere o vendedor ao gravar o documento",
  },
  {
    pattern: new RegExp(`^/v1/documentos/${TIPO}/situacoes$`),
    reason:
      "situações do tipo de documento (D2): configuração; editadas em /v1/sistema/situacoes (escrita de configuração limpa tudo); o servidor confere cada transição",
  },
  {
    pattern: new RegExp(`^/v1/documentos/${TIPO}/categorias$`),
    reason:
      "plano de categorias para o seletor do documento (D25, aba Pagamento do PDV): nomes de categorias, sem valores nem saldos",
  },
  {
    pattern: new RegExp(`^/v1/documentos/${TIPO}/preferencias-listagem$`),
    reason: "preferências da listagem de documentos (D4): configuração da tela",
  },
];

/**
 * Envelopes de permissão por área (TTL curto de 30 s): só evitam a leitura
 * repetida ao trocar de tela. O servidor continua conferindo cada pedido, e
 * qualquer 401/403 descarta estes envelopes na hora. O /v1/me nunca passa
 * por aqui: a conferência do vínculo vai sempre ao servidor.
 */
const PERMISSIONS: ReadonlyArray<RegExp> = [
  /^\/v1\/cadastros$/, // P1, C1, D8
  /^\/v1\/documentos$/, // D1
  /^\/v1\/financeiro$/, // F1
];

/**
 * Só compartilham o pedido em voo (nada fica guardado): estado que muda ou que
 * pesa numa decisão, mas que duas partes da tela leem ao mesmo tempo.
 */
const IN_FLIGHT_ONLY: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /^\/v1\/sistema\/armazenamento$/,
    reason: "uso do armazenamento muda a cada anexo (S3/H5)",
  },
  {
    pattern: /^\/v1\/sistema\/notificacoes\?aba=(?:nao_lidas|todas)$/,
    reason: "notificações mudam a qualquer momento (S4/H6)",
  },
  {
    pattern: /^\/v1\/empresa\/identidade$/,
    reason:
      "identidade da empresa: as telas fiscais conferem a versão dela (numeração, notas recebidas, certificado) e outro administrador pode mudá-la",
  },
];

// Ficam fora de propósito (sem cache e sem compartilhar pedido), entre outros:
// - /v1/me: a conferência do vínculo vai sempre ao servidor;
// - /v1/cadastros/listas-precos*: preços;
// - /v1/financeiro/accounts e /v1/financeiro/categories (e tudo de
//   /v1/financeiro além do envelope): dados financeiros;
// - /v1/documentos/<tipo>/pagamento: formas de pagamento junto com as contas
//   financeiras de destino; o hook da tela já guarda a leitura por montagem;
// - títulos, saldos, controle de caixa, posições e saldos de estoque, listas e
//   documentos, vendas, notas: mudam por outras pessoas e pesam em decisões.

/** Política de cache de um GET, ou null quando o caminho não está nas listas. */
export function cachePolicy(path: string): CachePolicy | null {
  if (typeof path !== "string" || path.includes("#")) return null;
  if (STABLE.some((entry) => entry.pattern.test(path)))
    return { kind: "estavel", ttl: STABLE_TTL_MS };
  if (PERMISSIONS.some((pattern) => pattern.test(path)))
    return { kind: "permissoes", ttl: PERMISSIONS_TTL_MS };
  if (IN_FLIGHT_ONLY.some((entry) => entry.pattern.test(path)))
    return { kind: "em-voo", ttl: 0 };
  return null;
}

/** Área de um caminho: os dois primeiros segmentos, /v1/<área>. */
export function areaOf(path: string): string | null {
  const match = /^\/v1\/[^/?#]+/.exec(path);
  return match ? match[0] : null;
}

/**
 * Escritas que só mexem na própria área. Uma escrita destas limpa as entradas
 * da área dela (/v1/<área> e tudo abaixo). Qualquer outra escrita limpa o
 * cache inteiro: configurações de uma área podem ser editadas em outra (as
 * situações de /v1/documentos são salvas em /v1/sistema/situacoes; as
 * categorias, no financeiro; o nome da empresa do perfil, em /v1/empresa), e
 * na dúvida vale limpar tudo.
 */
const AREA_ONLY_WRITES: ReadonlyArray<RegExp> = [
  /^\/v1\/documentos(?:[/?]|$)/, // salvar, mudar situação, lixeira, número, importar XML
  /^\/v1\/frente-caixa\/actions\/sale_[a-z_]{1,30}$/, // vendas do PDV (não as configurações do PDV)
  /^\/v1\/estoque(?:[/?]|$)/,
  /^\/v1\/reservas-estoque(?:[/?]|$)/,
  /^\/v1\/documentos-estoque(?:[/?]|$)/,
  /^\/v1\/ordens-servico(?:[/?]|$)/,
  /^\/v1\/notas-fiscais(?:[/?]|$)/,
  /^\/v1\/inicio(?:[/?]|$)/, // atalhos do Início
];

/** Prefixo invalidado por uma escrita em `path`; null = cache inteiro. */
export function writeScope(path: string): string | null {
  const area = areaOf(path);
  if (!area || !AREA_ONLY_WRITES.some((pattern) => pattern.test(path)))
    return null;
  return area;
}

interface Entry {
  path: string;
  kind: CacheKind;
  /** true quando a resposta já chegou e está guardada. */
  done: boolean;
  value?: unknown;
  expires: number;
  /** Pedido em voo, compartilhado pelos chamadores. */
  promise?: Promise<unknown>;
  controller?: AbortController;
  waiters: number;
}

export interface SessionCache {
  /**
   * Lê `path` pelo cache: devolve uma cópia da resposta guardada, entra num
   * pedido igual em voo ou chama `load` (com o sinal do pedido compartilhado).
   * `signal` é o do chamador: cancelá-lo só tira este chamador da espera.
   */
  read(
    key: string,
    path: string,
    policy: CachePolicy,
    load: (signal: AbortSignal) => Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  /** Escrita (POST/PATCH/PUT/DELETE) em `path`: ver writeScope(). */
  invalidateWrite(path: string): void;
  /** Descarta os envelopes de permissão (qualquer 401/403). */
  dropPermissions(): void;
  /** Descarta tudo (fim de sessão, troca de papel, parada do controlador). */
  clear(): void;
  /** Quantas entradas existem (guardadas ou em voo); para testes. */
  size(): number;
}

const cancelled = () => new DOMException("Request cancelled", "AbortError");

export function createSessionCache(
  options: { now?: () => number; maxEntries?: number } = {},
): SessionCache {
  const now = options.now ?? (() => Date.now());
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const entries = new Map<string, Entry>();

  const evict = () => {
    // Map mantém a ordem de inserção: as primeiras são as mais antigas.
    for (const [key, entry] of entries) {
      if (entries.size <= maxEntries) break;
      if (entry.done) entries.delete(key);
    }
  };

  /** Um chamador espera o pedido compartilhado, com o próprio cancelamento. */
  const join = (key: string, entry: Entry, signal?: AbortSignal) =>
    new Promise<unknown>((resolve, reject) => {
      let settled = false;
      entry.waiters++;
      const leave = () => {
        entry.waiters--;
        // Todos desistiram: cancela o pedido e tira a entrada (se ainda for esta).
        if (entry.waiters === 0 && !entry.done) {
          entry.controller?.abort();
          if (entries.get(key) === entry) entries.delete(key);
        }
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        leave();
        reject(cancelled());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.promise!.then(
        (value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          entry.waiters--;
          resolve(structuredClone(value));
        },
        (error) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          entry.waiters--;
          reject(error);
        },
      );
    });

  return {
    read(key, path, policy, load, signal) {
      if (signal?.aborted) return Promise.reject(cancelled());
      const found = entries.get(key);
      if (found?.done) {
        if (found.expires > now())
          return Promise.resolve(structuredClone(found.value));
        entries.delete(key);
      }
      let entry = entries.get(key);
      if (!entry) {
        const created: Entry = {
          path,
          kind: policy.kind,
          done: false,
          expires: 0,
          controller: new AbortController(),
          waiters: 0,
        };
        created.promise = load(created.controller!.signal).then(
          (value) => {
            // Só guarda se a entrada não foi invalidada enquanto estava em voo.
            if (entries.get(key) === created) {
              if (policy.ttl > 0) {
                created.done = true;
                created.value = value;
                created.expires = now() + policy.ttl;
                created.promise = undefined;
                created.controller = undefined;
                evict();
              } else entries.delete(key);
            }
            return value;
          },
          (error) => {
            // Erro nunca fica guardado.
            if (entries.get(key) === created) entries.delete(key);
            throw error;
          },
        );
        entries.set(key, created);
        entry = created;
      }
      return join(key, entry, signal);
    },
    invalidateWrite(path) {
      const area = writeScope(path);
      if (area === null) {
        entries.clear();
        return;
      }
      for (const [key, entry] of entries)
        if (areaOf(entry.path) === area) entries.delete(key);
    },
    dropPermissions() {
      for (const [key, entry] of entries)
        if (entry.kind === "permissoes") entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    size: () => entries.size,
  };
}
