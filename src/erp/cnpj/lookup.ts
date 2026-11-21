// Consulta de CNPJ nas bases públicas da Receita (BrasilAPI e CNPJá): validação, mapeamento e a ordem de consulta.
// Sem imports, para os testes rodarem em Node puro; a rota fica em routes.ts.
export interface CnpjData {
  cnpj: string;
  razao_social: string | null;
  nome_fantasia: string | null;
  situacao: string | null;
  ativa: boolean | null;
  abertura: string | null;
  cep: string | null;
  uf: string | null;
  cidade: string | null;
  bairro: string | null;
  endereco: string | null;
  numero: string | null;
  complemento: string | null;
  telefone: string | null;
  email: string | null;
  inscricao_estadual: string | null;
  simples: boolean | null;
  mei: boolean | null;
  atividade: string | null;
  fonte: "brasilapi" | "cnpj.ws";
}

const TIMEOUT_MS = 8000;
const text = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const out = String(value).replace(/\s+/g, " ").trim();
  return out ? out : null;
};
const digits = (value: unknown) => (text(value) ?? "").replace(/\D/g, "");
const cep = (value: unknown) => { const d = digits(value); return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : null; };
const phone = (value: unknown) => {
  const d = digits(value);
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  return d.length >= 8 ? d : null;
};
/** Nome da Receita vem em caixa alta; fica como veio (é o nome oficial), sem espaços repetidos. */
const street = (kind: unknown, name: unknown) => {
  const k = text(kind), n = text(name);
  if (!n) return null;
  return k && !n.toUpperCase().startsWith(k.toUpperCase() + " ") ? `${k} ${n}` : n;
};

export function validCnpjDigits(value: string): boolean {
  if (!/^\d{14}$/.test(value) || /^(\d)\1{13}$/.test(value)) return false;
  const n = [...value].map(Number);
  const dv = (len: number, weights: number[]) => { const s = weights.reduce((sum, w, i) => sum + n[i]! * w, 0) % 11; return s < 2 ? 0 : 11 - s; };
  return dv(12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === n[12] && dv(13, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === n[13];
}

export function fromBrasilApi(cnpj: string, b: any): CnpjData {
  const situacao = text(b?.descricao_situacao_cadastral);
  return {
    cnpj,
    razao_social: text(b?.razao_social),
    nome_fantasia: text(b?.nome_fantasia),
    situacao,
    ativa: situacao ? situacao.toUpperCase() === "ATIVA" : null,
    abertura: text(b?.data_inicio_atividade),
    cep: cep(b?.cep),
    uf: text(b?.uf)?.toUpperCase() ?? null,
    cidade: text(b?.municipio),
    bairro: text(b?.bairro),
    endereco: street(b?.descricao_tipo_de_logradouro, b?.logradouro),
    numero: text(b?.numero),
    complemento: text(b?.complemento),
    telefone: phone(b?.ddd_telefone_1),
    email: text(b?.email)?.toLowerCase() ?? null,
    inscricao_estadual: null,
    simples: typeof b?.opcao_pelo_simples === "boolean" ? b.opcao_pelo_simples : null,
    mei: typeof b?.opcao_pelo_mei === "boolean" ? b.opcao_pelo_mei : null,
    atividade: text(b?.cnae_fiscal_descricao),
    fonte: "brasilapi",
  };
}

export function fromCnpjWs(cnpj: string, b: any): CnpjData {
  const e = b?.estabelecimento ?? {};
  const uf = text(e?.estado?.sigla)?.toUpperCase() ?? null;
  const situacao = text(e?.situacao_cadastral);
  const ies: any[] = Array.isArray(e?.inscricoes_estaduais) ? e.inscricoes_estaduais : [];
  const ie = ies.find(i => i?.ativo !== false && text(i?.estado?.sigla)?.toUpperCase() === uf) ?? null;
  const sim = (value: unknown) => (value === "Sim" ? true : value === "Não" ? false : null);
  return {
    cnpj,
    razao_social: text(b?.razao_social),
    nome_fantasia: text(e?.nome_fantasia),
    situacao,
    ativa: situacao ? situacao.toUpperCase() === "ATIVA" : null,
    abertura: text(e?.data_inicio_atividade),
    cep: cep(e?.cep),
    uf,
    cidade: text(e?.cidade?.nome),
    bairro: text(e?.bairro),
    endereco: street(e?.tipo_logradouro, e?.logradouro),
    numero: text(e?.numero),
    complemento: text(e?.complemento),
    telefone: phone(`${text(e?.ddd1) ?? ""}${text(e?.telefone1) ?? ""}`),
    email: text(e?.email)?.toLowerCase() ?? null,
    inscricao_estadual: ie ? text(ie.inscricao_estadual) : null,
    simples: sim(b?.simples?.simples),
    mei: sim(b?.simples?.mei),
    atividade: text(e?.atividade_principal?.descricao),
    fonte: "cnpj.ws",
  };
}

type Lookup = { data: CnpjData } | { notFound: true } | { failed: string };

async function ask(url: string): Promise<{ status: number; body: any } | null> {
  try {
    const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Wabotia-ERP" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch {
    return null;
  }
}

export async function lookupCnpj(cnpj: string, fetcher: (url: string) => Promise<{ status: number; body: any } | null> = ask): Promise<Lookup> {
  const first = await fetcher(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
  if (first && first.status === 200 && first.body?.razao_social) {
    const data = fromBrasilApi(cnpj, first.body);
    // A BrasilAPI não traz a inscrição estadual: a segunda base completa só esse dado, se responder.
    const extra = await fetcher(`https://publica.cnpj.ws/cnpj/${cnpj}`);
    if (extra && extra.status === 200 && extra.body?.estabelecimento) data.inscricao_estadual = fromCnpjWs(cnpj, extra.body).inscricao_estadual;
    return { data };
  }
  const second = await fetcher(`https://publica.cnpj.ws/cnpj/${cnpj}`);
  if (second && second.status === 200 && second.body?.razao_social) return { data: fromCnpjWs(cnpj, second.body) };
  if ((first?.status === 404 || first?.status === 400) && (second === null || second.status === 404 || second.status === 400)) return { notFound: true };
  if (first?.status === 404 && second?.status === 429) return { notFound: true };
  return { failed: second?.status === 429 || first?.status === 429 ? "busy" : "unavailable" };
}

