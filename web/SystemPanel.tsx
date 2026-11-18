import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bell,
  Check,
  Cloud,
  Download,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import { EmailSection } from "./EmailSection";

type Api = (
  path: string,
  method?: string,
  body?: any,
  signal?: AbortSignal,
) => Promise<any>;
type Data = {
  updates: any;
  public_origin?: string | null;
  bot_full_personal_data?: boolean;
};
const demoData: Data = {
  public_origin: "https://atendimento.exemplo.com.br",
  updates: {
    installed: { version: "0.10.0", commit: "exemplo" },
    method: "direct",
    installation_ready: true,
    configured: true,
    available: false,
  },
};
type PushMode = "off" | "gateway" | "fcm";
type PushPreview = "preview" | "minimal";
type PushConfig = {
  mode: PushMode;
  gateway_url: string;
  gateway_secret_configured?: boolean;
  fcm_configured: boolean;
  fcm_project_id: string;
  preview: PushPreview;
  ticket_alert_minutes: number;
};
type PushForm = {
  mode: PushMode;
  gateway_url: string;
  gateway_secret: string;
  fcm_service_account: string;
  preview: PushPreview;
  ticket_alert_minutes: string;
};
const DEFAULT_GATEWAY = "https://push.wabotia.queven.app";
const demoPush: PushConfig = {
  mode: "gateway",
  gateway_url: DEFAULT_GATEWAY,
  gateway_secret_configured: false,
  fcm_configured: false,
  fcm_project_id: "",
  preview: "minimal",
  ticket_alert_minutes: 60,
};
const isPushMode = (v: string): v is PushMode =>
  v === "off" || v === "gateway" || v === "fcm";
const isPushPreview = (v: string): v is PushPreview =>
  v === "preview" || v === "minimal";
function pushForm(config: PushConfig): PushForm {
  return {
    mode: config.mode,
    gateway_url: config.gateway_url || DEFAULT_GATEWAY,
    gateway_secret: "",
    fcm_service_account: "",
    preview: config.preview,
    ticket_alert_minutes: String(config.ticket_alert_minutes ?? 60),
  };
}
const when = (n: number) =>
  new Date(n).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

function useSystem(api: Api, demo: boolean) {
  const [data, setData] = useState<Data | null>(demo ? demoData : null);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const readBusy = useRef(false);
  const refresh = useCallback(async () => {
    if (demo || readBusy.current) return;
    readBusy.current = true;
    try {
      const result = await api(
        "v1/system",
        "GET",
        undefined,
        AbortSignal.timeout(20000),
      );
      if (alive.current) {
        setData(result);
        setError("");
      }
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error
            ? e.message
            : "Não foi possível consultar o sistema.",
        );
    } finally {
      readBusy.current = false;
    }
  }, [api, demo]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  return { data, error, refresh };
}
function useAction(demo: boolean) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  async function run(label: string, task: () => Promise<void>) {
    if (lock.current) return;
    if (demo) {
      setMessage(
        "Tela de referência. Entre na sua instalação para usar esta opção.",
      );
      return;
    }
    lock.current = true;
    setBusy(label);
    setMessage("");
    setError("");
    try {
      await task();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Não foi possível concluir. Confira o andamento antes de repetir.",
      );
    } finally {
      lock.current = false;
      setBusy("");
    }
  }
  return { busy, message, error, run, setMessage };
}
function Feedback({
  busy,
  message,
  error,
}: {
  busy: string;
  message: string;
  error: string;
}) {
  return (
    <>
      {busy && (
        <p className="connection-progress" role="status">
          <Loader2 className="spin" size={16} /> {busy}
        </p>
      )}
      {message && (
        <p className="connection-result" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="connection-result error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
function Input({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...props} />
    </label>
  );
}

function AutomaticUpdates({
  api,
  demo,
  updates,
  refresh,
}: {
  api: Api;
  demo: boolean;
  updates: any;
  refresh: () => Promise<void>;
}) {
  const initial = updates.automatic || {
    enabled: false,
    hour: 3,
    window_hours: 2,
  };
  const [form, setForm] = useState({
    enabled: !!initial.enabled,
    hour: Number(initial.hour),
    window_hours: Number(initial.window_hours),
  });
  const dirty = useRef(false);
  const action = useAction(demo);
  useEffect(() => {
    if (!dirty.current)
      setForm({
        enabled: !!initial.enabled,
        hour: Number(initial.hour),
        window_hours: Number(initial.window_hours),
      });
  }, [initial.enabled, initial.hour, initial.window_hours]);
  const update = (patch: Partial<typeof form>) => {
    dirty.current = true;
    setForm((old) => ({ ...old, ...patch }));
  };
  const statuses: Record<string, string> = {
    off: "Desligadas",
    scheduled: "Aguardando a janela diária",
    checking: "Consultando a versão oficial",
    queued: "Atualização agendada",
    running: "Atualização em andamento",
    awaiting_confirmation: "Aguardando confirmação da publicação",
    retry_wait: "Aguardando nova tentativa",
    blocked: "Revisão necessária",
    up_to_date: "Nenhuma versão mais nova disponível",
    release_requires_review: "Versão exige revisão manual",
    check_failed: "Não foi possível consultar a versão",
  };
  return (
    <section className="card system-card">
      <div className="section-heading">
        <h2>
          <RefreshCw size={22} /> Atualizações automáticas
        </h2>
        <span className="badge">
          {initial.enabled ? "Ligadas" : "Desligadas"}
        </span>
      </div>
      <p>
        O Wabotia pode consultar e instalar versões oficiais mais novas durante
        uma janela diária. Usa a autorização Cloudflare já configurada nesta
        instalação.
      </p>
      <form
        className="system-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run("Salvando atualização automática…", async () => {
            await api(
              "v1/system/updates/automatic",
              "POST",
              form,
              AbortSignal.timeout(45000),
            );
            dirty.current = false;
            await refresh();
            action.setMessage(
              form.enabled
                ? "Atualização automática ligada para a janela escolhida."
                : "Atualização automática desligada. Trabalhos já iniciados terminam normalmente.",
            );
          });
        }}
      >
        <label className="check-field">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={!!action.busy || (!updates.configured && !form.enabled)}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          Instalar novas versões automaticamente
        </label>
        {!updates.configured && (
          <p>
            Primeiro configure a atualização direta no cartão acima.
          </p>
        )}
        <div className="system-grid">
          <label className="field">
            <span>Início da janela · horário de Brasília</span>
            <select
              value={form.hour}
              disabled={!!action.busy}
              onChange={(e) => update({ hour: Number(e.target.value) })}
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {String(hour).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Duração da janela</span>
            <select
              value={form.window_hours}
              disabled={!!action.busy}
              onChange={(e) => update({ window_hours: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 5, 6].map((hours) => (
                <option key={hours} value={hours}>
                  {hours} {hours === 1 ? "hora" : "horas"}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p>
          Uma consulta por janela, com até três tentativas se o serviço estiver
          indisponível. Desligar cancela o início de novos trabalhos; uma
          atualização já iniciada continua até sua confirmação. A janela define
          o início, não interrompe uma publicação em andamento.
        </p>
        <button className="button" disabled={!!action.busy || !dirty.current}>
          Salvar atualização automática
        </button>
      </form>
      <Feedback {...action} />
      <dl className="system-facts">
        <div>
          <dt>Estado</dt>
          <dd>
            {statuses[
              initial.status || (initial.enabled ? "scheduled" : "off")
            ] || initial.status}
          </dd>
        </div>
        <div>
          <dt>Última consulta automática</dt>
          <dd>
            {initial.last_checked_at
              ? when(initial.last_checked_at)
              : "Ainda não realizada"}
          </dd>
        </div>
        {initial.attempt && (
          <div>
            <dt>Tentativa de instalação</dt>
            <dd>
              {initial.attempt} de {initial.max_attempts || 3}
            </dd>
          </div>
        )}
        {(initial.retry_at || initial.check_retry_at) && (
          <div>
            <dt>Nova tentativa a partir de</dt>
            <dd>
              {when(initial.retry_at || initial.check_retry_at)} · dentro da
              janela
            </dd>
          </div>
        )}
      </dl>
      {initial.enabled && initial.error && (
        <div className="notice error" role="status">
          {initial.error}
        </div>
      )}
      <p className="muted">
        O pacote é conferido antes de publicar. Migrações incompatíveis e
        publicações sem confirmação precisam de revisão no cartão de
        atualização. Esta opção atualiza o servidor e o painel; os processos
        O conector QR é mantido separadamente.
      </p>
    </section>
  );
}

/**
 * Só no site oficial (que serve o catálogo): lembra de renovar o índice
 * assinado a partir de 60 dias da emissão (mesma regra de renewalNotice em
 * scripts/release-plan.mjs). Sem lembrete automático além deste.
 */
function IndexRenewal({ updates }: { updates: any }) {
  const index = updates.latest;
  if (!updates.distribution || !index?.expires || !index.issued_at) return null;
  const at = Date.now(),
    left = Math.floor((index.expires - at) / 86400000);
  if (index.expires > at && at - index.issued_at < 60 * 86400000) return null;
  return (
    <div className="callout" role="status">
      <strong>
        {index.expires <= at
          ? "O índice da versão oficial venceu"
          : `O índice da versão oficial vence em ${left} dia(s)`}
      </strong>
      <p>
        Enquanto estiver vencido, as instalações recusam atualizar (o
        atendimento delas continua). No computador com a chave de assinatura,
        rode <code>npm run release -- --renew</code> e publique o site.
      </p>
    </div>
  );
}

export function SystemPanel({ api, demo }: { api: Api; demo: boolean }) {
  const system = useSystem(api, demo),
    action = useAction(demo);
  const [updateToken, setUpdateToken] = useState("");
  const [stopped, setStopped] = useState(false);
  const [dropInitial, setDropInitial] = useState(false);
  const [jobToken, setJobToken] = useState("");
  const [modeToken, setModeToken] = useState("");
  const [modeConfirm, setModeConfirm] = useState(false);
  const [editingMode, setEditingMode] = useState(false);
  const [editingHook, setEditingHook] = useState(false);
  const data = system.data;
  if (!data)
    return (
      <Feedback
        busy={system.error ? "" : "Carregando configurações…"}
        message=""
        error={system.error}
      />
    );
  const u = data.updates,
    state = u.state;
  const updating =
    state &&
    ["pending", "sending", "requested", "unknown"].includes(state.status);
  const mutate = (path: string, body: any) =>
    api("v1/system/" + path, "POST", body, AbortSignal.timeout(45000));
  return (
    <div className="system-stack">
      <Feedback {...action} error={action.error || system.error} />
      <section className="card system-card">
        <div className="section-heading">
          <h2>
            <RefreshCw size={22} /> Atualizar Wabotia
          </h2>
          <span className="badge active">v{u.installed.version}</span>
        </div>
        <p>
          Instale as versões oficiais publicadas do Wabotia. A atualização
          direta na Cloudflare mantém seu banco, mídias, domínios e credenciais.
        </p>
        <IndexRenewal updates={u} />
        <dl className="system-facts">
          <div>
            <dt>Versão instalada</dt>
            <dd>
              <code>{u.installed.commit.slice(0, 12)}</code>
            </dd>
          </div>
          <div>
            <dt>Última consulta</dt>
            <dd>
              {u.latest ? when(u.latest.checked_at) : "Ainda não consultada"}
            </dd>
          </div>
        </dl>
        {u.latest && (
          <p>
            {u.available
              ? "Atualização disponível"
              : "Você está na versão consultada"}
            :{" "}
            <a
              className="text-link"
              href={u.latest.url}
              target="_blank"
              rel="noreferrer"
            >
              v{u.latest.version} · {u.latest.commit.slice(0, 12)}
            </a>
          </p>
        )}
        <div className="card-actions">
          <button
            className="button secondary"
            disabled={!!action.busy}
            onClick={() =>
              action.run("Consultando versão oficial…", async () => {
                await api("v1/system/updates/check");
                await system.refresh();
                action.setMessage(
                  "Consulta concluída. O resultado é atualizado a cada cinco minutos.",
                );
              })
            }
          >
            <RefreshCw size={16} /> Verificar atualização
          </button>
          {u.available &&
            u.configured &&
            !updating &&
            u.token_source !== "per_update" && (
              <button
                className="button"
                disabled={!!action.busy}
                onClick={() =>
                  action.run("Solicitando atualização…", async () => {
                    await mutate("updates/start", { commit: u.latest.commit });
                    await system.refresh();
                    action.setMessage(
                      "Pedido registrado. Acompanhe a confirmação abaixo; você pode continuar usando o painel.",
                    );
                  })
                }
              >
                Atualizar Wabotia <ArrowRight size={16} />
              </button>
            )}
        </div>
        {u.available && !updating && u.token_source === "per_update" && (
          <form
            className="system-form"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run("Conferindo o token e solicitando…", async () => {
                await mutate("updates/start", {
                  commit: u.latest.commit,
                  token: jobToken,
                });
                setJobToken("");
                await system.refresh();
                action.setMessage(
                  "Pedido registrado. O token fica guardado só durante esta atualização, por até 60 minutos, e é apagado no fim.",
                );
              });
            }}
          >
            <p>
              Esta instalação não guarda token. Cole um token com{" "}
              <strong>Workers Scripts: Edit</strong> para esta atualização.
            </p>
            <Input
              label="Token Cloudflare desta atualização"
              type="password"
              autoComplete="off"
              value={jobToken}
              onChange={(e) => setJobToken(e.target.value)}
              required
            />
            <button className="button" disabled={!!action.busy}>
              Atualizar Wabotia <ArrowRight size={16} />
            </button>
          </form>
        )}
        {updating && (
          <div className="callout" role="status">
            <strong>
              {state.status === "unknown"
                ? "Pedido sem confirmação"
                : "Atualização em andamento"}
            </strong>
            <p>
              {state.error ||
                "A Cloudflare está preparando a versão. O painel confirmará quando o novo código estiver no ar. Isso pode levar alguns minutos."}
            </p>
            <small>
              {state.phase && (
                <>
                  Etapa:{" "}
                  {(
                    {
                      download: "baixando a versão",
                      manifest: "conferindo a versão",
                      blobs: "baixando arquivos",
                      prepare: "verificando instalação",
                      assets: "enviando arquivos",
                      migrate: "preparando banco",
                      publish: "publicando",
                    } as Record<string, string>
                  )[state.phase] || state.phase}{" "}
                  ·{" "}
                </>
              )}
              Versão solicitada: {state.target.slice(0, 12)} ·{" "}
              {when(state.created)}
            </small>
          </div>
        )}
        {state?.status === "completed" && (
          <div className="connection-result">
            <strong>
              <Check size={17} /> Atualização publicada e verificada.
            </strong>
            <p>Reabra o painel para carregar as novas telas.</p>
            <button
              className="button secondary"
              onClick={() => location.reload()}
            >
              Reabrir painel atualizado
            </button>
          </div>
        )}
        {(u.review_required || state?.status === "failed") && (
          <div className="callout">
            <p>
              {state.error ||
                (state.status === "pending"
                  ? "A atualização está parada há mais de 30 minutos sem avançar."
                  : "")}{" "}
              Abra seu Worker na Cloudflare, confira a aba Implantações e
              resolva o erro exibido.
            </p>
            <label className="check-field">
              <input
                type="checkbox"
                checked={stopped}
                onChange={(e) => setStopped(e.target.checked)}
              />{" "}
              Conferi a versão instalada e a publicação anterior já terminou.
            </label>
            <button
              className="button secondary"
              disabled={!stopped || !!action.busy}
              onClick={() =>
                action.run("Liberando nova tentativa…", async () => {
                  await mutate("updates/reset", {
                    confirmed_build_stopped: stopped,
                  });
                  setStopped(false);
                  await system.refresh();
                })
              }
            >
              Liberar nova tentativa
            </button>
          </div>
        )}
        {u.token_source === "initial" && (
          <div className="callout">
            <strong>Token inicial em uso</strong>
            <p>
              O atualizador usa o token da instalação, que também tem{" "}
              <strong>D1: Edit</strong> e{" "}
              <strong>Workers R2 Storage: Edit</strong>. Essas permissões só
              servem para instalar. Salve abaixo um token
              só com <strong>Workers Scripts: Edit</strong> e depois apague o
              inicial: a instalação deixa de guardar permissão sobre o banco e
              as mídias da sua conta.
            </p>
            {!editingHook && (
              <button
                className="button secondary"
                onClick={() => setEditingHook(true)}
              >
                Salvar um token só de Workers
              </button>
            )}
          </div>
        )}
        {u.token_source === "panel" && u.initial_token_stored && (
          <div className="callout">
            <strong>O token inicial ainda está guardado</strong>
            <p>
              O atualizador já usa o token salvo no painel, mas o token da
              instalação, com D1 e R2, continua guardado no Worker como reserva.
              Apague-o para a instalação guardar só o token de Workers. Depois
              não há reserva: se você revogar o token do painel, a atualização
              para até você salvar outro. Revogue também o token inicial na
              Cloudflare (My Profile → API Tokens).
            </p>
            <label className="check-field">
              <input
                type="checkbox"
                checked={dropInitial}
                onChange={(e) => setDropInitial(e.target.checked)}
              />{" "}
              Entendi: o token do painel passa a ser o único.
            </label>
            <button
              className="button secondary"
              disabled={!dropInitial || !!action.busy || updating}
              onClick={() =>
                action.run("Apagando o token inicial…", async () => {
                  await mutate("updates/initial-token/delete", {
                    confirmed: dropInitial,
                  });
                  setDropInitial(false);
                  await system.refresh();
                  action.setMessage(
                    "Token inicial apagado do Worker. Revogue-o também na Cloudflare.",
                  );
                })
              }
            >
              Apagar o token inicial
            </button>
          </div>
        )}
        <button
          className="text-link"
          onClick={() => setEditingHook(!editingHook)}
        >
          {u.configured
            ? "Alterar configuração de atualização"
            : "Configurar atualização pelo painel"}{" "}
          <ArrowRight size={16} />
        </button>
        {(editingHook || !u.configured) &&
          (u.installation_ready ? (
            <form
              className="system-form"
              onSubmit={(e) => {
                e.preventDefault();
                void action.run(
                  "Verificando autorização da atualização…",
                  async () => {
                    await mutate("updates/configure", { token: updateToken });
                    setUpdateToken("");
                    setEditingHook(false);
                    await system.refresh();
                    action.setMessage("Atualização direta autorizada.");
                  },
                );
              }}
            >
              <p>
                Instalação: <strong>{u.worker_name}</strong>. O instalador já
                configura a atualização. Use este campo para renovar ou
                substituir o token.
              </p>
              <p>
                Na Cloudflare, abra My Profile → API Tokens → Create Token →
                Custom Token. Permissão de conta:{" "}
                <strong>Workers Scripts: Edit</strong>. Limite à conta desta
                instalação. Esse token permite publicar Workers nessa conta.
                Banco, mídias e credenciais continuam na sua Cloudflare.
              </p>
              <Input
                label="Token Cloudflare para atualizações"
                type="password"
                autoComplete="new-password"
                value={updateToken}
                onChange={(e) => setUpdateToken(e.target.value)}
                required
              />
              <button className="button" disabled={!!action.busy || updating}>
                Verificar e salvar token
              </button>
            </form>
          ) : (
            <div className="callout">
              <p>
                Esta instalação não tem a identificação para atualizar pelo
                painel. Use o instalador para criar uma instalação sem
                repositório próprio.
              </p>
              <a href="/install#reinstalar" className="text-link">
                Ver o roteiro de reinstalação
              </a>
            </div>
          ))}
        {u.installation_ready && u.token_source === "per_update" && (
          <div className="callout">
            <strong>Token colado a cada atualização</strong>
            <p>
              Esta instalação não guarda token da Cloudflare. Cada atualização
              pede o token; ele fica cifrado só enquanto ela roda (até 60
              minutos) e é apagado no fim. Isso encolhe a janela de sempre para
              minutos por atualização; não protege contra código rodando no
              Worker durante esses minutos. A atualização automática fica
              desligada. Para voltar a guardar um token, use Alterar
              configuração de atualização.
            </p>
          </div>
        )}
        {u.installation_ready && u.token_source !== "per_update" && (
          <>
            {u.fiscal_vault_configured && !editingMode && (
              <div className="callout">
                <p>
                  O cofre do certificado está nesta conta Cloudflare. Para não
                  deixar o token de atualização guardado aqui, use “colar o
                  token a cada atualização”.
                </p>
              </div>
            )}
            <button
              className="text-link"
              onClick={() => setEditingMode(!editingMode)}
            >
              Colar o token a cada atualização <ArrowRight size={16} />
            </button>
            {editingMode && (
              <form
                className="system-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action.run("Conferindo o token…", async () => {
                    const r = await mutate("updates/token-mode", {
                      token: modeToken,
                      confirmed: modeConfirm,
                    });
                    setModeToken("");
                    setModeConfirm(false);
                    setEditingMode(false);
                    await system.refresh();
                    action.setMessage(
                      "Pronto: nenhum token guardado." +
                        (r?.initial_deleted
                          ? " O token inicial foi apagado do Worker; revogue-o também na Cloudflare."
                          : "") +
                        (r?.automatic_disabled
                          ? " A atualização automática foi desligada."
                          : ""),
                    );
                  });
                }}
              >
                <p>
                  A instalação deixa de guardar token: apaga o token salvo no
                  painel e o token inicial do Worker, e cada atualização pede o
                  token de novo. Isso encolhe a janela de sempre para minutos
                  por atualização; não protege contra código rodando no Worker
                  durante esses minutos.
                </p>
                <p>
                  A atualização automática fica desligada: ela precisa de um
                  token guardado.
                </p>
                <Input
                  label="Token Cloudflare (Workers Scripts: Edit)"
                  type="password"
                  autoComplete="off"
                  value={modeToken}
                  onChange={(e) => setModeToken(e.target.value)}
                  required
                />
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={modeConfirm}
                    onChange={(e) => setModeConfirm(e.target.checked)}
                  />{" "}
                  Entendi: sem atualização automática, e cada atualização pede
                  o token.
                </label>
                <button
                  className="button secondary"
                  disabled={!modeConfirm || !!action.busy || updating}
                >
                  Deixar de guardar o token
                </button>
              </form>
            )}
          </>
        )}
      </section>
      <AutomaticUpdates
        api={api}
        demo={demo}
        updates={u}
        refresh={system.refresh}
      />
      <PublicOriginSection
        api={api}
        demo={demo}
        current={data.public_origin || ""}
        refresh={system.refresh}
      />
      <BotPersonalDataSection
        api={api}
        demo={demo}
        current={!!data.bot_full_personal_data}
        refresh={system.refresh}
      />
      <PushSection api={api} demo={demo} />
      <EmailSection
        api={api}
        demo={demo}
      />
    </div>
  );
}

/**
 * Bot da conversa interna agindo pela pessoa (src/bot-actions): por padrão,
 * as consultas que ele faz chegam ao modelo com dado pessoal mascarado. O
 * administrador pode liberar, sabendo que os dados vão ao provedor de IA.
 */
function BotPersonalDataSection({
  api,
  demo,
  current,
  refresh,
}: {
  api: Api;
  demo: boolean;
  current: boolean;
  refresh: () => Promise<void>;
}) {
  const action = useAction(demo);
  const [checked, setChecked] = useState(current);
  useEffect(() => setChecked(current), [current]);
  return (
    <section className="card system-card">
      <div className="section-heading">
        <h2>
          <ShieldCheck size={22} /> Bot e dados pessoais
        </h2>
        <span className={"badge " + (current ? "paused" : "active")}>
          {current ? "Dados completos" : "Mascarados"}
        </span>
      </div>
      <p>
        Na conversa interna, o bot consulta e propõe ações em nome de quem
        pediu, com o acesso dessa pessoa. Por padrão, telefone, documento,
        e-mail, endereço e observações chegam ao modelo de IA mascarados.
      </p>
      <form
        className="system-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run("Salvando…", async () => {
            await api("v1/system/bot-actions/configure", "POST", {
              full_personal_data: checked,
            });
            await refresh();
            action.setMessage(
              checked
                ? "O bot passa a ver dados pessoais completos nas consultas internas."
                : "As consultas do bot voltam a chegar mascaradas.",
            );
          });
        }}
      >
        <label className="system-check">
          <input
            type="checkbox"
            checked={checked}
            disabled={!!action.busy}
            onChange={(e) => setChecked(e.target.checked)}
          />{" "}
          Permitir que o bot veja dados pessoais completos nas consultas
          internas
        </label>
        <p className="muted">
          Atenção: ligado, os dados pessoais dos clientes consultados são
          enviados ao provedor de IA do bot (Anthropic, OpenAI, DeepSeek ou
          outro), inclusive fora do Brasil. Mesmo ligado, o bot só vê o que a
          própria pessoa pode ver.
        </p>
        <button
          className="button"
          disabled={!!action.busy || checked === current}
        >
          Salvar
        </button>
      </form>
      <Feedback {...action} />
    </section>
  );
}

/**
 * Endereço público: base dos links enviados aos clientes (passo web,
 * carrinho, check-in) e do aviso de pagamento do Mercado Pago. Fica fixo;
 * abrir o painel por outro nome não muda (POST v1/system/origin/configure).
 */
function PublicOriginSection({
  api,
  demo,
  current,
  refresh,
}: {
  api: Api;
  demo: boolean;
  current: string;
  refresh: () => Promise<void>;
}) {
  const action = useAction(demo);
  const [value, setValue] = useState(current);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setValue(current);
  }, [current]);
  return (
    <section className="card system-card">
      <div className="section-heading">
        <h2>
          <ShieldCheck size={22} /> Endereço público
        </h2>
        <span className={"badge " + (current ? "active" : "paused")}>
          {current ? "Definido" : "Ainda não definido"}
        </span>
      </div>
      <p>
        Base dos links que os clientes recebem (formulários, carrinho, check-in)
        e do aviso de pagamento do Mercado Pago. Use o endereço pelo qual os
        clientes acessam esta instalação. Ele não muda quando o painel é aberto
        por outro nome.
      </p>
      <form
        className="system-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run("Salvando endereço público…", async () => {
            const saved = await api(
              "v1/system/origin/configure",
              "POST",
              { public_origin: value.trim() },
              AbortSignal.timeout(45000),
            );
            dirty.current = false;
            setValue(saved.public_origin);
            await refresh();
            action.setMessage(
              "Endereço público salvo. Os próximos links usam este endereço.",
            );
          });
        }}
      >
        <Input
          label="Endereço HTTPS, sem caminho"
          name="public_origin"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://atendimento.exemplo.com.br"
          value={value}
          disabled={!!action.busy}
          onChange={(e) => {
            dirty.current = true;
            setValue(e.target.value);
          }}
          pattern="https://[^/\s]+/?"
          required
        />
        <button
          className="button"
          disabled={!!action.busy || !dirty.current || !value.trim()}
        >
          Salvar endereço público
        </button>
      </form>
      <Feedback {...action} />
      <p className="muted">
        Links já enviados continuam com o endereço antigo. Trocar o endereço não
        muda o webhook das cobranças já criadas no Mercado Pago.
      </p>
    </section>
  );
}

function PushSection({ api, demo }: { api: Api; demo: boolean }) {
  const action = useAction(demo);
  const [config, setConfig] = useState<PushConfig | null>(
    demo ? demoPush : null,
  );
  const [form, setForm] = useState<PushForm>(pushForm(demoPush));
  const [loadError, setLoadError] = useState("");
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (demo) return;
    try {
      const result: PushConfig = await api(
        "v1/system/push",
        "GET",
        undefined,
        AbortSignal.timeout(20000),
      );
      if (alive.current) {
        setConfig(result);
        setForm(pushForm(result));
        setLoadError("");
      }
    } catch (e) {
      if (alive.current)
        setLoadError(
          e instanceof Error
            ? e.message
            : "Não foi possível consultar as notificações.",
        );
    }
  }, [api, demo]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  const set = <K extends keyof PushForm>(name: K, value: PushForm[K]) =>
    setForm((f) => ({ ...f, [name]: value }));
  const statusLabel =
    !config || config.mode === "off"
      ? "Desligado"
      : config.mode === "gateway"
        ? "Gateway"
        : config.fcm_configured
          ? "FCM direto"
          : "FCM sem conta";
  return (
    <section className="card system-card">
      <div className="section-heading">
        <h2>
          <Smartphone size={22} /> Notificações dos aplicativos
        </h2>
        <span
          className={
            "badge " + (config && config.mode !== "off" ? "active" : "paused")
          }
        >
          {statusLabel}
        </span>
      </div>
      <p>
        Os aplicativos Wabotia para Android e iOS, disponíveis nas lojas, se
        conectam a esta instalação informando o endereço do servidor e o login
        de atendente. Aqui você define como este servidor envia avisos de
        mensagens, fila, transferências, protocolos e ligações aos aparelhos.
        Detalhes em <code>docs/MOBILE.md</code>.
      </p>
      <Feedback {...action} error={action.error || loadError} />
      {!config && !loadError ? (
        <p className="connection-progress" role="status">
          <Loader2 className="spin" size={16} /> Carregando notificações…
        </p>
      ) : (
        <form
          className="system-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run("Salvando notificações…", async () => {
              const minutes = Number(form.ticket_alert_minutes);
              if (!Number.isInteger(minutes) || minutes < 0)
                throw Error("Informe os minutos do alerta como inteiro ≥ 0.");
              if (form.mode === "fcm" && form.fcm_service_account.trim()) {
                try {
                  JSON.parse(form.fcm_service_account);
                } catch {
                  throw Error(
                    "A conta de serviço FCM precisa ser um JSON válido.",
                  );
                }
              }
              const body: Record<string, unknown> = {
                mode: form.mode,
                preview: form.preview,
                ticket_alert_minutes: minutes,
              };
              if (form.mode === "gateway") {
                body.gateway_url = form.gateway_url.trim() || DEFAULT_GATEWAY;
                if (form.gateway_secret)
                  body.gateway_secret = form.gateway_secret;
              }
              if (form.mode === "fcm" && form.fcm_service_account.trim())
                body.fcm_service_account = form.fcm_service_account.trim();
              const result: PushConfig = await api(
                "v1/system/push/configure",
                "POST",
                body,
                AbortSignal.timeout(45000),
              );
              setConfig(result);
              setForm(pushForm(result));
              action.setMessage(
                result.mode === "off"
                  ? "Notificações desligadas. Os aplicativos continuam funcionando em primeiro plano."
                  : "Notificações salvas. Use “Enviar teste” para conferir nos aparelhos conectados.",
              );
            });
          }}
        >
          <div className="system-grid">
            <label className="field">
              <span>Modo</span>
              <select
                value={form.mode}
                onChange={(e) => {
                  if (isPushMode(e.target.value)) set("mode", e.target.value);
                }}
              >
                <option value="off">Desligado</option>
                <option value="gateway">Gateway Wabotia</option>
                <option value="fcm">FCM direto</option>
              </select>
            </label>
            <label className="field">
              <span>Conteúdo das notificações</span>
              <select
                value={form.preview}
                onChange={(e) => {
                  if (isPushPreview(e.target.value))
                    set("preview", e.target.value);
                }}
              >
                <option value="minimal">Mínimo (apenas “Nova mensagem”)</option>
                <option value="preview">Prévia (nome e trecho do texto)</option>
              </select>
            </label>
            <Input
              label="Alerta de protocolo (minutos antes do prazo; 0 desativa)"
              type="number"
              min="0"
              max="10080"
              step="1"
              value={form.ticket_alert_minutes}
              onChange={(e) => set("ticket_alert_minutes", e.target.value)}
              required
            />
          </div>
          <small>
            O conteúdo das notificações passa pelo provedor de push (Google e
            Apple) e, no modo gateway, também pelo gateway escolhido. O modo
            mínimo não envia nomes nem trechos de mensagens; é o recomendado ao
            usar um gateway de terceiros.
          </small>
          {form.mode === "gateway" && (
            <>
              <p>
                O gateway guarda as credenciais Firebase do aplicativo publicado
                e repassa as notificações sem receber as credenciais desta
                instalação. O padrão é operado pela Queven; quem compila o
                próprio aplicativo pode publicar um gateway próprio.
              </p>
              <div className="system-grid">
                <Input
                  label="URL do gateway"
                  type="url"
                  autoComplete="off"
                  placeholder={DEFAULT_GATEWAY}
                  value={form.gateway_url}
                  onChange={(e) => set("gateway_url", e.target.value.trim())}
                  required
                />
                <Input
                  label={
                    config?.gateway_secret_configured
                      ? "Segredo do gateway (configurado; vazio mantém)"
                      : "Segredo do gateway (opcional)"
                  }
                  type="password"
                  autoComplete="new-password"
                  value={form.gateway_secret}
                  onChange={(e) => set("gateway_secret", e.target.value)}
                />
              </div>
              <small>
                Preencha o segredo somente se o gateway foi publicado com{" "}
                <code>GATEWAY_SHARED_SECRET</code>. Ele é guardado criptografado
                e não volta a ser exibido.
              </small>
            </>
          )}
          {form.mode === "fcm" && (
            <>
              <p>
                {config?.fcm_configured ? (
                  <>
                    Conta configurada: projeto{" "}
                    <strong>
                      {config.fcm_project_id || "sem identificação"}
                    </strong>
                    . Cole um novo JSON somente para substituí-la.
                  </>
                ) : (
                  <>
                    Cole o JSON da conta de serviço do seu projeto Firebase com
                    o papel <strong>Firebase Cloud Messaging API Admin</strong>.
                    Esse modo exige um aplicativo compilado com o mesmo projeto;
                    o aplicativo das lojas usa o gateway.
                  </>
                )}
              </p>
              <label className="field">
                <span>
                  {config?.fcm_configured
                    ? "Nova conta de serviço FCM (JSON; vazio mantém a atual)"
                    : "Conta de serviço FCM (JSON)"}
                </span>
                <textarea
                  rows={6}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder='{"type":"service_account","project_id":"…"}'
                  value={form.fcm_service_account}
                  onChange={(e) => set("fcm_service_account", e.target.value)}
                  required={!config?.fcm_configured}
                />
              </label>
              <small>
                A conta é guardada criptografada e nunca é exibida de volta.
              </small>
            </>
          )}
          <div className="card-actions">
            <button className="button" disabled={!!action.busy}>
              <Check size={17} /> Salvar notificações
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!!action.busy || !config || config.mode === "off"}
              onClick={() =>
                action.run("Enviando notificação de teste…", async () => {
                  const result: { results?: { status?: string }[] } = await api(
                    "v1/system/push/test",
                    "POST",
                    {},
                    AbortSignal.timeout(45000),
                  );
                  // O servidor responde {results:[{status}]}, um por dispositivo.
                  const results: { status?: string }[] = Array.isArray(
                      result?.results,
                    )
                      ? result.results
                      : [],
                    devices = results.length,
                    sent = results.filter((r) => r.status === "ok").length;
                  action.setMessage(
                    devices === 0
                      ? "Nenhum dispositivo registrado para a sua conta. Entre no aplicativo neste servidor e repita o teste."
                      : `Teste enviado: ${sent} de ${devices} dispositivo${devices === 1 ? "" : "s"} aceito${sent === 1 ? "" : "s"} pelo provedor.`,
                  );
                })
              }
            >
              <Bell size={16} /> Enviar teste
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
