// Código-fonte do commit em execução (AGPL-3.0, §13): quem usa o Wabotia pela
// rede recebe o endereço do código exato que está rodando. Vai em
// /api/health, /api/v1/capabilities, no rodapé do painel e do login e nas
// páginas que o cliente final abre (passo web, carrinho, acompanhamento).
//
// Quem modificar o Wabotia aponta o próprio repositório em WABOTIA_SOURCE_URL:
// um endereço HTTPS; com "{commit}" no texto, ele é trocado pelo commit; sem,
// acrescenta-se "/tree/<commit>" (formato do GitHub e do GitLab).
import { buildInfo } from "./build-info.generated";

export const OFFICIAL_SOURCE = "https://github.com/Quevenapp/Wabotia";
/** Licença do servidor e do painel (o sufixo -only/-or-later fica no package.json). */
export const LICENSE_NAME = "AGPL-3.0";

function repository(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 300)
    return OFFICIAL_SOURCE;
  try {
    const url = new URL(value.trim().replace("{commit}", "x"));
    if (url.protocol !== "https:" || url.username || url.password)
      return OFFICIAL_SOURCE;
  } catch {
    return OFFICIAL_SOURCE;
  }
  return value.trim().replace(/\/+$/, "");
}

export interface SourceInfo {
  /** Código do commit em execução (ou o repositório, sem commit conhecido). */
  url: string;
  repository: string;
  commit: string;
  license: string;
}

export function sourceInfo(
  env: { WABOTIA_SOURCE_URL?: string } = {},
): SourceInfo {
  const base = repository(env.WABOTIA_SOURCE_URL);
  const commit = buildInfo.commit;
  const known = /^[a-f0-9]{40}$/.test(commit);
  const url = base.includes("{commit}")
    ? known
      ? base.replace("{commit}", commit)
      : base.replace(/\/?[^/]*\{commit\}.*$/, "")
    : known
      ? `${base}/tree/${commit}`
      : base;
  return {
    url,
    repository: base.includes("{commit}")
      ? base.replace(/\/?[^/]*\{commit\}.*$/, "")
      : base,
    commit,
    license: LICENSE_NAME,
  };
}
