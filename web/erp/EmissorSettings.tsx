// ERP › Fiscal › Emissor de notas (rota /certificado-a1 do Fagoo). No Wabotia
// o certificado A1 e a emissão ficam no cofre NFapi da empresa; aqui só se
// informa o endereço do cofre e a chave de API, e se testa a conexão
// (src/erp/emissor/README.md, "Rotas para o painel"). Ler: quem tem papel no
// ERP. Gravar, testar e remover: o administrador do Wabotia, pelo portão do
// ERP (horário e segundo fator).
import { NfceSettingsPanel } from "./NfceBalcao";
import { NfseSettingsPanel } from "./NfseSettings";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { erpPorts } from "./ports";
import { canCommercialNfe, type CommercialNfePort } from "./commercial-nfe";
import type { CommercialSettings, ConfigSaveInput, EffectTiming, FiscalEnvironment } from "../../src/erp/commercial-nfe/contracts.ts";
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
  return <EmissorSettingsArea key={ports?.commercialNfe?.scopeKey ?? ports?.apiUrl ?? "opening"} />;
}

function EmissorSettingsArea() {
  const ports = erpPorts();
  const port: EmissorPort | undefined = ports?.emissor;
  const admin = Boolean(ports?.admin) && !ports?.demo;
  const [view, setView] = useState<EmissorView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test" | "remove">("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const scope = useRef<AbortController | null>(null);
  const working = useRef(false);

  useEffect(() => {
    const request = new AbortController();
    scope.current = request;
    working.current = false;
    setView(null); setUrl(""); setKey(""); setError(""); setNotice(""); setBusy("");
    if (!port) return () => request.abort();
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
    const request = scope.current;
    if (!admin || !request || request.signal.aborted || working.current) return;
    working.current = true;
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      let value: EmissorView;
      try {
        value = await action();
      } catch (failure: any) {
        if (request.signal.aborted || failure?.code !== "ERP_MFA_REQUIRED" || !ports?.confirmIdentity)
          throw failure;
        await ports.confirmIdentity();
        if (request.signal.aborted) return;
        value = await action();
      }
      if (request.signal.aborted) return;
      setView(value);
      setUrl(value.url ?? "");
      setKey("");
      setNotice(done);
    } catch (failure) {
      if (!request.signal.aborted) setError(failureText(failure));
    } finally {
      if (!request.signal.aborted) { working.current = false; setBusy(""); }
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
            No Wabotia, o certificado digital A1 e a emissão de NF-e
            ficam no cofre de emissão da empresa (NFapi). Aqui você informa o
            endereço do cofre e a chave de API; o certificado nunca passa pelo
            Wabotia. Configure certificado e senha diretamente no cofre.
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
      <CommercialNfeSettings port={ports?.commercialNfe} connection={view} confirmIdentity={ports?.confirmIdentity} />
    </div>
  );
}

export const NFE_SETUP_CHECKLIST = [
  "Cofre instalado; certificado e senha configurados diretamente no cofre.",
  "URL HTTPS e chave salvas, versão compatível e ambiente permitido.",
  "CNPJ do ERP igual ao emitente configurado no cofre.",
  "CRT, inscrição estadual e endereço completo da empresa conferidos.",
  "Série de NF-e resolvida pelo cofre, sem numeração local.",
  "Cliente com documento, endereço, município e condição de inscrição estadual.",
  "Produtos com NCM, origem, unidade e demais dados aplicáveis.",
  "Natureza e parâmetros revisados; regras cobrem todos os itens.",
  "Contador conferiu a operação e a data, inclusive a omissão de IBS/CBS/IS.",
  "Pagamentos, parcelas e total fiscal coincidem.",
  "Modalidade de frete e dados de transporte coerentes.",
  "Políticas de estoque e financeiro escolhidas.",
  "Depósito, saldo, reserva, categoria, conta e pendências locais conferidos.",
  "Pessoa habilitada a emitir e responsáveis por estoque e financeiro definidos.",
  "Área de ensaio e consequências comerciais da homologação compreendidas.",
] as const;

/** Orientação de conferência; marcar aqui não remove bloqueios do servidor. */
export function CommercialNfeChecklist() {
  return <details className="real-records">
    <summary>Checklist antes da primeira NF-e</summary>
    <p className="real-help">Confira com os responsáveis. Esta lista não certifica os cadastros nem substitui os bloqueios e o cálculo do servidor.</p>
    <ul>{NFE_SETUP_CHECKLIST.map(message => <li key={message}><label><input type="checkbox" /> {message}</label></li>)}</ul>
  </details>;
}

type SettingsDraft = Pick<ConfigSaveInput, "environment" | "stock_timing" | "finance_timing" | "series_homologacao" | "series_producao">;
const settingsDraft = (value: CommercialSettings): SettingsDraft => ({
  environment: value.environment, stock_timing: value.stock_timing, finance_timing: value.finance_timing,
  series_homologacao: value.series_homologacao, series_producao: value.series_producao,
});

const commercialFailureText = (failure: { code?: string; message?: string; status?: number }) => {
  const messages: Record<string, string> = {
    fiscal_provider_not_configured: "Configure o endereço e a chave do cofre e teste a conexão.",
    fiscal_provider_incompatible: "A versão do cofre não é compatível com esta integração.",
    fiscal_environment_not_allowed: "A chave do cofre não permite o ambiente selecionado.",
    fiscal_production_not_enabled: "Um administrador precisa habilitar a emissão em produção.",
    fiscal_issuer_mismatch: "O CNPJ da empresa difere do emitente configurado no cofre. Confira Dados da empresa e a conexão.",
    fiscal_issuer_incomplete: "Complete CRT, inscrição estadual e endereço em Dados da empresa antes de habilitar produção.",
    fiscal_series_required: "Selecione uma das séries de NF-e disponíveis no cofre para este ambiente.",
    fiscal_tax_limits_not_acknowledged: "Confirme a revisão do contador e a ciência dos limites tributários.",
    fiscal_config_conflict: "A configuração foi alterada. Recarregue e confira os valores antes de salvar novamente.",
    fiscal_command_conflict: "Este comando já foi usado com outros dados. Recarregue a configuração.",
  };
  return messages[failure?.code ?? ""] ?? failureText(failure);
};
const commercialStamp = (value: string) => {
  try { return stamp(Number(BigInt(value) / 1000n)); } catch { return "data não disponível"; }
};

function CommercialNfeSettings({ port, connection, confirmIdentity }: {
  port?: CommercialNfePort;
  connection: EmissorView | null;
  confirmIdentity?: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<CommercialSettings | null>(null);
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [taxReviewed, setTaxReviewed] = useState(false);
  const [setupReviewed, setSetupReviewed] = useState(false);
  const [productionConfirmed, setProductionConfirmed] = useState(false);
  const scope = useRef<AbortController | null>(null);
  const working = useRef(false);
  // Conserva os mesmos argumentos/UUID até resposta conclusiva, inclusive após perda de resposta.
  const pending = useRef<ConfigSaveInput | null>(null);
  const canConfigure = Boolean(port && canCommercialNfe(port.access(), "configure"));

  useEffect(() => {
    const request = new AbortController(); scope.current = request;
    working.current = false; pending.current = null;
    setSettings(null); setDraft(null); setError(""); setNotice(""); setBusy(false); setUncertain(false);
    setTaxReviewed(false); setSetupReviewed(false); setProductionConfirmed(false);
    if (port) void port.config(request.signal).then(value => {
      if (!request.signal.aborted) { setSettings(value); setDraft(settingsDraft(value)); }
    }, failure => { if (!request.signal.aborted) setError(commercialFailureText(failure)); });
    return () => request.abort();
  }, [port, reload]);

  const connectionPublic = settings?.connection_public;
  const availableEnvironments = Array.isArray(connectionPublic?.environments) ? connectionPublic.environments : [];
  const availableSeries = Array.isArray(connectionPublic?.series) ? connectionPublic.series.filter((entry): entry is { environment: FiscalEnvironment; series: number } =>
    !!entry && typeof entry === "object" && ["homologacao", "producao"].includes(entry.environment) && Number.isInteger(entry.series)) : [];
  const productionReady = connection?.checked?.ok === true && connection.checked.state?.production_released === true &&
    connectionPublic?.compatible === true && availableEnvironments.includes("producao");
  const mayEnableProduction = canConfigure && productionReady && setupReviewed && taxReviewed && productionConfirmed;

  const save = async (enableProduction: boolean, retry = false) => {
    const request = scope.current;
    if (!port || !canCommercialNfe(port.access(), "configure") || !settings || !draft || !request || request.signal.aborted || working.current) return;
    if (!retry && (enableProduction ? !mayEnableProduction : draft.environment === "producao" && !productionConfirmed)) return;
    if (!pending.current) pending.current = {
      ...draft, command_id: crypto.randomUUID(), expected_version: settings.version,
      ...(taxReviewed ? { acknowledge_tax_limits: true } : {}),
      ...(enableProduction ? { environment: "producao", enable_production: true } : {}),
    };
    const input = pending.current;
    working.current = true; setBusy(true); setError(""); setNotice("");
    try {
      let value: CommercialSettings;
      try { value = await port.saveConfig(input, request.signal); }
      catch (failure: any) {
        if (request.signal.aborted || failure?.code !== "ERP_MFA_REQUIRED" || !confirmIdentity) throw failure;
        await confirmIdentity();
        if (request.signal.aborted) return;
        value = await port.saveConfig(input, request.signal);
      }
      if (request.signal.aborted) return;
      setSettings(value); setDraft(settingsDraft(value)); pending.current = null; setUncertain(false);
      setProductionConfirmed(false); setSetupReviewed(false); setTaxReviewed(false);
      setNotice(value.environment === "producao" ? "Configuração salva em produção. Novas notas terão efeito fiscal real; use novos pedidos." : "Configuração salva em homologação. Confira as séries e os ambientes retornados pelo cofre.");
    } catch (failure: any) {
      if (request.signal.aborted) return;
      const inconclusive = failure?.uncertain === true || !Number.isInteger(failure?.status) || failure.status === 0 || failure.status >= 500 || failure.status === 408;
      if (!inconclusive) pending.current = null;
      setUncertain(inconclusive);
      setError(inconclusive ? "Não foi possível confirmar a gravação. Repita o mesmo comando para consultar ou concluir a alteração, sem mudar os dados." : commercialFailureText(failure));
    } finally {
      if (!request.signal.aborted) { working.current = false; setBusy(false); }
    }
  };

  const seriesControl = (environment: FiscalEnvironment, label: string) => {
    if (!draft) return null;
    const key = environment === "homologacao" ? "series_homologacao" : "series_producao";
    const options = availableSeries.filter(series => series.environment === environment);
    const saved = draft[key];
    return <label>{label}<select value={saved ?? ""} onChange={event => setDraft({ ...draft, [key]: event.target.value === "" ? null : Number(event.target.value) })}>
      <option value="">O cofre resolve a série</option>
      {saved != null && !options.some(series => series.series === saved) && <option value={saved} disabled>{saved} (aguardando conferência do cofre)</option>}
      {options.map(series => <option key={series.series} value={series.series}>{series.series}</option>)}
    </select></label>;
  };

  return <section className="real-records" aria-label="Configuração da NF-e comercial">
    <h2>NF-e de pedidos de venda</h2>
    <p>Emissão integral, modelo 55, de um pedido salvo. NFC-e, emissão parcial, agrupamento, serviços e outras finalidades ainda não estão disponíveis neste percurso.</p>
    <p className="real-alert">Homologação: NF-e e DANFE sem valor fiscal de produção. O ensaio pode movimentar estoque, títulos e recebimentos comerciais reais nesta área, conforme as políticas. Use área dedicada e dados de teste.</p>
    <CommercialNfeChecklist />
    <NfceSettingsPanel />
    <NfseSettingsPanel />
    <p><Link to="/empresa-configuracoes">Conferir Dados da empresa</Link> · <Link to="/naturezas-operacao">Revisar naturezas de operação</Link></p>
    {!port && <p role="status">A configuração comercial de NF-e ainda não está disponível neste hospedeiro.</p>}
    {port && !settings && !error && <p role="status">Carregando configuração comercial…</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {error && !uncertain && port && <button type="button" className="secondary-button" disabled={busy} onClick={() => setReload(value => value + 1)}>Recarregar configuração</button>}
    {notice && <p className="real-notice" role="status">{notice}</p>}
    {settings && draft && <>
      <dl className="emissor-state">
        <dt>Ambiente salvo</dt><dd>{settings.environment === "producao" ? "Produção — efeito fiscal real" : "Homologação — sem valor fiscal de produção"}</dd>
        <dt>Produção nesta área</dt><dd>{settings.production_enabled_at ? `Habilitada por ${settings.production_enabled_by ?? "administrador"} em ${commercialStamp(settings.production_enabled_at)}` : "Ainda não habilitada"}</dd>
        <dt>Limites tributários</dt><dd>{settings.tax_limits_acknowledged_at ? "Ciência registrada. A operação concreta continua sujeita à revisão do contador." : "Ciência ainda não registrada"}</dd>
        <dt>Conexão conferida</dt><dd>{typeof connectionPublic?.issuer_cnpj === "string" ? `Emitente ${connectionPublic.issuer_cnpj}; versão ${String(connectionPublic.version ?? "não informada")}` : "Salve e confira a configuração após testar a conexão."}</dd>
      </dl>
      {!canConfigure && <p className="real-help">A alteração exige administrador com permissão de configuração fiscal. As operações sensíveis propostas por bots seguem a confirmação e as permissões da pessoa responsável.</p>}
      <form className="real-form emissor-form" onSubmit={event => { event.preventDefault(); void save(false); }}>
        <fieldset disabled={!canConfigure || busy || uncertain}>
          <legend>Ambiente, séries e efeitos locais</legend>
          <label>Ambiente para novas preparações<select value={draft.environment} onChange={event => { setDraft({ ...draft, environment: event.target.value as FiscalEnvironment }); setProductionConfirmed(false); }}>
            <option value="homologacao">Homologação</option>
            <option value="producao" disabled={!settings.production_enabled_at}>Produção</option>
          </select></label>
          {seriesControl("homologacao", "Série de homologação disponível no cofre")}
          {seriesControl("producao", "Série de produção disponível no cofre")}
          <p className="real-help">As opções vêm do cofre após conferir a configuração. Sem seleção, o cofre deve resolver uma única série adequada. O número da nota é definido exclusivamente pelo cofre.</p>
          {([['stock_timing', 'Estoque'], ['finance_timing', 'Financeiro']] as const).map(([key, label]) => <label key={key}>{label}<select value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value as EffectTiming })}>
            <option value="existing">Manter comportamento comercial existente</option>
            <option value="on_authorization">Somente na autorização fiscal</option>
          </select></label>)}
          <p className="real-help">Mudar a política não reverte lançamentos anteriores nem aplica efeitos pulados. Fiscal desligada preserva a venda sem nota; Estoque ou Financeiro desligados deixam o efeito explicitamente pulado.</p>
          <p className="real-help">A opção “somente na autorização fiscal” vale para pedidos de venda do próprio ERP. Fato vindo de módulo (Pedido, Mesas, Entrega e os demais) ainda não emite NF-e por aqui e é venda já acontecida: segue a automação da fase 3 e a intenção manual, sem esperar autorização fiscal.</p>
          <label style={{ display: "block" }}><input style={{ width: "auto" }} type="checkbox" checked={taxReviewed} onChange={event => setTaxReviewed(event.target.checked)} /> O contador conferiu CRT, CFOP, regras, bases e alíquotas, inclusive a possibilidade de emitir sem IBS/CBS/IS nesta operação e data. Operações que exijam esses tributos continuam bloqueadas.</label>
          <label style={{ display: "block" }}><input style={{ width: "auto" }} type="checkbox" checked={setupReviewed} onChange={event => setSetupReviewed(event.target.checked)} /> Conferi empresa, CNPJ, série permitida pelo cofre e parametrização fiscal.</label>
          <label style={{ display: "block" }}><input style={{ width: "auto" }} type="checkbox" checked={productionConfirmed} onChange={event => setProductionConfirmed(event.target.checked)} /> Confirmo a produção: novas notas terão efeito fiscal real. Usarei novos pedidos; dados de homologação não serão promovidos ou apagados e seus efeitos comerciais precisam ser tratados conscientemente.</label>
          <div className="real-actions">
            <button type="submit" className="primary-button" disabled={draft.environment === "producao" && !productionConfirmed}>Salvar e conferir configuração</button>
            <button type="button" className="secondary-button" disabled={!mayEnableProduction} onClick={() => void save(true)}>Habilitar e usar produção</button>
          </div>
          {!productionReady && <p className="real-help">Para habilitar produção, teste a conexão, confira a liberação no cofre e salve a configuração para obter os ambientes e séries permitidos. A conferência final de empresa e permissões é feita pelo servidor.</p>}
        </fieldset>
      </form>
      {uncertain && canConfigure && <button type="button" className="secondary-button" disabled={busy} onClick={() => void save(false, true)}>{busy ? "Conferindo…" : "Repetir o mesmo comando de configuração"}</button>}
      <p className="real-help">A mudança de ambiente não altera emissões abertas. Trocar a origem do cofre não redireciona retomadas pendentes. Nenhum ensaio é promovido para produção.</p>
    </>}
  </section>;
}
