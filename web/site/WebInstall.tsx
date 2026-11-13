// Instalador pelo navegador: instala o Wabotia na conta Cloudflare da pessoa
// sem Node.js nem terminal. A página gera as chaves, conduz os passos e guarda
// o andamento só na memória; o servidor executa cada passo e não guarda nada.
import React, { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Download, Loader2 } from "lucide-react";
import { installTokenUrl, setupLink } from "../../src/install-links";
import { Button, Field, Notice } from "../ui";
import { SitePage } from "./SiteChrome";

type Row = Record<string, any>;
const stages: [string, string][] = [
  ["check", "Conferir a conta e os nomes"],
  ["database", "Criar o banco de dados"],
  ["bucket", "Criar o armazenamento de arquivos"],
  ["migrate", "Preparar o banco"],
  ["assets", "Enviar os arquivos do painel"],
  ["publish", "Publicar o Wabotia"],
  ["finish", "Ligar o endereço"],
  ["verify", "Conferir se está no ar"],
];
const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

export function WebInstall() {
  const [enabled, setEnabled] = useState<boolean | null>(null),
    [form, setForm] = useState<Row>({ name: "wabotia-atendimento" }),
    [agreed, setAgreed] = useState(false),
    [phase, setPhase] = useState<
      "form" | "keys" | "running" | "failed" | "done"
    >("form"),
    [stage, setStage] = useState(""),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  // Andamento, chaves e token ficam fora do estado renderizado e somem ao
  // fechar a aba.
  const run = useRef<{
    cursor: Row;
    next: string;
    keys: Row;
    url: string;
  }>({ cursor: {}, next: "check", keys: {}, url: "" });
  const change = (key: string) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    fetch("/api/install/status")
      .then((response) => response.json())
      .then((status: any) => setEnabled(!!status.enabled))
      .catch(() => setEnabled(false));
  }, []);
  // Fechar a aba no meio deixa a instalação pela metade.
  useEffect(() => {
    if (phase !== "running" && phase !== "keys") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  async function step(name: string) {
    const response = await fetch("/api/install/step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account: form.account,
        token: form.token,
        name: form.name,
        step: name,
        cursor: run.current.cursor,
        ...(name === "publish" ? { keys: run.current.keys } : {}),
      }),
    });
    const data: any = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        data?.error?.message || "Não foi possível concluir este passo.",
      );
    return data;
  }
  async function advance(until?: string) {
    setPhase("running");
    setError("");
    try {
      while (run.current.next !== "done" && run.current.next !== until) {
        const name = run.current.next;
        setStage(name);
        const result = await step(name);
        run.current.cursor = result.cursor;
        run.current.next = result.next;
        setMessage(result.message);
        if (result.wait) await pause(4000);
      }
      if (run.current.next === "done") {
        run.current.url = run.current.cursor.url;
        setPhase("done");
      } else setPhase("keys");
    } catch (e: any) {
      setError(e.message);
      setPhase("failed");
    }
  }
  function start(event: React.FormEvent) {
    event.preventDefault();
    run.current = {
      cursor: {},
      next: "check",
      keys: { MASTER_KEY: hex(32), SETUP_TOKEN: hex(32) },
      url: "",
    };
    setSaved(false);
    // Para depois de conferir a conta: as chaves são guardadas antes de
    // qualquer recurso ser criado.
    void advance("database");
  }
  function downloadKeys() {
    const content = JSON.stringify(
      {
        aviso:
          "Chaves privadas do Wabotia. Guarde em local seguro e não compartilhe. MASTER_KEY recupera as credenciais da instalação; não gere outra para a mesma instalação.",
        instalacao: form.name,
        account_id: form.account,
        installation_id: run.current.cursor.installation_id,
        MASTER_KEY: run.current.keys.MASTER_KEY,
        SETUP_TOKEN: run.current.keys.SETUP_TOKEN,
      },
      null,
      2,
    );
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([content], { type: "application/json" }),
    );
    link.download = `${form.name}-chaves.local.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    setSaved(true);
  }

  const current = stages.findIndex(([key]) => key === stage);
  const progress = phase !== "form" && (
    <ol className="install-progress">
      {stages.map(([key, label], index) => {
        const done = phase === "done" || index < current;
        const active = index === current && phase !== "done";
        return (
          <li
            key={key}
            className={done ? "done" : active ? "active" : undefined}
          >
            {done ? (
              <Check size={16} aria-hidden />
            ) : active && phase === "running" ? (
              <Loader2 size={16} className="spin" aria-hidden />
            ) : (
              <span className="install-dot" aria-hidden />
            )}
            {label}
          </li>
        );
      })}
    </ol>
  );

  return (
    <SitePage
      className="guide-page"
      nav={
        <>
          <a href="/install">Guia de instalação</a>
          <a href="/" className="text-link">
            Voltar ao início
          </a>
        </>
      }
    >
      <main className="web-install">
        <div className="eyebrow">INSTALAR PELO NAVEGADOR</div>
        <h1>
          Instale o Wabotia <em>sem terminal.</em>
        </h1>
        <p className="lead">
          Você informa a conta e um token da Cloudflare; esta página cria o
          banco, o armazenamento e publica o painel na sua conta. Leva alguns
          minutos.
        </p>
        {enabled === false && (
          <Notice tone="warn">
            O instalador pelo navegador só funciona no site oficial do Wabotia.
            Nesta instalação, use o{" "}
            <a href="/install#instalar">instalador pelo terminal</a>.
          </Notice>
        )}
        {enabled && phase === "form" && (
          <form className="account-setup" onSubmit={start}>
            <h2>1. Prepare a conta</h2>
            <ol>
              <li>
                Na Cloudflare, ative a assinatura <strong>R2</strong> (
                <a href="/install#requisitos">como ativar</a>). Sem ela a
                conferência abaixo falha, sem criar nada.
              </li>
              <li>
                Copie o <strong>Account ID</strong> da conta, na visão geral da
                Cloudflare.
              </li>
              <li>
                Crie o token:{" "}
                <a
                  href={installTokenUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  abrir a Cloudflare com o token já preenchido ↗
                </a>
                . Em <strong>Account Resources</strong>, escolha somente a conta
                da instalação, confira e crie.
              </li>
            </ol>
            <h2>2. Informe os dados</h2>
            <Field
              label="Account ID da Cloudflare"
              value={form.account}
              onChange={change("account")}
              placeholder="32 letras e números"
              autoComplete="off"
              required
            />
            <Field
              label="Token de API da Cloudflare"
              type="password"
              value={form.token}
              onChange={change("token")}
              autoComplete="off"
              required
            />
            <Field
              label="Nome novo para a instalação"
              value={form.name}
              onChange={change("name")}
              help="Letras minúsculas, números e hífen. Vira o endereço: nome.sua-conta.workers.dev."
              required
            />
            <Notice tone="warn">
              O token passa pelo servidor do Wabotia a cada passo, só para ser
              repassado à Cloudflare. Ele não é guardado nem registrado aqui.
              Como no instalador pelo terminal, ele fica salvo no seu próprio
              Worker para as atualizações pelo painel. Se preferir que o token
              nunca passe por este site, use o{" "}
              <a href="/install#instalar">instalador pelo terminal</a>.
            </Notice>
            <label className="check-field">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              Entendi e quero instalar por aqui
            </label>
            <Button type="submit" size="lg" disabled={!agreed}>
              Conferir a conta <ArrowRight size={17} />
            </Button>
          </form>
        )}
        {progress}
        {message && phase !== "form" && (
          <p className="install-message">{message}</p>
        )}
        {phase === "keys" && (
          <section className="account-setup">
            <h2>3. Guarde as chaves antes de continuar</h2>
            <p>
              A conta foi conferida e nada foi criado ainda. Baixe o arquivo de
              chaves e guarde em local privado: a <strong>MASTER_KEY</strong>{" "}
              protege as credenciais da instalação e não pode ser recuperada
              depois.
            </p>
            <div className="guide-actions">
              <Button onClick={downloadKeys} icon={<Download size={17} />}>
                Baixar chaves
              </Button>
              <Button
                secondary
                disabled={!saved}
                onClick={() => void advance()}
              >
                Guardei o arquivo, instalar <ArrowRight size={17} />
              </Button>
            </div>
          </section>
        )}
        {phase === "running" && (
          <Notice>
            Não feche esta aba. Se a internet cair, a página oferece continuar
            do passo em que parou.
          </Notice>
        )}
        {phase === "failed" && (
          <Notice
            tone="error"
            onRetry={() =>
              void advance(stage === "check" ? "database" : undefined)
            }
            retryLabel="Tentar este passo de novo"
          >
            {error}
            {stage === "check"
              ? " Nada foi criado na sua conta."
              : " O que já foi criado continua na sua conta; tente de novo antes de fechar a aba. Se desistir, apague na Cloudflare o Worker, o banco D1 e o bucket R2 com este nome antes de instalar de novo."}
            {stage === "check" && (
              <>
                {" "}
                <button
                  type="button"
                  className="text-link"
                  onClick={() => {
                    setPhase("form");
                    setMessage("");
                  }}
                >
                  Corrigir os dados
                </button>
              </>
            )}
          </Notice>
        )}
        {phase === "done" && (
          <section className="account-setup">
            <h2>Pronto. O Wabotia está na sua conta.</h2>
            <p>
              Endereço: <strong>{run.current.url}</strong>
            </p>
            <div className="guide-actions">
              <a
                className="button lg"
                href={setupLink(run.current.url, run.current.keys.SETUP_TOKEN)}
              >
                Criar meu administrador <ArrowRight size={17} />
              </a>
              <Button
                secondary
                onClick={downloadKeys}
                icon={<Download size={17} />}
              >
                Baixar chaves de novo
              </Button>
            </div>
            <p>
              O botão já leva o código de instalação para a tela de criar sua
              conta. Depois, siga o{" "}
              <a href="/install#hermes">guia para conectar o Hermes</a> e o
              WhatsApp. As próximas versões são instaladas pelo painel, em
              Sistema e atualizações.
            </p>
          </section>
        )}
      </main>
    </SitePage>
  );
}
