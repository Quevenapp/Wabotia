// Cadastro da instalação. Só este módulo abre o cofre dos provedores;
// respostas públicas usam uma lista explícita de campos, nunca a linha SQL.
import { all, batch, exec, one } from "./db";
import { requireAccess } from "./access";
import {
  ApiError,
  type Actor,
  type Env,
  json,
  now,
  requireValue,
  uid,
} from "./types";
import {
  admin,
  hmac,
  publicUrl,
  refuseEngineActor,
  requireDirectPerson,
  safeFetch,
  seal,
  secret,
  unseal,
} from "./security";
import {
  AI_PROVIDERS,
  aiConfig,
  aiKey,
  aiListModels,
  type AiProvider,
} from "./ai-provider";

const kinds = ["openai", "anthropic", "deepseek", "compatible", "typesafe"];
const capabilities = [
  "text",
  "image",
  "pdf",
  "tools",
  "transcription",
  "decision",
];
const priceFields = [
  "input",
  "cache_read",
  "cache_write",
  "output",
  "audio_minute",
];

/** Defesa contra um serviço que ecoe a credencial em modelos ou respostas. */
export function hideProviderKey(value: string, key: string): string {
  if (key) value = value.split(key).join("[oculto]");
  // Inclui o separador na posição 12: sk-ant-api03- termina nesse índice.
  const random = key.slice(key.lastIndexOf("-", 12) + 1);
  for (const part of [random.slice(0, 12), random.slice(-12)])
    if (part.length >= 12) value = value.split(part).join("[oculto]");
  return value;
}

/** Limpa também argumentos de ferramentas antes de qualquer execução local. */
export function hideProviderValue<T>(value: T, key: string): T {
  if (typeof value === "string") return hideProviderKey(value, key) as T;
  if (Array.isArray(value))
    return value.map((v) => hideProviderValue(v, key)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        hideProviderKey(k, key),
        hideProviderValue(v, key),
      ]),
    ) as T;
  return value;
}

export async function providerFingerprint(env: Env, key: string) {
  if (!env.MASTER_KEY || env.MASTER_KEY.length < 32)
    throw new ApiError(
      503,
      "setup_required",
      "Configure MASTER_KEY nos secrets do Worker.",
    );
  return hmac(await hmac(env.MASTER_KEY, "ai-provider-fingerprint/v1"), key);
}

export async function providerRow(env: Env, id: string) {
  const row = await one(env, "SELECT * FROM ai_providers WHERE id=?", id);
  if (!row)
    throw new ApiError(404, "provider_not_found", "Provedor não encontrado.");
  return row;
}

/** Um vínculo explícito nunca volta ao segredo antigo, nem se foi excluído. */
export async function allowedProvider(env: Env, id: string, profile: string) {
  const row =
    typeof id === "string" && id
      ? await one(env, "SELECT * FROM ai_providers WHERE id=?", id)
      : null;
  if (!row)
    throw new ApiError(
      409,
      "provider_not_found",
      "Provedor não encontrado: escolha outro.",
    );
  if (row.status !== "active")
    throw new ApiError(
      409,
      "provider_revoked",
      "Provedor revogado: escolha outro.",
    );
  if (!json(row.profiles, []).includes(profile))
    throw new ApiError(
      409,
      "provider_not_allowed",
      "Este provedor não está liberado para esta área.",
    );
  return row;
}

export async function providerKey(env: Env, row: any): Promise<string> {
  if (row.status !== "active")
    throw new ApiError(
      409,
      "provider_revoked",
      "Provedor revogado: escolha outro",
    );
  const value = await secret(env, `provider:${row.id}`);
  const key = value.api_key || value.key;
  if (typeof key !== "string" || !key)
    throw new ApiError(
      409,
      "provider_missing_key",
      "Cadastre a chave de API do provedor.",
    );
  return key;
}

function publicProvider(row: any, actor?: Actor) {
  const summary = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    profiles: json(row.profiles, []).filter(
      (profile: string) => !actor || actor.role === "admin" || actor.profiles.includes(profile),
    ),
    status: row.status,
    capabilities: json(row.capabilities),
    models: json(row.models, []),
  };
  if (actor && actor.role !== "admin") return summary;
  return {
    ...summary,
    credential: row.credential,
    base_url: row.base_url,
    prices: json(row.prices),
    verified_at: row.verified_at,
    created: row.created,
    updated: row.updated,
  };
}

function reader(actor: Actor) {
  refuseEngineActor(actor);
  if (actor.kind !== "user" || !["admin", "operator"].includes(actor.role))
    throw new ApiError(
      403,
      "admin_required",
      "Somente pessoas com acesso à área.",
    );
  // Mesmo item da tela Bots (web/workspace-navigation.ts). security.access
  // confere área/escopos; users.access é conferido por requireAccess.
  requireAccess(actor, "conversations");
}
const visible = (actor: Actor, row: any) =>
  actor.role === "admin" ||
  json(row.profiles, []).some((p: string) => actor.profiles.includes(p));

export async function listProviders(env: Env, actor: Actor) {
  reader(actor);
  const rows = (
    await all(env, "SELECT * FROM ai_providers ORDER BY created,id")
  ).filter((row) => visible(actor, row));
  if (actor.role === "admin") {
    const pending = await all(
      env,
      "SELECT p.id,s.value FROM ai_providers p JOIN secrets s ON s.id='provider:'||p.id WHERE p.status='active' AND p.key_fingerprint IS NULL",
    );
    const writes: [string, any[]][] = [];
    for (const pendingRow of pending) {
      const row = rows.find((item) => item.id === pendingRow.id);
      if (!row || row.key_fingerprint) continue;
      const value = await unseal(env, pendingRow.value);
      const key = value.api_key || value.key;
      if (!key) continue;
      row.key_fingerprint = await providerFingerprint(env, key);
      // Uma rotação concorrente não pode receber a impressão da chave antiga.
      writes.push([
        "UPDATE ai_providers SET key_fingerprint=? WHERE id=? AND key_fingerprint IS NULL AND EXISTS(SELECT 1 FROM secrets WHERE id=? AND value=?)",
        [row.key_fingerprint, row.id, `provider:${row.id}`, pendingRow.value],
      ]);
    }
    if (writes.length) await batch(env, writes);
  }
  return rows.map((row) => ({
    ...publicProvider(row, actor),
    ...(actor.role === "admin"
      ? {
          same_key_as: rows
            .filter(
              (other) =>
                other.id !== row.id &&
                row.status === "active" &&
                other.status === "active" &&
                row.key_fingerprint &&
                row.key_fingerprint === other.key_fingerprint &&
                row.kind === other.kind &&
                row.base_url === other.base_url,
            )
            .map((other) => other.id),
        }
      : {}),
  }));
}

async function profileIds(env: Env, value: unknown): Promise<string[]> {
  requireValue(
    Array.isArray(value) &&
      value.length <= 500 &&
      value.every((v) => typeof v === "string" && v.length <= 100),
    "Informe as áreas do provedor.",
  );
  const ids = [...new Set(value as string[])];
  const rows = await all(env, "SELECT id FROM profiles");
  requireValue(
    ids.every((id) => rows.some((row) => row.id === id)),
    "Área não encontrada.",
  );
  return ids;
}

function nameOf(value: unknown) {
  requireValue(
    typeof value === "string" && value.trim().length > 0 && value.length <= 100,
    "Informe o nome do provedor (até 100 caracteres).",
  );
  return (value as string).trim();
}
function capabilitiesOf(value: any) {
  requireValue(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.entries(value).every(
        ([k, v]) => capabilities.includes(k) && typeof v === "boolean",
      ),
    "Capacidades inválidas.",
  );
  return value;
}
function pricesOf(value: any) {
  requireValue(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length <= 500,
    "Preços inválidos.",
  );
  for (const [model, price] of Object.entries(value)) {
    requireValue(
      model.length > 0 &&
        model.length <= 100 &&
        price &&
        typeof price === "object" &&
        !Array.isArray(price),
      "Preço do modelo inválido.",
    );
    requireValue(
      Object.entries(price as object).every(
        ([k, v]) =>
          priceFields.includes(k) &&
          typeof v === "number" &&
          Number.isFinite(v) &&
          v >= 0,
      ),
      "Use preços em US$ por milhão de tokens ou por minuto de áudio.",
    );
  }
  return value;
}

/** A lista confirma a credencial; capacidades são as documentadas pelo adaptador. */
export async function providerModels(
  kind: string,
  key: string,
  base?: string | null,
) {
  let models: string[];
  try {
    if (kind === "typesafe") {
      const response = await safeFetch(
        `${base || "https://api.typesafe.ai/v1"}/models`,
        {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) throw new Error();
      const result = await response.json<any>();
      requireValue(Array.isArray(result?.data), "Lista de modelos inválida.");
      models = result.data
        .map((v: any) => v?.id)
        .filter((v: any) => typeof v === "string" && v.length <= 100)
        .slice(0, 500);
    } else
      models = await aiListModels(kind as AiProvider, key, base || undefined);
  } catch {
    // Nem mensagem, cabeçalho ou corpo de erro do serviço podem sair.
    throw new ApiError(
      502,
      "provider_test_failed",
      "Não foi possível verificar a chave na lista de modelos do provedor.",
    );
  }
  models = models.filter((id) => hideProviderKey(id, key) === id);
  const spec = AI_PROVIDERS[kind as AiProvider];
  return {
    models,
    capabilities:
      kind === "typesafe"
        ? { decision: true }
        : { text: true, image: spec.vision, pdf: spec.pdf, tools: true },
    verified_at: now(),
  };
}

/** Compatibilidade: scripts antigos salvam antes do teste da conexão. */
export async function createImplicitProvider(
  env: Env,
  actor: Actor,
  profile: string,
  data: any,
) {
  admin(actor);
  requireDirectPerson(actor);
  return createProvider(env, { ...data, profiles: [profile] }, false);
}
async function createProvider(env: Env, data: any, verify = true) {
  requireValue(kinds.includes(data.kind), "Escolha o tipo do provedor.");
  const key = aiKey(data.api_key);
  const name = hideProviderKey(nameOf(data.name), key);
  const profiles = await profileIds(env, data.profiles);
  const base = data.base_url
    ? publicUrl(String(data.base_url)).replace(/\/+$/, "")
    : null;
  requireValue(
    data.kind !== "compatible" || base,
    "Informe a URL da API compatível com OpenAI.",
  );
  requireValue(
    !base || hideProviderKey(base, key) === base,
    "A URL do provedor não pode conter a chave.",
  );
  let checked: any = { models: [], capabilities: {}, verified_at: null };
  if (verify) {
    try {
      checked = await providerModels(data.kind, key, base);
    } catch (error) {
      if (data.force !== true) throw error;
    }
  }
  const id = `p-${uid()}`,
    at = now();
  await batch(env, [
    [
      "INSERT INTO ai_providers(id,name,kind,base_url,profiles,capabilities,models,key_fingerprint,verified_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        name,
        data.kind,
        base,
        JSON.stringify(profiles),
        JSON.stringify(checked.capabilities),
        JSON.stringify(checked.models),
        await providerFingerprint(env, key),
        checked.verified_at,
        at,
        at,
      ],
    ],
    [
      "INSERT INTO secrets(id,value) VALUES(?,?)",
      [`provider:${id}`, await seal(env, { api_key: key })],
    ],
  ]);
  return publicProvider(await providerRow(env, id));
}

export async function providerUses(env: Env, id: string) {
  return all(
    env,
    "SELECT 'connection' kind,id,profile_id FROM connections WHERE kind='ai' AND json_extract(config,'$.provider_id')=? UNION ALL SELECT 'jev' kind,id,id profile_id FROM profiles WHERE json_extract(settings,'$.jev_provider_id')=?",
    id,
    id,
  );
}

export async function providerCommand(
  env: Env,
  actor: Actor,
  op: string,
  data: any,
) {
  refuseEngineActor(actor);
  admin(actor);
  if (op === "provider.usage") {
    const row = await providerRow(env, data.id);
    return providerUsage(env, actor, row, data.days);
  }
  if (op === "provider.create" || op === "provider.rotate")
    requireDirectPerson(actor);
  if (op === "provider.create") return createProvider(env, data);
  if (op === "provider.merge") {
    requireValue(
      data.keep !== data.remove,
      "Escolha dois provedores diferentes.",
    );
    const keep = await providerRow(env, data.keep),
      remove = await providerRow(env, data.remove);
    requireValue(
      keep.status === "active" &&
        remove.status === "active" &&
        keep.kind === remove.kind &&
        keep.base_url === remove.base_url &&
        keep.key_fingerprint &&
        keep.key_fingerprint === remove.key_fingerprint,
      "Os provedores precisam ter o mesmo tipo, URL base e chave verificada.",
    );
    const profiles = [
      ...new Set([...json(keep.profiles, []), ...json(remove.profiles, [])]),
    ];
    await batch(env, [
      [
        "UPDATE connections SET config=json_set(config,'$.provider_id',?) WHERE kind='ai' AND json_extract(config,'$.provider_id')=?",
        [keep.id, remove.id],
      ],
      [
        "UPDATE profiles SET settings=json_set(settings,'$.jev_provider_id',?) WHERE json_extract(settings,'$.jev_provider_id')=?",
        [keep.id, remove.id],
      ],
      [
        "UPDATE ai_providers SET profiles=?,updated=? WHERE id=?",
        [JSON.stringify(profiles), now(), keep.id],
      ],
      ["DELETE FROM secrets WHERE id=?", [`provider:${remove.id}`]],
      [
        "UPDATE ai_providers SET status='revoked',updated=? WHERE id=?",
        [now(), remove.id],
      ],
    ]);
    return { id: keep.id, removed: remove.id };
  }
  const row = await providerRow(env, data.id);
  if (op === "provider.update") {
    requireValue(
      data.api_key === undefined && data.key === undefined,
      "Use a operação de trocar chave para informar o segredo.",
    );
    const profiles =
      data.profiles === undefined
        ? json(row.profiles, [])
        : await profileIds(env, data.profiles);
    await exec(
      env,
      "UPDATE ai_providers SET name=?,profiles=?,capabilities=?,prices=?,updated=? WHERE id=?",
      data.name === undefined ? row.name : nameOf(data.name),
      JSON.stringify(profiles),
      data.capabilities === undefined
        ? row.capabilities
        : JSON.stringify(capabilitiesOf(data.capabilities)),
      data.prices === undefined
        ? row.prices
        : JSON.stringify(pricesOf(data.prices)),
      now(),
      row.id,
    );
  } else if (op === "provider.test" || op === "provider.rotate") {
    const key =
      op === "provider.rotate"
        ? aiKey(data.api_key)
        : await providerKey(env, row);
    const checked = await providerModels(row.kind, key, row.base_url);
    const writes: [string, any[]][] = [
      [
        "UPDATE ai_providers SET models=?,capabilities=?,verified_at=?,key_fingerprint=?,status='active',updated=? WHERE id=?",
        [
          JSON.stringify(checked.models),
          JSON.stringify(checked.capabilities),
          checked.verified_at,
          await providerFingerprint(env, key),
          now(),
          row.id,
        ],
      ],
    ];
    if (op === "provider.rotate")
      writes.push([
        "INSERT INTO secrets(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        [`provider:${row.id}`, await seal(env, { api_key: key })],
      ]);
    await batch(env, writes);
  } else if (op === "provider.revoke") {
    await batch(env, [
      ["DELETE FROM secrets WHERE id=?", [`provider:${row.id}`]],
      [
        "UPDATE ai_providers SET status='revoked',updated=? WHERE id=?",
        [now(), row.id],
      ],
    ]);
  } else if (op === "provider.delete") {
    const uses = await providerUses(env, row.id);
    if (uses.length)
      throw new ApiError(
        409,
        "provider_in_use",
        "Provedor em uso: escolha outro em cada vínculo antes de excluir.",
        uses,
      );
    await batch(env, [
      ["DELETE FROM secrets WHERE id=?", [`provider:${row.id}`]],
      ["DELETE FROM ai_providers WHERE id=?", [row.id]],
    ]);
    return { id: row.id, deleted: true };
  } else
    throw new ApiError(
      400,
      "unknown_operation",
      "Operação de provedor desconhecida.",
    );
  return publicProvider(await providerRow(env, row.id));
}

export async function providerConnectionConfig(
  env: Env,
  profile: string,
  input: any,
) {
  const row = await allowedProvider(env, input.provider_id, profile);
  requireValue(
    row.kind !== "typesafe",
    "Escolha um provedor de texto para o bot.",
  );
  return {
    ...aiConfig({ ...input, provider: row.kind, base_url: row.base_url }),
    provider_id: row.id,
  };
}

export type ProviderUsage = {
  provider_id?: string;
  model?: string;
  requests?: number;
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  audio_seconds?: number;
};
export async function addProviderUsage(
  env: Env,
  profile: string,
  use: string,
  usage: ProviderUsage,
) {
  if (!usage.provider_id || !usage.model) return;
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  await exec(
    env,
    `INSERT INTO ai_usage_daily(provider_id,profile_id,use,model,day,requests,input,cache_read,cache_write,output,audio_seconds) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(provider_id,profile_id,use,model,day) DO UPDATE SET requests=requests+excluded.requests,input=input+excluded.input,cache_read=cache_read+excluded.cache_read,cache_write=cache_write+excluded.cache_write,output=output+excluded.output,audio_seconds=audio_seconds+excluded.audio_seconds`,
    usage.provider_id,
    profile,
    use,
    usage.model,
    new Date().toISOString().slice(0, 10),
    n(usage.requests ?? 1),
    n(usage.input),
    n(usage.cache_read),
    n(usage.cache_write),
    n(usage.output),
    n(usage.audio_seconds),
  );
}
async function providerUsage(env: Env, actor: Actor, row: any, days = 30) {
  requireValue(
    Number.isInteger(days) && days >= 1 && days <= 400,
    "Informe de 1 a 400 dias.",
  );
  const since = new Date(now() - (days - 1) * 86400000)
    .toISOString()
    .slice(0, 10);
  const rows = await all(
    env,
    `SELECT day,use,model,SUM(requests) requests,SUM(input) input,SUM(cache_read) cache_read,SUM(cache_write) cache_write,SUM(output) output,SUM(audio_seconds) audio_seconds
    FROM ai_usage_daily WHERE provider_id=? AND day>=? AND (?=1 OR profile_id IN (SELECT value FROM json_each(?)))
    GROUP BY day,use,model ORDER BY day,use,model`,
    row.id,
    since,
    actor.role === "admin" ? 1 : 0,
    JSON.stringify(actor.profiles),
  );
  const prices = json(row.prices);
  const data = rows.map((r) => {
    const price = Object.hasOwn(prices, r.model) ? prices[r.model] : null;
    if (price && Object.keys(price).length)
      r.estimate_usd =
        (r.input * (price.input || 0) +
          r.cache_read * (price.cache_read || 0) +
          r.cache_write * (price.cache_write || 0) +
          r.output * (price.output || 0)) /
          1e6 +
        (r.audio_seconds / 60) * (price.audio_minute || 0);
    return r;
  });
  return { id: row.id, days, data };
}

/** Retenção por dia UTC, executada pelo cron já existente. */
export async function pruneProviderUsage(env: Env) {
  await exec(
    env,
    "DELETE FROM ai_usage_daily WHERE day<?",
    new Date(now() - 400 * 86400000).toISOString().slice(0, 10),
  );
}
