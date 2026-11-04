import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Code2,
  Download,
  FileText,
  Headphones,
  LayoutDashboard,
  Link2,
  Loader2,
  LogOut,
  Menu,
  MessageCircle,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Star,
  Users,
  X,
  Activity,
  Copy,
  Plug,
  Zap,
  Globe,
} from "lucide-react";
import "./style.css";
import { InstallKeys } from "./InstallKeys";
type Row = Record<string, any>;
const sections = [
  ["overview", "Visão geral", LayoutDashboard],
  ["conversations", "Conversas", MessageCircle],
  ["tickets", "Protocolos", FileText],
  ["bots", "Equipe Bot", Bot],
  ["knowledge", "Conhecimento", BookOpen],
  ["presence", "Disponibilidade", Headphones],
  ["reports", "Relatórios", Activity],
  ["surveys", "Avaliações", Star],
  ["consents", "Consentimentos", ShieldCheck],
  ["settings", "Menus e preferências", Settings],
  ["connections", "Conexões", Plug],
  ["users", "Pessoas", Users],
  ["applications", "API e integrações", Code2],
  ["bot-runs", "Execuções", Bot],
  ["deliveries", "Entregas", Send],
  ["webhook-deliveries", "Webhooks", Zap],
] as const;
async function api(path: string, method = "GET", body?: any): Promise<any> {
  const response = await fetch("/api/" + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(method !== "GET" ? { "Idempotency-Key": crypto.randomUUID() } : {}),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const data: any = await response.json();
  if (!response.ok)
    throw new Error(data.error?.message || "Não foi possível concluir.");
  return data;
}
const date = (n: number) =>
  n
    ? new Date(n).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";
const parse = (v: any, f: any = {}) => {
  if (typeof v !== "string") return v || f;
  try {
    return JSON.parse(v);
  } catch {
    return f;
  }
};
const statusNames: Row = {
  ai: "Com a IA",
  waiting: "Na fila",
  human: "Com atendente",
  closed: "Concluído",
  open: "Aberto",
  in_progress: "Em andamento",
  active: "Conectado",
  paused: "Pausado",
  pending: "Pendente",
  sent: "Enviado",
  failed: "Falhou",
  unknown: "Conferir entrega",
  ready: "Disponível",
  unavailable: "Indisponível",
  queued: "Na fila",
  completed: "Concluído",
  running: "Em execução",
  granted: "Autorizado",
  revoked: "Revogado",
  answered: "Respondida",
};
function Badge({ value }: { value: string }) {
  return (
    <span className={"badge " + value}>{statusNames[value] || value}</span>
  );
}
function Logo({ light = false }: { light?: boolean }) {
  return (
    <a className={"logo " + (light ? "light" : "")} href="/">
      <span className="logo-icon">
        <MessageCircle size={19} fill="currentColor" />
        <span />
      </span>
      wabotia<span className="logo-dot">.</span>
    </a>
  );
}
function Button({
  children,
  onClick,
  secondary = false,
  disabled = false,
  type = "button",
}: any) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={secondary ? "button secondary" : "button"}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function Field({
  label,
  value,
  onChange,
  type = "text",
  options,
  placeholder,
  required = false,
}: any) {
  return (
    <label className="field">
      <span>{label}</span>
      {options ? (
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          required={required}
        >
          <option value="">Selecione...</option>
          {options.map((o: any) => (
            <option key={o.id ?? o[0]} value={o.id ?? o[0]}>
              {o.name ?? o[1]}
            </option>
          ))}
        </select>
      ) : type === "textarea" ? (
        <textarea
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      ) : (
        <input
          type={type}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
        />
      )}
    </label>
  );
}
function Modal({ title, children, close }: any) {
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={close} aria-label="Fechar">
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function Empty({
  title = "Tudo pronto para começar",
  description = "Os registros aparecerão aqui quando seu atendimento começar.",
}: any) {
  return (
    <div className="empty">
      <span>
        <MessageCircle size={28} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
function CopyButton({ value }: any) {
  const [copied, set] = useState(false);
  return (
    <button
      className="icon-button"
      aria-label="Copiar"
      onClick={() =>
        navigator.clipboard.writeText(value).then(() => {
          set(true);
          setTimeout(() => set(false), 2000);
        })
      }
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}
function Landing() {
  return (
    <div className="landing">
      <nav className="landing-nav">
        <Logo />
        <div>
          <a href="#como-funciona">Como funciona</a>
          <a href="/install">Instalação</a>
          <a href="/api-docs">Para desenvolvedores</a>
        </div>
        <a className="button small" href="/app">
          Abrir painel <ArrowUpRight size={16} />
        </a>
      </nav>
      <main>
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow">
              <span /> CÓDIGO ABERTO · FEITO PARA O HERMES
            </div>
            <h1>
              Conversas que
              <br />
              chegam ao
              <br />
              <em>lugar certo.</em>
            </h1>
            <p>
              Seus bots, sua equipe e seus clientes. Um atendimento conectado no
              WhatsApp, com a inteligência do Hermes e o controle nas suas mãos.
            </p>
            <div className="hero-actions">
              <a className="button" href="/install#vincular-contas">
                Publicar na Cloudflare <Cloud size={19} />
              </a>
              <a className="text-link" href="/install">
                Ver passo a passo <ArrowRight size={17} />
              </a>
            </div>
            <div className="hero-proof">
              <ShieldCheck size={16} /> Na sua conta Cloudflare. Com os seus
              dados.
            </div>
          </div>
          <div className="hero-visual">
            <div className="orbit orbit1" />
            <div className="orbit orbit2" />
            <div className="connection-chip chip-hermes">
              <Bot /> Hermes <span>Inteligência</span>
            </div>
            <div className="connection-chip chip-team">
              <Users /> Sua equipe <span>Atendimento humano</span>
            </div>
            <div className="connection-chip chip-api">
              <Code2 /> Seus sistemas <span>API aberta</span>
            </div>
            <div className="hero-card">
              <div className="hero-card-top">
                <span className="mini-logo">
                  <MessageCircle size={18} />
                </span>
                <strong>Um atendimento, conectado.</strong>
                <span className="online-dot" />
              </div>
              <div className="hero-chat customer">
                Olá! Preciso de ajuda com meu pedido.
                <span>Cliente · WhatsApp</span>
              </div>
              <div className="hero-chat assistant">
                Claro! Vou consultar as informações e ajudar você.
                <span>Atendente · Hermes</span>
              </div>
              <div className="handoff">
                <Check size={14} /> Contexto preservado, do bot à equipe.
              </div>
              <div className="hero-card-bottom">
                <span>WhatsApp</span>
                <span>Telegram</span>
                <span>Web + API</span>
              </div>
            </div>
            <span className="visual-caption">
              Uma visão de como seu atendimento se conecta.
            </span>
          </div>
        </section>
        <section className="feature-band" id="como-funciona">
          <div>
            <span className="step-no">01</span>
            <h3>Conecte seu Hermes</h3>
            <p>
              Local, em Docker ou na sua VPS. Ligue seus bots ao painel por uma
              conexão segura.
            </p>
          </div>
          <div>
            <span className="step-no">02</span>
            <h3>Organize o atendimento</h3>
            <p>Conversas, protocolos, conhecimento e equipe no mesmo lugar.</p>
          </div>
          <div>
            <span className="step-no">03</span>
            <h3>Integre seus sistemas</h3>
            <p>
              Uma API documentada para mensagens, chamados e execução de bots.
            </p>
          </div>
        </section>
        <section className="landing-bottom">
          <div>
            <div className="eyebrow">SIMPLES DE OPERAR. SEU PARA EVOLUIR.</div>
            <h2>Comece com um guia ao seu lado.</h2>
            <p>
              Do primeiro deploy à primeira conversa, com instruções em
              português.
            </p>
          </div>
          <a className="button secondary" href="/install">
            Abrir guia de instalação <ArrowRight size={18} />
          </a>
        </section>
      </main>
      <footer>
        <Logo />
        <span>MIT · Quevenapp</span>
        <a href="https://github.com/Quevenapp/Wabotia">
          Código no GitHub <ArrowUpRight size={14} />
        </a>
      </footer>
    </div>
  );
}
const installSteps = [
  [
    "Vincule Cloudflare e GitHub",
    "Primeiro, conecte sua conta GitHub em Workers & Pages na Cloudflare, conforme explicado acima. Confira que ela aparece em Git account. Depois gere as chaves e abra o botão de deploy do Wabotia.",
  ],
  [
    "Publique o Wabotia",
    "Gere e guarde as duas chaves acima. Clique em “Deploy to Cloudflare” e cole cada valor no campo de mesmo nome: MASTER_KEY e SETUP_TOKEN. O guia PDF mostra o caminho alternativo pelo terminal.",
  ],
  [
    "Prepare o banco",
    "Confirme que o comando de deploy é npm run deploy: ele prepara o banco automaticamente. Abra a URL do seu Worker e clique em “Abrir painel” para criar a conta de administrador usando SETUP_TOKEN.",
  ],
  [
    "Conecte o Hermes",
    "Crie um perfil de atendimento. Em Conexões, escolha Hermes, informe as URLs das APIs e suas chaves. Clique em Testar conexão e depois selecione os bots disponíveis.",
  ],
  [
    "Escolha seus canais",
    "Conecte Meta ou QR e configure um bot Telegram dedicado com um grupo privado de tópicos. Ative somente um modo por número. O QR precisa de seu conector ligado.",
  ],
  [
    "Faça sua primeira conversa",
    "Cadastre conhecimento, selecione o Atendente, marque sua presença e ative o atendimento. Use um número de teste para conferir mensagens, transferência humana e anexos.",
  ],
];
function Install() {
  useEffect(() => {
    if (location.hash === "#vincular-contas")
      document.getElementById("vincular-contas")?.scrollIntoView();
  }, []);
  return (
    <div className="guide-page">
      <nav className="landing-nav">
        <Logo />
        <a href="/" className="text-link">
          Voltar ao início
        </a>
      </nav>
      <main>
        <div className="eyebrow">GUIA DE INSTALAÇÃO</div>
        <h1>
          Seu primeiro atendimento,
          <br />
          <em>passo a passo.</em>
        </h1>
        <p className="lead">
          Você configura uma vez. Depois, tudo acontece pelo painel.
        </p>
        <section
          className="account-setup"
          id="vincular-contas"
          aria-labelledby="accounts-title"
        >
          <div className="eyebrow">PRIMEIRO PASSO · ANTES DO DEPLOY</div>
          <h2 id="accounts-title">Vincule a Cloudflare ao GitHub</h2>
          <p>
            Faça essa conexão antes de usar o botão do Wabotia. Se sua conta
            GitHub já aparece em <strong>Git account</strong> na Cloudflare,
            continue para o gerador de chaves abaixo.
          </p>
          <ol>
            <li>
              Abra a Cloudflare e selecione a conta onde vai instalar o Wabotia.
              Vá a <strong>Workers &amp; Pages</strong>.
            </li>
            <li>
              Clique em <strong>Create application / Criar aplicativo</strong> e
              escolha <strong>GitHub</strong>. Em algumas telas, a opção aparece
              em <strong>Import a repository / Importar repositório</strong>.
            </li>
            <li>
              Use <strong>Connect GitHub / Conectar GitHub</strong> ou{" "}
              <strong>+ Add account / Adicionar conta</strong>. No GitHub,
              escolha a conta ou organização que receberá sua cópia e autorize o
              aplicativo <strong>Cloudflare Workers and Pages</strong>.
            </li>
            <li>
              Ao voltar à Cloudflare, confira sua conta na lista{" "}
              <strong>Git account</strong>. A vinculação terminou: volte a esta
              página, gere e guarde as duas chaves e só então clique em{" "}
              <strong>Deploy to Cloudflare</strong>.
            </li>
          </ol>
          <a
            className="button"
            href="https://dash.cloudflare.com/?to=/:account/workers-and-pages"
            target="_blank"
            rel="noopener noreferrer"
          >
            Abrir Cloudflare para vincular <ArrowUpRight size={18} />
          </a>
          <aside className="account-return">
            <strong>A tela fechou depois de autorizar?</strong>
            <p>
              Isso pode acontecer na primeira vinculação pelo botão de deploy.
              Volte ao Wabotia e clique novamente em{" "}
              <strong>Deploy to Cloudflare</strong>. Selecione a conta já
              vinculada para continuar. Autorizar o GitHub, sozinho, ainda não
              instala o Wabotia.
            </p>
          </aside>
          <p className="account-note">
            Pelo instalador do terminal, a publicação usa Wrangler e dispensa
            essa vinculação. O PDF explica esse caminho alternativo.
          </p>
        </section>
        <div className="guide-actions">
          <a className="button" href="#chaves">
            Gerar chaves de instalação <ShieldCheck size={18} />
          </a>
          <a
            className="button secondary"
            href="https://deploy.workers.cloudflare.com/?url=https://github.com/Quevenapp/Wabotia"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Deploy to Cloudflare (abre em outra aba)"
          >
            Deploy to Cloudflare <Cloud size={18} />
          </a>
          <a
            className="button secondary"
            href="/guide/wabotia-instalacao.pdf"
            download
          >
            Baixar guia em PDF <Download size={18} />
          </a>
        </div>
        <InstallKeys />
        <div className="guide-grid">
          {installSteps.map(([title, desc], i) => (
            <article key={title}>
              <span className="step-no">0{i + 1}</span>
              <h2>{title}</h2>
              <p>{desc}</p>
              {i === 0 && (
                <div className="inline-links">
                  <a href="https://github.com/Quevenapp/Wabotia">GitHub ↗</a>
                  <a href="https://dash.cloudflare.com/">Cloudflare ↗</a>
                </div>
              )}
            </article>
          ))}
        </div>
        <aside className="callout">
          <ShieldCheck />
          <div>
            <strong>Guarde suas chaves com cuidado</strong>
            <p>
              Tokens e senhas ficam nos campos protegidos. Não publique esses
              valores no GitHub nem envie em mensagens de suporte.
            </p>
          </div>
        </aside>
        <div className="guide-links">
          <a href="/app">
            Abrir painel <ArrowRight size={17} />
          </a>
          <a href="/api-docs">
            Documentação da API <Code2 size={17} />
          </a>
          <a href="/app?demo=1">
            Conhecer as telas com dados fictícios <ArrowUpRight size={17} />
          </a>
        </div>
      </main>
    </div>
  );
}
function ApiDocs() {
  const [spec, setSpec] = useState<any>(null),
    [selected, setSelected] = useState(""),
    [token, setToken] = useState(""),
    [path, setPath] = useState("/profiles"),
    [result, setResult] = useState("");
  useEffect(() => {
    api("openapi.json")
      .then(setSpec)
      .catch((e) => setResult(e.message));
  }, []);
  return (
    <div className="guide-page">
      <nav className="landing-nav">
        <Logo />
        <a href="/install">Guia de instalação</a>
      </nav>
      <main>
        <div className="eyebrow">PARA DESENVOLVEDORES</div>
        <h1>
          Atendimento dentro
          <br />
          do seu sistema.
        </h1>
        <p className="lead">
          API REST v1, bots assíncronos e webhooks assinados. Crie uma aplicação
          no painel para começar.
        </p>
        <div className="api-layout">
          <section className="card">
            <h2>Explore os recursos</h2>
            {spec &&
              Object.entries(spec.paths).map(([p, methods]: any) =>
                Object.entries(methods).map(([method, op]: any) => (
                  <button
                    className={
                      "endpoint " + (selected === method + p ? "selected" : "")
                    }
                    key={method + p}
                    onClick={() => {
                      setSelected(method + p);
                      setPath(p);
                    }}
                  >
                    <b>{method.toUpperCase()}</b>
                    <span>{p}</span>
                    <small>{op.summary}</small>
                  </button>
                )),
              )}
          </section>
          <section>
            <div className="card">
              <h2>Testar consulta</h2>
              <p>
                O token fica somente nesta tela. Este explorador executa
                consultas GET; use os exemplos para operações de escrita.
              </p>
              <Field
                label="Chave de integração"
                type="password"
                value={token}
                onChange={setToken}
              />
              <Field
                label="Caminho após /api/v1"
                value={path}
                onChange={setPath}
              />
              <Button
                onClick={async () => {
                  if (!path.startsWith("/") || path.includes("://")) return;
                  try {
                    const r = await fetch("/api/v1" + path, {
                      headers: { Authorization: `Bearer ${token}` },
                    });
                    setResult(JSON.stringify(await r.json(), null, 2));
                  } catch (e: any) {
                    setResult(e.message);
                  }
                }}
              >
                Executar consulta <ArrowRight size={16} />
              </Button>
              <pre>{result || "O resultado da consulta aparecerá aqui."}</pre>
            </div>
            <div className="card">
              <h3>Operações seguras para repetir</h3>
              <p>
                Envie <code>Idempotency-Key</code> em pedidos de escrita. Uma
                chave repetida com outro conteúdo retorna conflito.
              </p>
              <h3>Execução de bots</h3>
              <p>
                POST /bot-runs retorna 202. Consulte o identificador até
                concluir ou receba um webhook.
              </p>
              <h3>Assinatura dos webhooks</h3>
              <p>
                Valide HMAC-SHA256 sobre <code>timestamp.corpo_original</code> e
                deduplique o ID do evento.
              </p>
              <a href="/api/openapi.json">Baixar OpenAPI 3.1 ↗</a>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
const demoProfile = {
  id: "demo",
  name: "Atendimento Queven",
  settings: {
    attendant_bot: "demo-bot",
    instructions: "Acolha o cliente e responda com clareza.",
    protocol_response_hours: 24,
    reply_mode: "command",
    capabilities: [],
    menus: [],
    apps: [],
  },
};
const demoConversations = [
  {
    id: "demo-1",
    external_id: "Cliente de exemplo",
    phone: "Cliente de exemplo",
    state: "waiting",
    updated: Date.now() - 600000,
    last_customer: Date.now() - 600000,
  },
  {
    id: "demo-2",
    external_id: "Conversa de demonstração",
    phone: "Conversa de demonstração",
    state: "ai",
    updated: Date.now() - 1800000,
    last_customer: Date.now() - 1800000,
  },
];
function Login({ ready }: any) {
  const [setup, setSetup] = useState(false),
    [configured, setConfigured] = useState(true),
    [form, setForm] = useState<Row>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("auth/status")
      .then((s) => {
        setSetup(!s.initialized);
        setConfigured(s.configured);
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <div className="login-page">
      <div className="login-brand">
        <Logo light />
        <h1>
          Seu atendimento.
          <br />
          <em>Bem conectado.</em>
        </h1>
        <p>
          Inteligência quando ajuda.
          <br />
          Pessoas quando importa.
        </p>
        <div className="login-symbol">
          <MessageCircle size={140} />
        </div>
      </div>
      <main>
        <div className="login-form">
          <div className="eyebrow">BEM-VINDO AO WABOTIA</div>
          <h2>
            {setup ? "Crie sua conta de administrador" : "Vamos continuar?"}
          </h2>
          <p>
            {setup
              ? "Esta etapa é feita somente uma vez, na sua instalação."
              : "Entre para acompanhar suas conversas e sua equipe."}
          </p>
          {!configured && (
            <div className="notice error">
              Configure MASTER_KEY e SETUP_TOKEN nos secrets do Worker antes de
              começar.
            </div>
          )}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                if (setup) await api("auth/setup", "POST", form);
                await api("auth/login", "POST", form);
                ready();
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {setup && (
              <>
                <Field
                  label="Seu nome"
                  value={form.name}
                  onChange={(name: string) => setForm({ ...form, name })}
                  required
                />
                <Field
                  label="Código de instalação (SETUP_TOKEN)"
                  type="password"
                  value={form.token}
                  onChange={(token: string) => setForm({ ...form, token })}
                  required
                />
              </>
            )}
            <Field
              label="E-mail"
              type="email"
              value={form.email}
              onChange={(email: string) => setForm({ ...form, email })}
              required
            />
            <Field
              label="Senha"
              type="password"
              value={form.password}
              onChange={(password: string) => setForm({ ...form, password })}
              required
            />
            {setup && <small>Use pelo menos 12 caracteres.</small>}
            {error && <div className="notice error">{error}</div>}
            <Button type="submit" disabled={busy}>
              {busy ? (
                <Loader2 className="spin" size={18} />
              ) : setup ? (
                "Criar conta e entrar"
              ) : (
                "Entrar no painel"
              )}
              <ArrowRight size={17} />
            </Button>
          </form>
          <a href="/install" className="text-link">
            Precisa de ajuda para instalar?
          </a>
        </div>
      </main>
    </div>
  );
}
function App() {
  const demo = new URLSearchParams(location.search).has("demo");
  const [me, setMe] = useState<Row | null>(
      demo ? { name: "Administrador", role: "admin", id: "demo-user" } : null,
    ),
    [checked, setChecked] = useState(demo),
    [page, setPage] = useState("overview"),
    [profiles, setProfiles] = useState<Row[]>(demo ? [demoProfile] : []),
    [profile, setProfile] = useState(demo ? "demo" : ""),
    [rows, setRows] = useState<any>([]),
    [overview, setOverview] = useState<any>({}),
    [bots, setBots] = useState<Row[]>([]),
    [settings, setSettings] = useState<Row>({}),
    [modal, setModal] = useState(""),
    [form, setForm] = useState<Row>({}),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selection, setSelection] = useState<Row | null>(null),
    [reply, setReply] = useState(""),
    [search, setSearch] = useState(""),
    [mobile, setMobile] = useState(false),
    [section, setSection] = useState("tickets"),
    [cursor, setCursor] = useState(""),
    [nextCursor, setNextCursor] = useState<string | null>(null);
  const root = "v1/profiles/" + profile;
  const change = (key: string, value: any) =>
    setForm((f) => ({ ...f, [key]: value }));
  async function init() {
    try {
      setMe(await api("v1/me"));
      const p = await api("v1/profiles");
      setProfiles(p);
      setProfile((old) => old || p[0]?.id || "");
    } catch {
      setMe(null);
    } finally {
      setChecked(true);
    }
  }
  useEffect(() => {
    if (!demo) init();
  }, []);
  const run = async (
    fn: () => Promise<any>,
    success = "Salvo com sucesso.",
  ) => {
    if (demo) {
      setNotice(
        "Estas são telas de referência com dados fictícios. Entre na sua instalação para salvar alterações.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      setNotice(success);
      return result;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  async function load() {
    if (demo) {
      setOverview({
        enabled: false,
        conversations: [
          { state: "waiting", count: 1 },
          { state: "ai", count: 1 },
        ],
        connections: [],
      });
      setBots([
        {
          id: "demo-bot",
          name: "Atendente",
          remote_profile: "atendente",
          enabled: 1,
        },
      ]);
      setSettings(demoProfile.settings);
      setRows(
        page === "conversations"
          ? demoConversations
          : page === "tickets"
            ? [
                {
                  id: "ticket-demo",
                  number: "WA-EXEMPLO",
                  title: "Dúvida sobre pedido",
                  status: "open",
                  created: Date.now(),
                  response_due_at: Date.now() + 86400000,
                },
              ]
            : page === "presence"
              ? [{ actor: "demo-user", name: "Administrador", present: 0 }]
              : page === "bots"
                ? [
                    {
                      id: "demo-bot",
                      name: "Atendente",
                      remote_profile: "atendente",
                      enabled: 1,
                    },
                  ]
                : page === "applications"
                  ? { applications: [], keys: [], scopes: [] }
                  : page === "reports"
                    ? { data: [], count: 0 }
                    : [],
      );
      return;
    }
    if (!profile && !["users", "applications"].includes(page)) {
      setRows([]);
      return;
    }
    try {
      const [o, b] = profile
        ? await Promise.all([api(root + "/status"), api(root + "/bots")])
        : [{}, []];
      setOverview(o);
      setSettings(o.settings || {});
      setBots(b.data || b);
      let data: any = [];
      if (page === "users" || page === "applications")
        data = await api("v1/" + page);
      else if (page === "conversations")
        data = await api(
          root +
            "/conversations?q=" +
            encodeURIComponent(search) +
            "&cursor=" +
            encodeURIComponent(cursor),
        );
      else if (page === "reports")
        data = await api(
          root +
            "/reports?section=" +
            section +
            "&cursor=" +
            encodeURIComponent(cursor),
        );
      else if (!["overview", "settings"].includes(page))
        data = await api(
          root + "/" + page + "?cursor=" + encodeURIComponent(cursor),
        );
      setNextCursor(data.next_cursor || null);
      setRows(page === "reports" ? data : data.data || data);
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    if (me) {
      load();
      const timer = setInterval(load, 15000);
      return () => clearInterval(timer);
    }
  }, [profile, page, me, section, cursor]);
  async function openConversation(row: Row) {
    if (demo) {
      setSelection({
        conversation: row,
        messages: [
          {
            id: 1,
            direction: "customer",
            author: "Cliente",
            text: "Olá! Preciso de ajuda com meu pedido.",
            created: Date.now() - 600000,
          },
          {
            id: 2,
            direction: "outbound",
            author: "Atendente",
            text: "Vou encaminhar sua solicitação para nossa equipe.",
            created: Date.now() - 580000,
          },
        ],
        deliveries: [],
      });
      return;
    }
    setSelection(await api(root + "/conversations/" + row.id));
  }
  function open(kind: string, values: Row = {}) {
    setForm(values);
    setModal(kind);
    setError("");
  }
  async function sendReply() {
    const attachments: string[] = [];
    const el = document.querySelector("#reply-file") as HTMLInputElement;
    for (const file of Array.from(el?.files || [])) {
      const fd = new FormData();
      fd.set("file", file);
      attachments.push((await api(root + "/media", "POST", fd)).id);
    }
    const result = await api(
      root + `/conversations/${selection!.conversation.id}/actions`,
      "POST",
      {
        action: "reply",
        text: reply || (attachments.length ? "Anexo" : ""),
        attachments,
      },
    );
    if (el) el.value = "";
    return result;
  }
  async function saveModal() {
    const result = await run(async () => {
      if (modal === "profile") return api("v1/profiles", "POST", form);
      if (modal === "user")
        return api("v1/users", "POST", {
          ...form,
          role: form.role || "operator",
          profiles: form.profiles || [profile],
        });
      if (modal === "application")
        return api("v1/applications", "POST", {
          ...form,
          profiles: form.profiles || [profile],
          scopes: form.scopes || [
            "conversations:read",
            "tickets:read",
            "bots:read",
          ],
          bots: form.bots || [],
        });
      if (modal === "key")
        return api(`v1/applications/${form.app_id}/keys`, "POST", {
          days: Number(form.days) || 90,
        });
      if (modal === "connection") {
        const config: Row = {},
          secrets: Row = {};
        for (const k of [
          "url",
          "api_url",
          "phone_id",
          "waba_id",
          "group",
          "number",
          "platform",
        ])
          if (form[k]) config[k] = form[k];
        for (const k of [
          "token",
          "app_secret",
          "verify_token",
          "dashboard_token",
          "access_client_id",
          "access_client_secret",
        ])
          if (form[k]) secrets[k] = form[k];
        if (form.profile_key)
          secrets.profile_keys = {
            [form.remote_profile || "default"]: form.profile_key,
          };
        if (form.profile_keys_json)
          secrets.profile_keys = JSON.parse(form.profile_keys_json);
        return api(root + "/connections", "POST", {
          id: form.id,
          name: form.name,
          kind: form.kind || "hermes",
          mode: form.kind === "hermes-whatsapp" ? "hermes" : "direct",
          config,
          secrets,
        });
      }
      if (modal === "transfer")
        return api(
          root + `/conversations/${form.conversation_id}/actions`,
          "POST",
          { action: "transfer", target: form.target },
        );
      if (modal === "jev") return api(root + "/jev", "POST", { key: form.key });
      if (modal === "user-edit")
        return api("v1/users/" + form.id, "PATCH", form);
      if (modal === "knowledge") {
        let mediaId;
        const file = (
          document.querySelector("#knowledge-file") as HTMLInputElement
        )?.files?.[0];
        if (file) {
          const fd = new FormData();
          fd.set("file", file);
          mediaId = (await api(root + "/media", "POST", fd)).id;
        }
        return api(root + "/knowledge", "POST", {
          ...form,
          kind: file ? "file" : form.kind || "text",
          media_id: mediaId,
        });
      }
      if (modal === "ticket")
        return api(root + "/tickets/" + form.id, "PATCH", {
          status: form.status,
          owner: form.owner || undefined,
          text: form.text,
          response_due_at: form.deadline
            ? Date.parse(form.deadline)
            : undefined,
        });
      if (modal === "capability") {
        const next = {
          ...settings,
          capabilities: [
            ...(settings.capabilities || []),
            { ...form, id: crypto.randomUUID(), enabled: true },
          ],
        };
        return api(root + "/settings", "PUT", next);
      }
      if (modal === "menu") {
        return api(root + "/settings", "PUT", {
          ...settings,
          menus: [
            ...(settings.menus || []),
            { ...form, id: crypto.randomUUID(), enabled: true },
          ],
        });
      }
      if (modal === "reconcile-run")
        return api(root + `/bot-runs/${form.id}/reconcile`, "POST", {
          remote_id: form.remote_id,
        });
      if (modal === "reconcile-delivery")
        return api(root + `/deliveries/${form.id}/reconcile`, "POST", {
          status: form.status,
        });
      if (modal === "webhook")
        return api(root + "/webhook-subscriptions", "POST", {
          app_id: form.app_id,
          url: form.url,
          events: form.events || [
            "message.received",
            "ticket.updated",
            "bot.run.completed",
          ],
        });
      return {};
    });
    if (result) {
      if (result.token || result.signing_secret) {
        setForm({ token: result.token || result.signing_secret });
        setModal("secret");
      } else {
        setModal("");
        await init();
        await load();
      }
    }
  }
  if (!checked)
    return (
      <div className="loading">
        <Loader2 className="spin" /> Abrindo seu atendimento...
      </div>
    );
  if (!me) return <Login ready={init} />;
  const nav = sections.find((s) => s[0] === page)!;
  const list = Array.isArray(rows) ? rows : [];
  const total = (overview.conversations || []).reduce(
    (a: number, b: any) => a + b.count,
    0,
  );
  const count = (state: string) =>
    (overview.conversations || []).find((x: any) => x.state === state)?.count ||
    0;
  return (
    <div className="app-shell">
      <aside className={"sidebar " + (mobile ? "visible" : "")}>
        <Logo light />
        <div className="workspace">
          <span className="workspace-avatar">Q</span>
          <div>
            <strong>Seu atendimento</strong>
            <small>Workspace Wabotia</small>
          </div>
          <ChevronDown size={15} />
        </div>
        <div className="nav-label">OPERAÇÃO</div>
        <nav>
          {sections
            .filter(
              ([id]) =>
                me.role === "admin" ||
                ![
                  "settings",
                  "connections",
                  "users",
                  "applications",
                  "webhook-deliveries",
                ].includes(id),
            )
            .map(([id, title, Icon], i) => (
              <React.Fragment key={id}>
                {i === 10 && <div className="nav-label">ADMINISTRAÇÃO</div>}
                <button
                  onClick={() => {
                    setPage(id);
                    setCursor("");
                    setNextCursor(null);
                    setSelection(null);
                    setMobile(false);
                    setError("");
                  }}
                  className={page === id ? "active" : ""}
                >
                  <Icon size={18} />
                  <span>{title}</span>
                  {id === "conversations" && total > 0 && <b>{total}</b>}
                </button>
              </React.Fragment>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <a href="/install">
            <BookOpen size={16} /> Guia de instalação <ArrowUpRight size={14} />
          </a>
          <div className="user-card">
            <span className="avatar">{me.name[0]}</span>
            <div>
              <strong>{me.name}</strong>
              <small>
                {me.role === "admin" ? "Administrador" : "Atendente"}
              </small>
            </div>
            <button
              className="icon-button"
              aria-label="Sair"
              onClick={() =>
                run(() => api("v1/logout", "POST", {})).then(
                  () => !demo && setMe(null),
                )
              }
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <button
            className="icon-button mobile-toggle"
            onClick={() => setMobile(!mobile)}
            aria-label="Abrir menu"
          >
            <Menu />
          </button>
          <div className="breadcrumbs">
            Workspace <ChevronRight size={14} />
            <strong>{nav[1]}</strong>
          </div>
          <div className="topbar-actions">
            <span className="connection-indicator">
              <span
                className={overview.enabled ? "online-dot" : "offline-dot"}
              />
              {overview.enabled ? "Atendimento ativo" : "Atendimento pausado"}
            </span>
            <a href="/api-docs" title="Documentação da API">
              <Code2 size={19} />
            </a>
            <span className="avatar small-avatar">{me.name[0]}</span>
          </div>
        </header>
        {demo && (
          <div className="demo-banner">
            TELAS DE REFERÊNCIA · Dados fictícios. Nenhuma mensagem real é
            enviada.
          </div>
        )}
        <div className="page-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">SEU CENTRO DE ATENDIMENTO</div>
              <h1>{nav[1]}</h1>
              <p>
                {page === "overview"
                  ? "Tudo o que sua equipe precisa para cuidar de cada conversa."
                  : page === "conversations"
                    ? "Contexto, pessoas e respostas no mesmo lugar."
                    : page === "applications"
                      ? "Conecte outros sistemas com acesso controlado."
                      : "Organize seu atendimento com clareza."}
              </p>
            </div>
            <div className="heading-actions">
              <select
                aria-label="Perfil de atendimento"
                value={profile}
                onChange={(e) => {
                  setProfile(e.target.value);
                  setCursor("");
                  setSelection(null);
                }}
              >
                <option value="">Escolha um perfil</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {me.role === "admin" && (
                <button
                  className="icon-button"
                  title="Novo perfil"
                  onClick={() => open("profile")}
                >
                  <Plus size={19} />
                </button>
              )}
            </div>
          </div>
          {error && (
            <div role="alert" className="notice error">
              {error}
              <button onClick={() => setError("")}>
                <X size={15} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="notice">
              {notice}
              <button onClick={() => setNotice("")}>
                <X size={15} />
              </button>
            </div>
          )}
          {!profile && !["users", "applications"].includes(page) ? (
            <div className="card">
              <Empty
                title="Vamos criar seu primeiro perfil?"
                description="Um perfil organiza os bots, os canais e a equipe de um atendimento."
              />
              <Button onClick={() => open("profile")}>
                <Plus size={17} /> Criar perfil de atendimento
              </Button>
            </div>
          ) : (
            <>
              {page === "overview" && (
                <>
                  <div className="metric-grid">
                    {[
                      [
                        MessageCircle,
                        "Conversas",
                        total,
                        "Todos os atendimentos",
                      ],
                      [
                        Headphones,
                        "Aguardando equipe",
                        count("waiting"),
                        "Prontas para assumir",
                      ],
                      [
                        Bot,
                        "Com a inteligência",
                        count("ai"),
                        "Atendidas pelos bots",
                      ],
                      [
                        Check,
                        "Concluídas",
                        count("closed"),
                        "Conversas resolvidas",
                      ],
                    ].map(([Icon, label, value, sub]: any) => (
                      <div className="metric-card" key={label}>
                        <div>
                          <span>{label}</span>
                          <Icon size={19} />
                        </div>
                        <strong>{value}</strong>
                        <small>{sub}</small>
                      </div>
                    ))}
                  </div>
                  <div className="overview-grid">
                    <section className="card getting-started">
                      <div className="section-heading">
                        <div>
                          <h2>Seu próximo passo</h2>
                          <p>Prepare uma base sólida para boas conversas.</p>
                        </div>
                        <span className="soft-icon">
                          <Zap size={20} />
                        </span>
                      </div>
                      {[
                        [
                          "connections",
                          "Conecte o Hermes",
                          "Descubra os bots que você já configurou.",
                        ],
                        [
                          "bots",
                          "Escolha sua Equipe Bot",
                          "Defina quem atende e quem ajuda nos bastidores.",
                        ],
                        [
                          "knowledge",
                          "Adicione conhecimento",
                          "Dê aos bots informações confiáveis para responder.",
                        ],
                        [
                          "presence",
                          "Prepare sua equipe",
                          "Marque presença antes de receber atendimentos.",
                        ],
                      ].map(([id, title, desc], i) => (
                        <button
                          className="checklist-row"
                          key={id}
                          onClick={() => setPage(id)}
                        >
                          <span>{i + 1}</span>
                          <div>
                            <strong>{title}</strong>
                            <small>{desc}</small>
                          </div>
                          <ChevronRight size={18} />
                        </button>
                      ))}
                    </section>
                    <section className="card status-card">
                      <div className="section-heading">
                        <h2>Suas conexões</h2>
                        <Link2 size={18} />
                      </div>
                      {overview.connections?.length ? (
                        overview.connections.map((co: any) => (
                          <div className="connection-row" key={co.id}>
                            <div>
                              <strong>{co.name}</strong>
                              <small>{co.kind}</small>
                            </div>
                            <Badge value={co.status} />
                          </div>
                        ))
                      ) : (
                        <Empty
                          title="O primeiro elo começa aqui"
                          description="Conecte o Hermes e seus canais para acompanhar o estado de cada serviço."
                        />
                      )}
                      <Button secondary onClick={() => setPage("connections")}>
                        Gerenciar conexões <ArrowRight size={16} />
                      </Button>
                    </section>
                  </div>
                  <div className="bottom-note">
                    <ShieldCheck size={18} />
                    <span>
                      Você tem o controle. Assumir uma conversa pausa as
                      respostas da IA.
                    </span>
                    <a href="/api-docs">
                      Conheça a API <ArrowUpRight size={14} />
                    </a>
                  </div>
                </>
              )}
              {page === "conversations" && (
                <div className="inbox-layout">
                  <section className="card inbox-list">
                    <div className="search-box">
                      <Search size={17} />
                      <input
                        placeholder="Buscar cliente ou telefone"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && load()}
                      />
                    </div>
                    {list.length ? (
                      list.map((row) => (
                        <button
                          className={
                            "conversation-row " +
                            (selection?.conversation.id === row.id
                              ? "selected"
                              : "")
                          }
                          key={row.id}
                          onClick={() => openConversation(row)}
                        >
                          <span className="avatar">
                            {(row.phone || row.external_id).slice(-2)}
                          </span>
                          <div>
                            <strong>{row.phone || row.external_id}</strong>
                            <small>{date(row.updated)}</small>
                          </div>
                          <Badge value={row.state} />
                        </button>
                      ))
                    ) : (
                      <Empty
                        title="Sua caixa de entrada está pronta"
                        description="As mensagens dos canais conectados aparecerão aqui."
                      />
                    )}
                  </section>
                  <section className="card conversation-detail">
                    {selection ? (
                      <>
                        <header>
                          <div>
                            <h2>
                              {selection.conversation.phone ||
                                selection.conversation.external_id}
                            </h2>
                            <Badge value={selection.conversation.state} />
                          </div>
                          <Button
                            secondary
                            disabled={busy}
                            onClick={() =>
                              run(() =>
                                api(
                                  root +
                                    `/conversations/${selection.conversation.id}/actions`,
                                  "POST",
                                  { action: "claim" },
                                ),
                              ).then(() =>
                                openConversation(selection.conversation),
                              )
                            }
                          >
                            Assumir conversa
                          </Button>
                        </header>
                        <div className="messages">
                          {selection.messages.map((m: any) => (
                            <div
                              className={
                                "message " +
                                (m.direction === "customer"
                                  ? "incoming"
                                  : m.direction === "note"
                                    ? "internal"
                                    : "outgoing")
                              }
                              key={m.id}
                            >
                              <small>
                                {m.direction === "note"
                                  ? "Nota interna"
                                  : m.direction === "customer"
                                    ? "Cliente"
                                    : m.author}
                              </small>
                              <p>{m.text}</p>
                              {parse(m.attachments, []).map((id: string) => (
                                <a
                                  key={id}
                                  href={
                                    "/api/" + root + "/media/" + id + "/content"
                                  }
                                >
                                  Baixar anexo
                                </a>
                              ))}
                              <time>{date(m.created)}</time>
                            </div>
                          ))}
                        </div>
                        <div className="reply-box">
                          <textarea
                            placeholder="Escreva sua resposta…"
                            value={reply}
                            onChange={(e) => setReply(e.target.value)}
                          />
                          <input
                            id="reply-file"
                            className="attachment-input"
                            aria-label="Anexar arquivos"
                            type="file"
                            multiple
                          />
                          <div>
                            <Button
                              secondary
                              onClick={() =>
                                run(() =>
                                  api(
                                    root +
                                      `/conversations/${selection.conversation.id}/actions`,
                                    "POST",
                                    { action: "note", text: reply },
                                  ),
                                ).then(() => {
                                  setReply("");
                                  openConversation(selection.conversation);
                                })
                              }
                            >
                              Nota interna
                            </Button>
                            <Button
                              onClick={() =>
                                run(sendReply).then(() => {
                                  setReply("");
                                  openConversation(selection.conversation);
                                })
                              }
                            >
                              Enviar <Send size={16} />
                            </Button>
                          </div>
                          <div className="inline-links">
                            <button
                              onClick={() =>
                                api(root + "/presence").then((people) =>
                                  open("transfer", {
                                    conversation_id: selection.conversation.id,
                                    people,
                                  }),
                                )
                              }
                            >
                              Transferir
                            </button>
                            {[
                              ["resolve", "Concluir"],
                              ["resume", "Retomar IA"],
                            ].map(([action, label]) => (
                              <button
                                key={action}
                                onClick={() =>
                                  run(() =>
                                    api(
                                      root +
                                        `/conversations/${selection.conversation.id}/actions`,
                                      "POST",
                                      { action },
                                    ),
                                  ).then(() =>
                                    openConversation(selection.conversation),
                                  )
                                }
                              >
                                {label}
                              </button>
                            ))}
                            <button
                              onClick={() =>
                                run(() =>
                                  api(root + "/tickets", "POST", {
                                    conversation_id: selection.conversation.id,
                                    title: "Solicitação de atendimento",
                                  }),
                                )
                              }
                            >
                              Abrir protocolo
                            </button>
                            <button
                              onClick={() =>
                                run(() =>
                                  api(root + "/consents/request", "POST", {
                                    conversation_id: selection.conversation.id,
                                  }),
                                )
                              }
                            >
                              Solicitar consentimento
                            </button>
                          </div>
                        </div>
                      </>
                    ) : (
                      <Empty
                        title="Cada conversa tem uma história"
                        description="Selecione um atendimento para ver o contexto e responder."
                      />
                    )}
                  </section>
                </div>
              )}
              {page === "connections" && (
                <>
                  <div className="toolbar">
                    <p>
                      Hermes fornece a inteligência. Os canais trazem as
                      conversas.
                    </p>
                    <Button
                      onClick={() => open("connection", { kind: "hermes" })}
                    >
                      <Plus size={17} /> Nova conexão
                    </Button>
                  </div>
                  <div className="cards-grid">
                    {list.map((row) => (
                      <section className="card integration-card" key={row.id}>
                        <div className="section-heading">
                          <span className="integration-icon">
                            {row.kind === "hermes" ? <Bot /> : <Plug />}
                          </span>
                          <Badge value={row.status} />
                        </div>
                        <h2>{row.name}</h2>
                        {parse(row.config).qr && (
                          <img
                            className="qr-image"
                            src={parse(row.config).qr}
                            alt="Leia o código com o WhatsApp para conectar"
                          />
                        )}
                        <button
                          className="text-link"
                          onClick={() =>
                            open("connection", { ...row, ...parse(row.config) })
                          }
                        >
                          Editar conexão
                        </button>
                        <p>
                          {row.kind === "hermes"
                            ? "Bots e ferramentas"
                            : row.kind === "telegram"
                              ? "Equipe humana via Telegram"
                              : row.kind === "meta"
                                ? "WhatsApp Cloud API"
                                : row.kind === "qr"
                                  ? "WhatsApp por QR"
                                  : "WhatsApp pelo Hermes"}
                        </p>
                        <small>Último contato: {date(row.last_seen)}</small>
                        <div className="card-actions">
                          <Button
                            secondary
                            onClick={() =>
                              run(
                                () =>
                                  api(
                                    root + `/connections/${row.id}/test`,
                                    "POST",
                                    {},
                                  ),
                                "Conexão verificada.",
                              ).then(load)
                            }
                          >
                            Testar conexão
                          </Button>
                          <Button
                            secondary
                            onClick={() =>
                              run(() =>
                                api(
                                  root + `/connections/${row.id}/state`,
                                  "PUT",
                                  {
                                    status:
                                      row.status === "active"
                                        ? "paused"
                                        : "active",
                                  },
                                ),
                              ).then(load)
                            }
                          >
                            {row.status === "active" ? "Pausar" : "Ativar"}
                          </Button>
                        </div>
                        {row.kind === "hermes" && (
                          <button
                            className="text-link"
                            onClick={() =>
                              run(
                                () =>
                                  api(
                                    root + `/connections/${row.id}/discover`,
                                    "POST",
                                    {},
                                  ),
                                "Bots atualizados.",
                              ).then(load)
                            }
                          >
                            Descobrir bots <ArrowRight size={16} />
                          </button>
                        )}
                        {row.kind === "telegram" && (
                          <button
                            className="text-link"
                            onClick={() =>
                              run(
                                () =>
                                  api(
                                    root +
                                      `/connections/${row.id}/telegram-webhook`,
                                    "POST",
                                    {},
                                  ),
                                "Webhook configurado.",
                              )
                            }
                          >
                            Ligar recebimento Telegram
                          </button>
                        )}
                        {["qr", "hermes-whatsapp"].includes(row.kind) && (
                          <button
                            className="text-link"
                            onClick={() =>
                              run(() =>
                                api(
                                  root +
                                    `/connections/${row.id}/connector-token`,
                                  "POST",
                                  {},
                                ),
                              ).then((r) => {
                                if (r) open("secret", { token: r.token });
                              })
                            }
                          >
                            Gerar chave do conector
                          </button>
                        )}
                        {row.kind === "meta" && (
                          <div className="resource-id">
                            <span>
                              Webhook Meta: {location.origin}/webhooks/meta/
                              {row.id}
                            </span>
                            <CopyButton
                              value={
                                location.origin + "/webhooks/meta/" + row.id
                              }
                            />
                          </div>
                        )}
                        <small className="resource-id">
                          ID: {row.id} <CopyButton value={row.id} />
                        </small>
                      </section>
                    ))}
                  </div>
                  {!list.length && (
                    <section className="card">
                      <Empty
                        title="Conecte seu primeiro serviço"
                        description="Comece pelo Hermes. Depois configure WhatsApp e Telegram."
                      />
                    </section>
                  )}
                </>
              )}
              {page === "bots" && (
                <>
                  <div className="toolbar">
                    <p>
                      Selecione os bots criados no Hermes. Permissões continuam
                      no perfil original.
                    </p>
                    <Button onClick={() => open("capability")}>
                      <Plus size={17} /> Ação de especialista
                    </Button>
                  </div>
                  <div className="cards-grid">
                    {bots.map((bot) => (
                      <section className="card" key={bot.id}>
                        <div className="section-heading">
                          <span className="integration-icon">
                            <Bot />
                          </span>
                          <Badge value={bot.enabled ? "active" : "paused"} />
                        </div>
                        <h2>{bot.name}</h2>
                        <p>Perfil Hermes: {bot.remote_profile}</p>
                        <Button
                          secondary
                          onClick={() =>
                            run(() =>
                              api(root + "/bots/" + bot.id, "PATCH", {
                                enabled: !bot.enabled,
                              }),
                            ).then(load)
                          }
                        >
                          {bot.enabled ? "Desabilitar" : "Habilitar"}
                        </Button>
                        <button
                          className="text-link block"
                          onClick={() =>
                            run(() =>
                              api(root + "/settings", "PUT", {
                                ...settings,
                                attendant_bot: bot.id,
                              }),
                            ).then(load)
                          }
                        >
                          {settings.attendant_bot === bot.id
                            ? "✓ Bot Atendente selecionado"
                            : "Usar como Bot Atendente"}
                        </button>
                        <small className="resource-id">
                          {bot.id}
                          <CopyButton value={bot.id} />
                        </small>
                      </section>
                    ))}
                  </div>
                  {!bots.length && (
                    <div className="card">
                      <Empty
                        title="Sua Equipe Bot começa no Hermes"
                        description="Cadastre a conexão Hermes e use Descobrir bots."
                      />
                    </div>
                  )}
                  <section className="card">
                    <h2>Ações internas permitidas</h2>
                    {(settings.capabilities || []).map((a: any) => (
                      <div className="connection-row" key={a.id}>
                        <div>
                          <strong>{a.name}</strong>
                          <small>{a.condition}</small>
                        </div>
                        <Button
                          secondary
                          onClick={() =>
                            run(() =>
                              api(root + "/settings", "PUT", {
                                ...settings,
                                capabilities: settings.capabilities.filter(
                                  (x: any) => x.id !== a.id,
                                ),
                              }),
                            ).then(load)
                          }
                        >
                          Remover
                        </Button>
                      </div>
                    ))}
                    {!settings.capabilities?.length && (
                      <p>
                        Adicione uma ação para permitir que o Atendente consulte
                        um especialista.
                      </p>
                    )}
                  </section>
                </>
              )}
              {page === "knowledge" && (
                <>
                  <div className="toolbar">
                    <p>Informações confiáveis para fundamentar as respostas.</p>
                    <Button onClick={() => open("knowledge", { kind: "text" })}>
                      <Plus size={17} /> Adicionar fonte
                    </Button>
                  </div>
                  <section className="card">
                    {list.length ? (
                      <Table
                        rows={list}
                        columns={[
                          ["title", "Fonte"],
                          ["kind", "Tipo"],
                          ["status", "Estado"],
                          ["error", "Observação"],
                        ]}
                        action={(row: Row) => (
                          <button
                            className="text-link"
                            onClick={() =>
                              run(() =>
                                api(root + "/knowledge/" + row.id, "DELETE"),
                              ).then(load)
                            }
                          >
                            Remover
                          </button>
                        )}
                      />
                    ) : (
                      <Empty
                        title="Conhecimento que ajuda de verdade"
                        description="Cadastre textos, páginas ou documentos para sua equipe de bots consultar."
                      />
                    )}
                  </section>
                </>
              )}
              {page === "tickets" && (
                <section className="card">
                  <div className="section-heading">
                    <h2>Protocolos de atendimento</h2>
                    <span className="muted">{list.length} registros</span>
                  </div>
                  {list.length ? (
                    <Table
                      rows={list}
                      columns={[
                        ["number", "Protocolo"],
                        ["title", "Solicitação"],
                        ["status", "Estado"],
                        ["response_due_at", "Prazo"],
                        ["created", "Abertura"],
                      ]}
                      action={(row: Row) => (
                        <Button secondary onClick={() => open("ticket", row)}>
                          Atualizar
                        </Button>
                      )}
                    />
                  ) : (
                    <Empty
                      title="Solicitações acompanhadas do começo ao fim"
                      description="Abra um protocolo a partir de uma conversa. Solicitações sem humanos disponíveis também geram protocolos."
                    />
                  )}
                </section>
              )}
              {page === "presence" && (
                <>
                  <div className="callout">
                    <Headphones />
                    <div>
                      <strong>Presença é uma escolha da equipe</strong>
                      <p>
                        Ficar online no painel não marca presença
                        automaticamente. Sem atendentes presentes, o cliente
                        recebe um protocolo.
                      </p>
                    </div>
                  </div>
                  <section className="card">
                    {list.map((row) => (
                      <div className="presence-row" key={row.actor}>
                        <span className="avatar">{row.name[0]}</span>
                        <div>
                          <strong>{row.name}</strong>
                          <small>
                            {row.telegram_id
                              ? "Telegram vinculado"
                              : "Atendimento pelo painel"}
                          </small>
                        </div>
                        <Badge value={row.present ? "active" : "paused"} />
                        {row.actor === me.id && (
                          <Button
                            secondary
                            onClick={() =>
                              run(() =>
                                api(root + "/presence", "PUT", {
                                  present: !row.present,
                                }),
                              ).then(load)
                            }
                          >
                            {row.present
                              ? "Marcar ausência"
                              : "Estou disponível"}
                          </Button>
                        )}
                      </div>
                    ))}
                  </section>
                </>
              )}
              {page === "settings" && (
                <div className="settings-layout">
                  <section className="card">
                    <h2>Como sua equipe atende</h2>
                    <Field
                      label="Orientações para o Bot Atendente"
                      type="textarea"
                      value={settings.instructions}
                      onChange={(v: string) =>
                        setSettings({ ...settings, instructions: v })
                      }
                    />
                    <Field
                      label="Orientação quando não há humanos presentes"
                      type="textarea"
                      value={settings.absence_instructions}
                      onChange={(v: string) =>
                        setSettings({ ...settings, absence_instructions: v })
                      }
                    />
                    <Field
                      label="Prazo padrão de primeira resposta (horas)"
                      type="number"
                      value={settings.protocol_response_hours}
                      onChange={(v: string) =>
                        setSettings({
                          ...settings,
                          protocol_response_hours: Number(v),
                        })
                      }
                    />
                    <Field
                      label="Respostas no Telegram"
                      options={[
                        ["command", "Comando /responder"],
                        ["direct", "Texto direto após assumir"],
                      ]}
                      value={settings.reply_mode}
                      onChange={(v: string) =>
                        setSettings({ ...settings, reply_mode: v })
                      }
                    />
                    <Field
                      label="ID da conexão Telegram"
                      value={settings.telegram_connection}
                      onChange={(v: string) =>
                        setSettings({ ...settings, telegram_connection: v })
                      }
                    />
                    <Field
                      label="ID do grupo Telegram"
                      value={settings.telegram_group}
                      onChange={(v: string) =>
                        setSettings({ ...settings, telegram_group: v })
                      }
                    />
                    <label className="check-field">
                      <input
                        type="checkbox"
                        checked={!!settings.surveys_enabled}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            surveys_enabled: e.target.checked,
                          })
                        }
                      />{" "}
                      Pedir avaliação ao concluir
                    </label>
                    <Button
                      onClick={() =>
                        run(() =>
                          api(root + "/settings", "PUT", settings),
                        ).then(load)
                      }
                    >
                      Salvar preferências
                    </Button>
                  </section>
                  <section>
                    <div className="card">
                      <h2>Estado do atendimento</h2>
                      <p>
                        Confira bots, canais e conhecimento antes de ativar.
                      </p>
                      <Button
                        onClick={() =>
                          run(() =>
                            api(
                              root +
                                (overview.enabled ? "/pause" : "/activate"),
                              "POST",
                              {},
                            ),
                          ).then(load)
                        }
                      >
                        {overview.enabled
                          ? "Pausar atendimento"
                          : "Ativar atendimento"}
                      </Button>
                    </div>
                    <div className="card">
                      <div className="section-heading">
                        <h2>Menu de atendimento</h2>
                        <button
                          className="icon-button"
                          onClick={() => open("menu", { type: "human" })}
                        >
                          <Plus size={18} />
                        </button>
                      </div>
                      {(settings.menus || []).map((m: any) => (
                        <div className="connection-row" key={m.id}>
                          <strong>{m.label}</strong>
                          <small>{m.type}</small>
                        </div>
                      ))}
                      {!settings.menus?.length && (
                        <p>Adicione opções para orientar seus clientes.</p>
                      )}
                    </div>
                  </section>
                </div>
              )}
              {page === "users" && (
                <>
                  <div className="toolbar">
                    <p>Acesso individual, responsabilidade clara.</p>
                    <Button onClick={() => open("user", { role: "operator" })}>
                      <Plus size={17} /> Adicionar pessoa
                    </Button>
                  </div>
                  <section className="card">
                    <Table
                      rows={list}
                      columns={[
                        ["name", "Pessoa"],
                        ["email", "E-mail"],
                        ["role", "Papel"],
                        ["telegram_id", "Telegram"],
                      ]}
                      action={(row: Row) => (
                        <div className="card-actions">
                          <Button
                            secondary
                            onClick={() =>
                              open("user-edit", {
                                ...row,
                                profiles: parse(row.profiles, []),
                              })
                            }
                          >
                            Editar
                          </Button>
                          <Button
                            secondary
                            onClick={() =>
                              run(() =>
                                api("v1/users/" + row.id, "PATCH", {
                                  disabled: !row.disabled,
                                }),
                              ).then(load)
                            }
                          >
                            {row.disabled ? "Ativar" : "Desativar"}
                          </Button>
                        </div>
                      )}
                    />
                  </section>
                </>
              )}
              {page === "applications" && (
                <>
                  <div className="toolbar">
                    <p>
                      Crie chaves com as permissões necessárias para cada
                      sistema.
                    </p>
                    <Button onClick={() => open("application")}>
                      <Plus size={17} /> Nova aplicação
                    </Button>
                  </div>
                  <section className="card">
                    {rows.applications?.length ? (
                      <Table
                        rows={rows.applications}
                        columns={[
                          ["name", "Aplicação"],
                          ["rate", "Requisições/min"],
                          ["run_limit", "Execuções simultâneas"],
                        ]}
                        action={(row: Row) => (
                          <div className="card-actions">
                            <Button
                              secondary
                              onClick={() =>
                                run(() =>
                                  api("v1/applications/" + row.id, "PATCH", {
                                    disabled: !row.disabled,
                                  }),
                                ).then(load)
                              }
                            >
                              {row.disabled ? "Ativar" : "Desativar"}
                            </Button>
                            <Button
                              secondary
                              onClick={() =>
                                open("key", { app_id: row.id, days: 90 })
                              }
                            >
                              Gerar chave
                            </Button>
                            <Button
                              secondary
                              onClick={() =>
                                open("webhook", { app_id: row.id })
                              }
                            >
                              Webhook
                            </Button>
                          </div>
                        )}
                      />
                    ) : (
                      <Empty
                        title="O Wabotia dentro dos seus sistemas"
                        description="Cadastre uma aplicação para integrar mensagens, protocolos e bots à sua operação."
                      />
                    )}
                  </section>
                  <section className="card">
                    <h2>Chaves emitidas</h2>
                    <Table
                      rows={rows.keys || []}
                      columns={[
                        ["prefix", "Identificador"],
                        ["expires", "Validade"],
                        ["created", "Criação"],
                      ]}
                      action={(row: Row) =>
                        row.revoked ? (
                          <Badge value="revoked" />
                        ) : (
                          <button
                            className="text-link"
                            onClick={() =>
                              run(() =>
                                api("v1/keys/" + row.id, "DELETE"),
                              ).then(load)
                            }
                          >
                            Revogar
                          </button>
                        )
                      }
                    />
                  </section>
                  <a className="bottom-note" href="/api-docs">
                    <Code2 size={20} /> Abra a documentação interativa da API{" "}
                    <ArrowUpRight size={16} />
                  </a>
                </>
              )}
              {page === "reports" && (
                <section className="card">
                  <div className="toolbar">
                    <Field
                      label="Seção do relatório"
                      value={section}
                      onChange={(v: string) => {
                        setSection(v);
                        setCursor("");
                      }}
                      options={[
                        ["tickets", "Protocolos"],
                        ["conversations", "Conversas"],
                        ["deliveries", "Entregas"],
                        ["surveys", "Avaliações"],
                        ["consents", "Consentimentos"],
                        ["runs", "Execuções dos bots"],
                      ]}
                    />
                    <Button
                      secondary
                      onClick={() =>
                        run(async () => {
                          const response = await fetch(
                            "/api/" +
                              root +
                              "/reports?section=" +
                              section +
                              "&format=jsonl",
                          );
                          if (!response.ok)
                            throw new Error("Não foi possível exportar.");
                          const blob = await response.blob();
                          const a = document.createElement("a");
                          a.href = URL.createObjectURL(blob);
                          a.download = "wabotia-" + section + ".jsonl";
                          a.click();
                          URL.revokeObjectURL(a.href);
                        })
                      }
                    >
                      <Download size={16} /> Exportar JSONL
                    </Button>
                  </div>
                  <Table
                    rows={rows.data || []}
                    columns={
                      section === "tickets"
                        ? [
                            ["number", "Protocolo"],
                            ["title", "Solicitação"],
                            ["status", "Estado"],
                            ["created", "Data"],
                          ]
                        : [
                            ["id", "Identificador"],
                            ["status", "Estado"],
                            ["created", "Data"],
                          ]
                    }
                  />
                  <p className="muted">
                    {rows.count || 0} registros nesta consulta.
                  </p>
                </section>
              )}
              {["bot-runs", "deliveries", "webhook-deliveries"].includes(
                page,
              ) && (
                <section className="card">
                  <p>
                    Consulte o resultado antes de repetir uma operação sem
                    confirmação. Webhooks mantêm o mesmo ID de evento nos
                    reenvios.
                  </p>
                  <Table
                    rows={list}
                    columns={[
                      ["id", "Identificador"],
                      ["status", "Estado"],
                      [
                        page === "webhook-deliveries" ? "attempts" : "error",
                        page === "webhook-deliveries"
                          ? "Tentativas"
                          : "Detalhes",
                      ],
                      ["created", "Data"],
                    ]}
                    action={(row: Row) => (
                      <div className="card-actions">
                        {page === "webhook-deliveries" && (
                          <Button
                            secondary
                            onClick={() =>
                              run(() =>
                                api(
                                  root + `/webhook-deliveries/${row.id}/retry`,
                                  "POST",
                                  {},
                                ),
                              ).then(load)
                            }
                          >
                            Reenviar
                          </Button>
                        )}
                        {page === "bot-runs" &&
                          ["queued", "running", "starting"].includes(
                            row.status,
                          ) && (
                            <Button
                              secondary
                              onClick={() =>
                                run(() =>
                                  api(
                                    root + `/bot-runs/${row.id}/cancel`,
                                    "POST",
                                    {},
                                  ),
                                ).then(load)
                              }
                            >
                              Cancelar
                            </Button>
                          )}
                        {row.status === "unknown" &&
                          me.role === "admin" &&
                          page !== "webhook-deliveries" && (
                            <Button
                              secondary
                              onClick={() =>
                                open(
                                  page === "bot-runs"
                                    ? "reconcile-run"
                                    : "reconcile-delivery",
                                  { id: row.id, status: "cancelled" },
                                )
                              }
                            >
                              Conferir resultado
                            </Button>
                          )}
                        {row.result && (
                          <details>
                            <summary>Resultado</summary>
                            <pre className="code-block">{row.result}</pre>
                          </details>
                        )}
                      </div>
                    )}
                  />
                </section>
              )}
              {["surveys", "consents"].includes(page) && (
                <section className="card">
                  <Table
                    rows={list}
                    columns={
                      page === "surveys"
                        ? [
                            ["score", "Nota"],
                            ["comment", "Comentário"],
                            ["status", "Estado"],
                            ["created", "Data"],
                          ]
                        : [
                            ["conversation_id", "Conversa"],
                            ["status", "Consentimento"],
                            ["created", "Data"],
                          ]
                    }
                  />
                </section>
              )}
            </>
          )}
          {(cursor || nextCursor) && (
            <div className="toolbar">
              <Button
                secondary
                disabled={!cursor}
                onClick={() => setCursor("")}
              >
                Voltar ao início
              </Button>
              <Button
                secondary
                disabled={!nextCursor}
                onClick={() => setCursor(nextCursor || "")}
              >
                Próxima página <ArrowRight size={16} />
              </Button>
            </div>
          )}
          <footer className="app-footer">
            <span>Wabotia · Atendimento conectado</span>
            <a href="https://github.com/Quevenapp/Wabotia">
              Código aberto <ArrowUpRight size={12} />
            </a>
          </footer>
        </div>
      </main>
      {modal && (
        <Modal
          title={
            (
              {
                profile: "Novo perfil de atendimento",
                transfer: "Transferir atendimento",
                jev: "Chave JEV",
                "user-edit": "Editar pessoa",
                connection: "Conectar serviço",
                knowledge: "Adicionar conhecimento",
                user: "Adicionar pessoa",
                application: "Nova aplicação",
                key: "Gerar chave",
                secret: "Guarde esta chave",
                ticket: "Atualizar protocolo",
                "reconcile-run": "Vincular execução confirmada",
                "reconcile-delivery": "Conferir entrega no canal",
                capability: "Ação de especialista",
                menu: "Opção do menu",
                webhook: "Cadastrar webhook",
              } as Row
            )[modal]
          }
          close={() => setModal("")}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveModal();
            }}
          >
            {[
              "profile",
              "user",
              "user-edit",
              "application",
              "connection",
              "capability",
            ].includes(modal) && (
              <Field
                label="Nome"
                value={form.name}
                onChange={(v: string) => change("name", v)}
                required
              />
            )}
            {modal === "connection" && (
              <>
                <Field
                  label="Serviço"
                  value={form.kind}
                  onChange={(v: string) => change("kind", v)}
                  options={[
                    ["hermes", "Hermes"],
                    ["meta", "WhatsApp · API oficial Meta"],
                    ["qr", "WhatsApp · QR direto"],
                    ["hermes-whatsapp", "WhatsApp · pelo Hermes"],
                    ["telegram", "Telegram"],
                  ]}
                />
                {["qr", "meta", "hermes-whatsapp"].includes(form.kind) && (
                  <Field
                    label="Número com DDI (somente dígitos)"
                    value={form.number}
                    onChange={(v: string) => change("number", v)}
                    placeholder="5511999999999"
                    required
                  />
                )}
                {form.kind === "hermes-whatsapp" && (
                  <Field
                    label="Canal configurado no Hermes"
                    value={form.platform}
                    onChange={(v: string) => change("platform", v)}
                    options={[
                      ["whatsapp", "QR Hermes"],
                      ["whatsapp_cloud", "Meta Hermes"],
                    ]}
                    required
                  />
                )}
                {form.kind === "hermes" && (
                  <>
                    <Field
                      label="URL do backend administrativo Hermes"
                      value={form.url}
                      onChange={(v: string) => change("url", v)}
                      placeholder="https://hermes.seudominio.com"
                    />
                    <Field
                      label="URL da API de bots Hermes"
                      value={form.api_url}
                      onChange={(v: string) => change("api_url", v)}
                      placeholder="https://api-hermes.seudominio.com"
                    />
                    <Field
                      label="Token administrativo Hermes"
                      type="password"
                      value={form.dashboard_token}
                      onChange={(v: string) => change("dashboard_token", v)}
                    />
                    <Field
                      label="Nome do perfil Hermes"
                      value={form.remote_profile}
                      onChange={(v: string) => change("remote_profile", v)}
                      placeholder="default"
                    />
                    <Field
                      label="API_SERVER_KEY desse perfil"
                      type="password"
                      value={form.profile_key}
                      onChange={(v: string) => change("profile_key", v)}
                    />
                    <details>
                      <summary>Chaves de vários perfis Hermes</summary>
                      <p>
                        Informe um objeto JSON com nome do perfil e chave. Deixe
                        vazio para manter as chaves já cadastradas.
                      </p>
                      <Field
                        label="Chaves por perfil (JSON)"
                        type="textarea"
                        value={form.profile_keys_json}
                        onChange={(v: string) => change("profile_keys_json", v)}
                      />
                    </details>
                    <details>
                      <summary>Conexão protegida por Cloudflare Access</summary>
                      <Field
                        label="Client ID"
                        value={form.access_client_id}
                        onChange={(v: string) => change("access_client_id", v)}
                      />
                      <Field
                        label="Client Secret"
                        type="password"
                        value={form.access_client_secret}
                        onChange={(v: string) =>
                          change("access_client_secret", v)
                        }
                      />
                    </details>
                  </>
                )}
                {["meta", "telegram"].includes(form.kind) && (
                  <Field
                    label="Token do serviço"
                    type="password"
                    value={form.token}
                    onChange={(v: string) => change("token", v)}
                  />
                )}{" "}
                {form.kind === "meta" && (
                  <>
                    {[
                      ["phone_id", "Phone Number ID"],
                      ["waba_id", "WABA ID"],
                      ["app_secret", "App Secret"],
                      ["verify_token", "Verify Token do webhook"],
                    ].map(([key, label]) => (
                      <Field
                        key={key}
                        label={label}
                        type={
                          key.includes("secret") || key.includes("token")
                            ? "password"
                            : "text"
                        }
                        value={form[key]}
                        onChange={(v: string) => change(key, v)}
                      />
                    ))}
                  </>
                )}
                {form.kind === "telegram" && (
                  <Field
                    label="ID do grupo privado com tópicos"
                    value={form.group}
                    onChange={(v: string) => change("group", v)}
                    placeholder="-100…"
                  />
                )}
                {["qr", "hermes-whatsapp"].includes(form.kind) && (
                  <p>
                    Após salvar, gere uma chave do conector e siga o guia para
                    iniciá-lo junto do Hermes.
                  </p>
                )}
              </>
            )}
            {modal === "knowledge" && (
              <>
                <Field
                  label="Título da fonte"
                  value={form.title}
                  onChange={(v: string) => change("title", v)}
                  required
                />
                <Field
                  label="Tipo de fonte"
                  value={form.kind}
                  onChange={(v: string) => change("kind", v)}
                  options={[
                    ["text", "Texto"],
                    ["url", "Página da internet"],
                    ["file", "Documento"],
                    ["youtube", "Vídeo com transcrição"],
                  ]}
                />
                {form.kind === "text" ? (
                  <Field
                    label="Conteúdo"
                    type="textarea"
                    value={form.text}
                    onChange={(v: string) => change("text", v)}
                  />
                ) : form.kind === "file" ? (
                  <label className="field">
                    <span>PDF, DOCX, TXT, MD, VTT ou SRT · até 20 MB</span>
                    <input
                      id="knowledge-file"
                      type="file"
                      accept=".pdf,.docx,.txt,.md,.srt,.vtt"
                    />
                  </label>
                ) : (
                  <Field
                    label="URL pública"
                    value={form.url}
                    onChange={(v: string) => change("url", v)}
                  />
                )}
              </>
            )}
            {["user", "user-edit"].includes(modal) && (
              <>
                {modal === "user" && (
                  <Field
                    label="E-mail"
                    type="email"
                    value={form.email}
                    onChange={(v: string) => change("email", v)}
                  />
                )}
                <Field
                  label="Senha inicial (mínimo 12 caracteres)"
                  type="password"
                  value={form.password}
                  onChange={(v: string) => change("password", v)}
                />
                {modal === "user" && (
                  <Field
                    label="Papel"
                    value={form.role}
                    onChange={(v: string) => change("role", v)}
                    options={[
                      ["operator", "Atendente"],
                      ["admin", "Administrador"],
                    ]}
                  />
                )}
                <Field
                  label="ID pessoal no Telegram (opcional)"
                  value={form.telegram_id}
                  onChange={(v: string) => change("telegram_id", v)}
                />
              </>
            )}
            {["user", "user-edit", "application"].includes(modal) && (
              <fieldset className="scope-grid">
                <legend>Perfis autorizados</legend>
                {profiles.map((p) => (
                  <label className="check-field" key={p.id}>
                    <input
                      type="checkbox"
                      checked={(form.profiles || [profile]).includes(p.id)}
                      onChange={(e) =>
                        change(
                          "profiles",
                          e.target.checked
                            ? [...(form.profiles || [profile]), p.id]
                            : (form.profiles || [profile]).filter(
                                (id: string) => id !== p.id,
                              ),
                        )
                      }
                    />
                    {p.name}
                  </label>
                ))}
              </fieldset>
            )}
            {modal === "application" && (
              <>
                <p>Permissões para o perfil selecionado:</p>
                <div className="scope-grid">
                  {(
                    (rows.scopes?.length ? rows.scopes : null) || [
                      "conversations:read",
                      "conversations:write",
                      "tickets:read",
                      "tickets:write",
                      "bots:read",
                      "bots:invoke",
                      "webhooks:manage",
                    ]
                  ).map((s: string) => (
                    <label className="check-field" key={s}>
                      <input
                        type="checkbox"
                        checked={(form.scopes || []).includes(s)}
                        onChange={(e) =>
                          change(
                            "scopes",
                            e.target.checked
                              ? [...(form.scopes || []), s]
                              : (form.scopes || []).filter(
                                  (x: string) => x !== s,
                                ),
                          )
                        }
                      />
                      {s}
                    </label>
                  ))}
                </div>
                <h3>Bots que esta aplicação pode executar</h3>
                {bots.map((b) => (
                  <label className="check-field" key={b.id}>
                    <input
                      type="checkbox"
                      checked={(form.bots || []).includes(b.id)}
                      onChange={(e) =>
                        change(
                          "bots",
                          e.target.checked
                            ? [...(form.bots || []), b.id]
                            : (form.bots || []).filter(
                                (x: string) => x !== b.id,
                              ),
                        )
                      }
                    />
                    {b.name}
                  </label>
                ))}
              </>
            )}
            {modal === "key" && (
              <Field
                label="Validade em dias (até 365)"
                type="number"
                value={form.days}
                onChange={(v: string) => change("days", v)}
              />
            )}
            {modal === "secret" && (
              <>
                <p>
                  A chave é exibida somente agora. Guarde-a no sistema que fará
                  a integração.
                </p>
                <div className="secret-box">
                  <code>{form.token}</code>
                  <CopyButton value={form.token} />
                </div>
                <Button onClick={() => setModal("")}>
                  Guardei minha chave <Check size={16} />
                </Button>
              </>
            )}
            {modal === "ticket" && (
              <>
                <Field
                  label="Estado"
                  value={form.status}
                  onChange={(v: string) => change("status", v)}
                  options={[
                    ["open", "Aberto"],
                    ["in_progress", "Em andamento"],
                    ["closed", "Concluído"],
                  ]}
                />
                <Field
                  label="Responsável (ID do atendente)"
                  value={form.owner}
                  onChange={(v: string) => change("owner", v)}
                />
                <Field
                  label="Andamento para o cliente"
                  type="textarea"
                  value={form.text}
                  onChange={(v: string) => change("text", v)}
                />
                <Field
                  label="Novo prazo (antes da primeira resposta)"
                  type="datetime-local"
                  value={form.deadline}
                  onChange={(v: string) => change("deadline", v)}
                />
              </>
            )}
            {modal === "capability" && (
              <>
                <Field
                  label="Especialista Hermes"
                  value={form.bot_id}
                  onChange={(v: string) => change("bot_id", v)}
                  options={bots}
                />
                <Field
                  label="Quando consultar este especialista"
                  type="textarea"
                  value={form.condition}
                  onChange={(v: string) => change("condition", v)}
                />
                <Field
                  label="Ação permitida"
                  type="textarea"
                  value={form.instructions}
                  onChange={(v: string) => change("instructions", v)}
                />
              </>
            )}
            {modal === "menu" && (
              <>
                <Field
                  label="Texto da opção"
                  value={form.label}
                  onChange={(v: string) => change("label", v)}
                />
                <Field
                  label="Destino"
                  value={form.type}
                  onChange={(v: string) => change("type", v)}
                  options={[
                    ["human", "Atendente humano"],
                    ["bot", "Bot Hermes"],
                    ["app", "Aplicativo"],
                    ["submenu", "Submenu"],
                  ]}
                />
                <Field
                  label="ID do menu pai (opcional)"
                  value={form.parent_id}
                  onChange={(v: string) => change("parent_id", v)}
                />
                {form.type === "app" && (
                  <Field
                    label="ID do aplicativo"
                    value={form.app_id}
                    onChange={(v: string) => change("app_id", v)}
                  />
                )}
                {form.type === "bot" && (
                  <Field
                    label="Bot"
                    value={form.bot_id}
                    onChange={(v: string) => change("bot_id", v)}
                    options={bots}
                  />
                )}
              </>
            )}
            {modal === "reconcile-run" && (
              <Field
                label="run_id confirmado no Hermes"
                value={form.remote_id}
                onChange={(v: string) => change("remote_id", v)}
                required
              />
            )}
            {modal === "reconcile-delivery" && (
              <>
                <p>
                  Confira a mensagem no canal. Uma nova tentativa pode duplicar
                  uma mensagem que já chegou ao destinatário.
                </p>
                <Field
                  label="Resultado conferido"
                  value={form.status}
                  onChange={(v: string) => change("status", v)}
                  options={[
                    ["cancelled", "Cancelar entrega"],
                    ["sent", "Confirmar que foi enviada"],
                    ["pending", "Autorizar nova tentativa"],
                  ]}
                />
              </>
            )}
            {modal === "webhook" && (
              <>
                <Field
                  label="URL HTTPS do seu sistema"
                  value={form.url}
                  onChange={(v: string) => change("url", v)}
                />
                <p>
                  Receberá novas mensagens, atualizações de protocolo e
                  conclusão de bots. O segredo de assinatura será exibido após
                  salvar.
                </p>
              </>
            )}
            {modal !== "secret" && (
              <div className="modal-actions">
                <Button secondary onClick={() => setModal("")}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? (
                    <Loader2 className="spin" size={17} />
                  ) : (
                    <Check size={17} />
                  )}{" "}
                  Salvar
                </Button>
              </div>
            )}
            {error && <div className="notice error">{error}</div>}
          </form>
        </Modal>
      )}
    </div>
  );
}
function Table({ rows, columns, action }: any) {
  return rows.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map(([key, label]: any) => (
              <th key={key}>{label}</th>
            ))}
            {action && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row: any, i: number) => (
            <tr key={row.id || i}>
              {columns.map(([key]: any) => (
                <td key={key}>
                  {key === "status" ? (
                    <Badge value={row[key]} />
                  ) : [
                      "created",
                      "updated",
                      "expires",
                      "response_due_at",
                    ].includes(key) ? (
                    date(row[key])
                  ) : (
                    String(row[key] ?? "—")
                  )}
                </td>
              ))}
              {action && <td>{action(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty
      title="Nenhum registro por aqui"
      description="Os dados aparecerão conforme sua operação começar."
    />
  );
}
createRoot(document.getElementById("root")!).render(
  location.pathname.startsWith("/app") ? (
    <App />
  ) : location.pathname === "/install" ? (
    <Install />
  ) : location.pathname === "/api-docs" ? (
    <ApiDocs />
  ) : (
    <Landing />
  ),
);
