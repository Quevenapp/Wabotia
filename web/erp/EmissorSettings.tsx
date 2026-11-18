// ERP › Fiscal › Emissor de notas (rota /certificado-a1 do Fagoo). No Wabotia
// o certificado A1 e a emissão ficam no cofre NFapi da empresa; aqui só se
// informa o endereço do cofre e a chave de API, e se testa a conexão
// (src/erp/emissor/README.md, "Rotas para o painel"). Ler: quem tem papel no
// ERP. Gravar, testar e remover: o administrador do Wabotia, pelo portão do
// ERP (horário e segundo fator).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { erpPorts } from "./ports";
import {
  dateBR,
  daysLeft,
  emissorBadge,
  type EmissorPort,
  type EmissorView,
} from "./emissor";
import "./emissor.css";

const failureText = (error: any) =>
  error?.code === "module_disabled"
    ? "O Fiscal está desligado nesta área. Ligue-o em Gestão › Módulos."
    : error?.code === "ERP_ACCESS_OUTSIDE_SCHEDULE"
      ? "Fora do seu horário de acesso ao ERP."
      : error?.status === 403
        ? error?.message || "Seu perfil não pode alterar o emissor."
        : error?.message || "Não foi possível falar com o servidor.";

const stamp = (ms: number) =>
  new Date(ms).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  });

export default function EmissorSettings() {
  const ports = erpPorts();
  const port: EmissorPort | undefined = ports?.emissor;
  const admin = Boolean(ports?.admin) && !ports?.demo;
  const [view, setView] = useState<EmissorView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test" | "remove">("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");

  useEffect(() => {
    if (!port) return;
    const request = new AbortController();
    port.read(request.signal).then(
      (value) => {
        if (request.signal.aborted) return;
        setView(value);
        setUrl(value.url ?? "");
      },
      (failure) => {
        if (!request.signal.aborted) setError(failureText(failure));
      },
    );
    return () => request.abort();
  }, [port]);

  // Escrita pelo portão do ERP: com a política de segundo fator ligada, a
  // casca pede o "Confirme que é você" e a ação repete uma vez.
  const run = async (
    kind: "save" | "test" | "remove",
    action: () => Promise<EmissorView>,
    done: string,
  ) => {
    if (busy) return;
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      let value: EmissorView;
      try {
        value = await action();
      } catch (failure: any) {
        if (failure?.code !== "ERP_MFA_REQUIRED" || !ports?.confirmIdentity)
          throw failure;
        await ports.confirmIdentity();
        value = await action();
      }
      setView(value);
      setUrl(value.url ?? "");
      setKey("");
      setNotice(done);
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy("");
    }
  };

  if (!port)
    return (
      <section className="real-state-panel">
        <h1>Emissor de notas</h1>
        <p>O ERP ainda está abrindo. Tente de novo em instantes.</p>
      </section>
    );

  const checked = view?.checked ?? null;
  const certificate = checked?.state?.certificate ?? null;
  const badge = emissorBadge(view);
  return (
    <div className="emissor-settings">
      <nav
        className="preferences-breadcrumb preferences-screen-trail"
        aria-label="Localização"
      >
        <Link to="/acesso">Home</Link> › <span aria-current="page">Emissor de notas</span>
      </nav>
      <header className="real-heading">
        <div>
          <h1>Emissor de notas</h1>
          <p>
            No Wabotia, o certificado digital A1 e a emissão de NF-e e NFC-e
            ficam no cofre de emissão da empresa (NFapi). Aqui você informa o
            endereço do cofre e a chave de API; o certificado nunca passa pelo
            Wabotia.
          </p>
        </div>
      </header>
      {error && (
        <p className="real-alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="real-notice" role="status">
          {notice}
        </p>
      )}
      {!view && !error && <p role="status">Carregando…</p>}
      {view && (
        <section className="real-records" aria-label="Situação do emissor">
          <dl className="emissor-state">
            <dt>Situação</dt>
            <dd>
              {!view.configured
                ? "Não configurado"
                : !checked
                  ? "Configurado, sem teste de conexão"
                  : checked.ok
                    ? `Conectado (teste em ${stamp(checked.at)})`
                    : `O último teste falhou (${stamp(checked.at)})`}
            </dd>
            {view.url && (
              <>
                <dt>Cofre</dt>
                <dd>{view.url}</dd>
              </>
            )}
            {checked?.state && (
              <>
                <dt>Certificado A1</dt>
                <dd>
                  {certificate
                    ? `${certificate.holder} · válido até ${dateBR(certificate.valid_until)} (${daysLeft(certificate) < 0 ? "vencido" : `${daysLeft(certificate)} dias`})`
                    : "Nenhum certificado instalado no cofre"}
                </dd>
                <dt>Produção</dt>
                <dd>
                  {checked.state.production_released
                    ? "Liberada no cofre"
                    : "Só homologação (a produção é liberada no painel do cofre)"}
                </dd>
              </>
            )}
          </dl>
          {badge && badge.tone !== "ok" && (
            <p className="real-help">{badge.title}</p>
          )}
          {view.alerts.length > 0 && (
            <ul className="emissor-alerts">
              {view.alerts.map((alert) => (
                <li key={alert.code} data-level={alert.level}>
                  {alert.message}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {view &&
        (admin ? (
          <form
            className="real-form emissor-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                "save",
                () =>
                  port.save({
                    url: url.trim(),
                    ...(key.trim() ? { api_key: key.trim() } : {}),
                  }),
                "Configuração salva. Teste a conexão para conferir o certificado.",
              );
            }}
          >
            <label>
              Endereço do cofre
              <input
                type="url"
                required
                placeholder="https://nfapi-cofre.sua-conta.workers.dev"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                autoComplete="off"
              />
            </label>
            <label>
              Chave de API
              <input
                type="password"
                placeholder={
                  view.api_key_set
                    ? "Guardada; preencha só para trocar"
                    : "nfapi_…"
                }
                required={!view.api_key_set}
                value={key}
                onChange={(event) => setKey(event.target.value)}
                autoComplete="off"
              />
            </label>
            <div className="real-actions">
              <button
                type="submit"
                className="primary-button"
                disabled={Boolean(busy)}
              >
                {busy === "save" ? "Salvando…" : "Salvar"}
              </button>
              {view.configured && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run("test", () => port.test(), "Conexão testada.")
                  }
                >
                  {busy === "test" ? "Testando…" : "Testar conexão"}
                </button>
              )}
              {view.url && (
                <button
                  type="button"
                  className="text-button"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run(
                      "remove",
                      () => port.remove(),
                      "Configuração removida: a área fica sem emissor.",
                    )
                  }
                >
                  Remover
                </button>
              )}
            </div>
          </form>
        ) : (
          <p className="real-help">
            {ports?.demo
              ? "Na demonstração nada é gravado."
              : "Somente o administrador do Wabotia configura o emissor."}
          </p>
        ))}
    </div>
  );
}
