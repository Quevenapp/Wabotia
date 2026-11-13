// Documentação da API (web/DESIGN.md §9): lista os recursos do OpenAPI e
// oferece um explorador de consultas GET. O token fica só nesta tela.
import React, { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { api } from "../lib/api";
import { Button, Field, Notice, Spinner } from "../ui";
import { SitePage } from "./SiteChrome";

export function ApiDocs() {
  const [spec, setSpec] = useState<any>(null),
    [selected, setSelected] = useState(""),
    [token, setToken] = useState(""),
    [path, setPath] = useState("/profiles"),
    [result, setResult] = useState(""),
    [loadError, setLoadError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("openapi.json")
      .then(setSpec)
      .catch((e) => setLoadError(e.message));
  }, []);
  return (
    <SitePage
      className="guide-page api-page"
      nav={
        <>
          <a href="/install">Guia de instalação</a>
          <a href="/app">Abrir painel</a>
        </>
      }
    >
      <main>
        <div className="eyebrow">PARA DESENVOLVEDORES</div>
        <h1>Atendimento dentro do seu sistema.</h1>
        <p className="lead">
          API REST v1, bots assíncronos e webhooks assinados. Crie uma aplicação
          no painel para começar.
        </p>
        <div className="api-layout">
          <section className="card api-endpoints" aria-label="Recursos da API">
            <h2>Explore os recursos</h2>
            {loadError && <Notice tone="error">{loadError}</Notice>}
            {!spec && !loadError && <Spinner label="Carregando recursos…" />}
            <div className="endpoint-list">
              {spec &&
                Object.entries(spec.paths).map(([p, methods]: any) =>
                  Object.entries(methods).map(([method, op]: any) => (
                    <button
                      type="button"
                      className={
                        "endpoint " +
                        (selected === method + p ? "selected" : "")
                      }
                      aria-pressed={selected === method + p}
                      key={method + p}
                      onClick={() => {
                        setSelected(method + p);
                        setPath(p);
                      }}
                    >
                      <b className={"method " + method}>
                        {method.toUpperCase()}
                      </b>
                      <span>{p}</span>
                      <small>{op.summary}</small>
                    </button>
                  )),
                )}
            </div>
          </section>
          <section className="api-side">
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
                autoComplete="off"
              />
              <Field
                label="Caminho após /api/v1"
                value={path}
                onChange={setPath}
              />
              <Button
                busy={busy}
                onClick={async () => {
                  if (!path.startsWith("/") || path.includes("://")) return;
                  setBusy(true);
                  try {
                    const r = await fetch("/api/v1" + path, {
                      headers: { Authorization: `Bearer ${token}` },
                    });
                    setResult(JSON.stringify(await r.json(), null, 2));
                  } catch (e: any) {
                    setResult(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Executar consulta <ArrowRight size={16} />
              </Button>
              <pre className="api-result" aria-live="polite">
                {result || "O resultado da consulta aparecerá aqui."}
              </pre>
            </div>
            <div className="card api-notes">
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
    </SitePage>
  );
}
