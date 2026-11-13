// Vínculo de saída com o Hermes Agent: o plugin instalado no Hermes busca
// trabalho aqui (long-poll) e executa na API local dele. Contrato em
// docs/HERMES-PLUGIN.md. Sem túnel, sem chaves do Hermes guardadas no Wabotia.
import { one, exec } from "./db";
import { ApiError, type Env, now, json, uid, requireValue } from "./types";
import { random, sha, equal, secret, setSecret } from "./security";

export const LINK_POLL_SECONDS = 25;
const CODE_TTL = 15 * 60_000;
const CALL_DEADLINE = 12_000;
// Sem poll há mais tempo que isto, a chamada falha na hora em vez de esperar.
const ONLINE_WINDOW = 60_000;
// Job entregue e sem resposta volta a ser oferecido depois deste intervalo.
const REDELIVER_AFTER = 5_000;
const MAX_JOBS = 4;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const codeShape = new RegExp(`^wabp_(${uuid})_[0-9a-f]{32}$`);
const tokenShape = new RegExp(`^wabl_(${uuid})_[0-9a-f]{64}$`);
export const linkJobId = new RegExp(`^${uuid}$`);

export type LinkOp =
  | "profiles.list"
  | "capabilities.get"
  | "runs.create"
  | "runs.get"
  | "runs.stop"
  | "artifacts.download";
export interface LinkJob {
  id: string;
  op: LinkOp;
  profile?: string;
  body?: unknown;
  run_id?: string;
  artifact_id?: string;
  idempotency_key?: string;
  deadline_ms: number;
}
interface LinkResult {
  ok: boolean;
  http_status?: number;
  body?: any;
  code?: string;
}

export const isLink = (connection: any) =>
  json(connection?.config).transport === "link";
const secretId = (id: string) => `connection:${id}`;
const badCode = () =>
  new ApiError(
    404,
    "pairing_not_found",
    "Código de pareamento inválido, usado ou expirado. Gere outro no painel.",
  );
const short = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/[\r\n]/g, " ").slice(0, max) : "";

async function linkConnection(env: Env, id: string, profile?: string) {
  const c = await one(
    env,
    "SELECT * FROM connections WHERE id=? AND kind='hermes'",
    id,
  );
  return c && isLink(c) && (!profile || c.profile_id === profile) ? c : null;
}
export function linkStub(env: Env, connectionId: string) {
  // Instância própria da classe Coordinator: a do perfil dispara as execuções
  // e não pode esperar por si mesma. Mesma classe, sem migração de Durable Object.
  return env.COORDINATOR.get(
    env.COORDINATOR.idFromName("hermes-link:" + connectionId),
  );
}
const post = (stub: DurableObjectStub, path: string, body: unknown) =>
  stub.fetch("https://coordinator" + path, {
    method: "POST",
    body: JSON.stringify(body),
  });

/** Painel: emite o código de uso único que o instalador troca pelo token. */
export async function linkCode(
  env: Env,
  profile: string,
  id: string,
  origin: string,
) {
  const c = await linkConnection(env, id, profile);
  requireValue(c, "Conexão Hermes por plugin não encontrada.");
  const code = `wabp_${c.id}_${random().slice(0, 32)}`,
    expires = now() + CODE_TTL;
  await setSecret(env, secretId(c.id), {
    ...(await secret(env, secretId(c.id))),
    link_code_hash: await sha(code),
    link_code_expires: expires,
  });
  return {
    connection_id: c.id,
    code,
    expires,
    command: `curl -fsSL ${origin}/hermes-plugin/install.sh | bash -s -- ${origin} ${code}`,
  };
}
/** Painel: corta o acesso do plugin. O próximo poll recebe 401. */
export async function linkRevoke(env: Env, profile: string, id: string) {
  const c = await linkConnection(env, id, profile);
  requireValue(c, "Conexão Hermes por plugin não encontrada.");
  const { link_code_hash, link_code_expires, link_token_hash, ...rest } =
    await secret(env, secretId(c.id));
  await setSecret(env, secretId(c.id), rest);
  const { link, ...config } = json(c.config);
  await exec(
    env,
    "UPDATE connections SET config=? WHERE id=?",
    JSON.stringify(config),
    c.id,
  );
  return { id: c.id, revoked: true };
}
export function linkCodeConnection(code: unknown) {
  const match = codeShape.exec(typeof code === "string" ? code : "");
  if (!match) throw badCode();
  return match[1];
}
// Roda serializado na instância do vínculo: o código vale uma única troca.
async function linkPair(env: Env, body: any) {
  const c = await linkConnection(env, linkCodeConnection(body?.code));
  if (!c) throw badCode();
  const { link_code_hash, link_code_expires, ...rest } = await secret(
    env,
    secretId(c.id),
  );
  if (
    !link_code_hash ||
    !equal(await sha(body.code), link_code_hash) ||
    !(link_code_expires > now())
  )
    throw badCode();
  const token = `wabl_${c.id}_${random()}`;
  await setSecret(env, secretId(c.id), {
    ...rest,
    link_token_hash: await sha(token),
  });
  await exec(
    env,
    "UPDATE connections SET config=?,last_seen=? WHERE id=?",
    JSON.stringify({
      ...json(c.config),
      link: {
        host: short(body.host, 100),
        plugin_version: short(body.plugin_version, 40),
        hermes_version: short(body.hermes_version, 40),
        paired_at: now(),
      },
    }),
    now(),
    c.id,
  );
  return {
    link_token: token,
    connection_id: c.id,
    poll_seconds: LINK_POLL_SECONDS,
  };
}
/** Autentica o plugin. O token só serve às rotas /api/hermes-link/*. */
export async function linkAuth(env: Env, request: Request) {
  const token =
      request.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1] || "",
    match = tokenShape.exec(token),
    c = match ? await linkConnection(env, match[1]) : null,
    keys = c ? await secret(env, secretId(c.id)) : {};
  if (
    !c ||
    !keys.link_token_hash ||
    !equal(await sha(token), keys.link_token_hash)
  )
    throw new ApiError(
      401,
      "invalid_token",
      "Vínculo inválido ou revogado. Pareie o plugin novamente pelo painel.",
    );
  if (!c.last_seen || c.last_seen < now() - 30_000)
    await exec(
      env,
      "UPDATE connections SET last_seen=? WHERE id=?",
      now(),
      c.id,
    );
  return c;
}
/** Envia uma operação ao plugin e espera a resposta. Falha como o modo URL: 502. */
export async function linkCall(
  env: Env,
  connection: any,
  job: Omit<LinkJob, "id" | "deadline_ms"> & {
    id?: string;
    deadline_ms?: number;
  },
) {
  const response = await post(linkStub(env, connection.id), "/link-call", {
    id: uid(),
    deadline_ms: CALL_DEADLINE,
    ...job,
  });
  const result = await response.json<LinkResult>();
  if (!result.ok)
    throw new ApiError(
      502,
      "hermes_error",
      result.code === "offline"
        ? "Hermes offline: o plugin Wabotia não está conectado."
        : result.code === "timeout"
          ? "O Hermes não respondeu a tempo pelo plugin Wabotia."
          : result.http_status
            ? `Hermes respondeu HTTP ${Number(result.http_status)}.`
            : `O plugin Wabotia recusou a operação (${short(result.code, 40) || "erro"}).`,
    );
  await exec(
    env,
    "UPDATE connections SET last_seen=? WHERE id=?",
    now(),
    connection.id,
  );
  return result.body;
}
export const linkForward = (
  env: Env,
  connectionId: string,
  path: "/link-pair" | "/link-poll" | "/link-result" | "/link-job",
  body: unknown,
) => post(linkStub(env, connectionId), path, body);

interface Waiter {
  job: LinkJob;
  handed: number;
  resolve: (result: LinkResult) => void;
}
/** Estado em memória de um vínculo, dentro da instância Coordinator dele. */
export class HermesLinkHub {
  private waiters = new Map<string, Waiter>();
  private poll: { release: (jobs: LinkJob[]) => void } | null = null;
  private lastPoll = 0;
  constructor(
    private env: Env,
    private ctx: DurableObjectState,
  ) {}
  private hand(waiters: Waiter[]) {
    for (const w of waiters) w.handed = now();
    return waiters.map((w) => w.job);
  }
  private due() {
    return [...this.waiters.values()]
      .filter((w) => w.handed < now() - REDELIVER_AFTER)
      .slice(0, MAX_JOBS);
  }
  async handle(path: string, request: Request): Promise<Response> {
    const body = await request.json<any>();
    if (path === "/link-pair")
      return this.ctx.blockConcurrencyWhile(async () => {
        try {
          return Response.json(await linkPair(this.env, body));
        } catch (error) {
          if (error instanceof ApiError)
            return Response.json(
              { error: { code: error.code, message: error.message } },
              { status: error.status },
            );
          throw error;
        }
      });
    if (path === "/link-poll") {
      this.lastPoll = now();
      // Uma reconexão substitui o poll anterior, que pode ter ficado órfão.
      this.poll?.release([]);
      let jobs = this.hand(this.due());
      if (!jobs.length) {
        jobs = await new Promise<LinkJob[]>((resolve) => {
          const me = {
            release: (value: LinkJob[]) => {
              clearTimeout(timer);
              if (this.poll === me) this.poll = null;
              resolve(value);
            },
          };
          const wait = Number(body.wait_seconds ?? LINK_POLL_SECONDS);
          const timer = setTimeout(
            () => me.release([]),
            (wait >= 0 && wait <= LINK_POLL_SECONDS
              ? wait
              : LINK_POLL_SECONDS) * 1000,
          );
          this.poll = me;
        });
        this.lastPoll = now();
      }
      return Response.json({ jobs });
    }
    if (path === "/link-call") {
      const job = body as LinkJob;
      if (!this.poll && now() - this.lastPoll > ONLINE_WINDOW)
        return Response.json({ ok: false, code: "offline" });
      const result = await new Promise<LinkResult>((resolve) => {
        const finish = (value: LinkResult) => {
          clearTimeout(timer);
          this.waiters.delete(job.id);
          resolve(value);
        };
        const timer = setTimeout(
          () => finish({ ok: false, code: "timeout" }),
          job.deadline_ms,
        );
        const waiter: Waiter = { job, handed: 0, resolve: finish };
        this.waiters.set(job.id, waiter);
        this.poll?.release(this.hand([waiter]));
      });
      return Response.json(result);
    }
    if (path === "/link-result") {
      const waiter = this.waiters.get(body.id);
      waiter?.resolve({
        ok: body.ok === true,
        http_status: Number(body.http_status) || undefined,
        body: body.body,
        code: short(body.code, 40) || undefined,
      });
      return Response.json({ received: !!waiter });
    }
    if (path === "/link-job")
      return Response.json({ op: this.waiters.get(body.id)?.job.op || null });
    return Response.json(
      { error: { code: "not_found", message: "Operação inválida." } },
      { status: 404 },
    );
  }
}
