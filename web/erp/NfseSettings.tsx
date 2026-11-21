// Preferências do Fiscal → Nota de serviço (NFS-e) da ordem de serviço.
// O que é do emitente (inscrição municipal, série da DPS, regime especial,
// certificado) fica no cofre: aqui só aparece o que o cofre informa e o que
// falta. O cadastro fiscal do serviço (código de tributação nacional, NBS,
// alíquota e retenção do ISS, município de prestação) e a natureza da nota de
// peças ficam no ERP. Ambiente e produção são os da configuração do emissor.
import { useEffect, useMemo, useState } from "react";
import { canCommercialNfe } from "./commercial-nfe";
import { erpPorts } from "./ports";

interface ServiceCodes { national_code?: string; municipal_code?: string; nbs?: string; iss_rate?: string }
interface NfseConfig {
  version: number; national_code: string | null; municipal_code: string | null; nbs: string | null; iss_rate: string | null;
  iss_withheld: boolean; simples_apportionment: number | null; municipality_code: string | null; parts_nature_id: string | null;
  resolved_parts_nature_id: string | null; items: Record<string, ServiceCodes>;
  services: { id: string; name: string; code: string | null }[]; natures: { id: string; description: string }[];
  company: { crt: string | null; municipality_code: string | null; regime: string };
  vault: { configured: boolean; checked_at: number | null; nfse: boolean | null };
}
const APPORTIONMENT = [
  { id: "1", name: "Tributos federais e ISS pelo Simples Nacional" },
  { id: "2", name: "Federais pelo Simples; ISS fora do Simples" },
  { id: "3", name: "Federais e ISS fora do Simples" },
];

function useNfseAccess() {
  const ports = erpPorts();
  const access = ports?.commercialNfe?.access();
  return { ports, read: !!access && canCommercialNfe(access, "read"), configure: !!access && canCommercialNfe(access, "configure") && !ports?.demo };
}

export function NfseSettingsPanel() {
  const { ports, read, configure } = useNfseAccess();
  const base = useMemo(() => ports ? ports.apiUrl.replace(/\/erp\/?$/, "/erp-comercial-nfe") : null, [ports]);
  const [config, setConfig] = useState<NfseConfig | null>(null), [draft, setDraft] = useState<NfseConfig | null>(null);
  const [error, setError] = useState(""), [saved, setSaved] = useState(""), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  useEffect(() => {
    if (!base || !read) return;
    const request = new AbortController();
    void fetch(`${base}/nfse/config`, { credentials: "same-origin", cache: "no-store", signal: request.signal, headers: { Accept: "application/json" } })
      .then(async response => {
        const value = await response.json().catch(() => null) as (NfseConfig & { message?: string }) | null;
        if (!response.ok || !value) throw new Error(value?.message ?? "Não deu para ler a configuração da nota de serviço agora.");
        if (!request.signal.aborted) { setConfig(value); setDraft(value); }
      }).catch(e => { if (!request.signal.aborted && e?.name !== "AbortError") setError(e.message); });
    return () => request.abort();
  }, [base, read, reload]);
  if (!read || !base) return null;
  const set = <K extends keyof NfseConfig>(key: K, value: NfseConfig[K]) => setDraft(current => current ? { ...current, [key]: value } : current);
  const setItem = (id: string, key: keyof ServiceCodes, value: string) => setDraft(current => {
    if (!current) return current;
    const entry = { ...current.items[id], [key]: value || undefined };
    const items = { ...current.items, [id]: entry };
    if (!Object.values(entry).some(Boolean)) delete items[id];
    return { ...current, items };
  });
  const save = async () => {
    if (!draft || !config) return;
    setBusy(true); setError(""); setSaved("");
    try {
      const command = crypto.randomUUID();
      const response = await fetch(`${base}/nfse/config`, { method: "PUT", credentials: "same-origin", cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": command },
        body: JSON.stringify({ command_id: command, expected_version: config.version, national_code: draft.national_code || null,
          municipal_code: draft.municipal_code || null, nbs: draft.nbs || null, iss_rate: draft.iss_rate || null, iss_withheld: draft.iss_withheld,
          simples_apportionment: draft.simples_apportionment, municipality_code: draft.municipality_code || null,
          parts_nature_id: draft.parts_nature_id || null, items: draft.items }) });
      const value = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) throw new Error(value?.message ?? "A configuração não foi salva. Confira os códigos e tente de novo.");
      setSaved("Configuração da nota de serviço salva."); setReload(n => n + 1);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const simples = config?.company.crt === "1" || config?.company.crt === "2";
  const missing: string[] = [];
  if (config) {
    if (!config.vault.configured) missing.push("Testar a conexão com o cofre (acima).");
    else if (config.vault.nfse === false) missing.push("O cofre configurado não emite NFS-e do Sistema Nacional: confira o cofre (prefeituras com provedor próprio ainda não são atendidas).");
    if (!config.company.municipality_code) missing.push("Código do município da empresa (IBGE) em Dados da empresa.");
    if (!config.company.crt) missing.push("Regime tributário (CRT) da empresa em Dados da empresa → Fiscal.");
    if (!config.national_code && !Object.values(config.items).some(item => item.national_code)) missing.push("Código de tributação nacional do serviço (abaixo).");
    if (config.company.crt === "3" && !config.iss_rate) missing.push("Alíquota do ISS: a empresa está fora do Simples Nacional.");
    if (!config.resolved_parts_nature_id) missing.push(config.natures.length ? "Escolher a natureza da nota de peças (há mais de uma)." : "Cadastrar uma natureza de venda para a nota de peças.");
  }
  return <section className="emissor-settings nfse-settings">
    <h3>Nota de serviço (NFS-e) da ordem de serviço</h3>
    <p>A ordem com orçamento aprovado emite a nota de serviço (NFS-e do Sistema Nacional) com os serviços e a nota de peças (NF-e) com as peças. Homologação por padrão; produção só pelo "Habilitar produção" da configuração do emissor.</p>
    {error && <p role="alert">{error}</p>}
    {saved && <p role="status">{saved}</p>}
    {!config && !error && <p>Carregando…</p>}
    {config && draft && <>
      <h4>O que o cofre informa</h4>
      <ul>
        <li>Emite NFS-e: {config.vault.nfse === true ? "sim" : config.vault.nfse === false ? "não" : "ainda não informado (use Testar conexão)"}.</li>
        <li>Inscrição municipal, série da DPS e regime especial: ficam no cofre, que não os informa ao Vinki. Confira na tela do cofre.</li>
        <li>Regime da empresa: {config.company.regime}{config.company.municipality_code ? `; município ${config.company.municipality_code}` : ""}.</li>
      </ul>
      {missing.length > 0 && <><h4>O que falta configurar</h4><ul>{missing.map(item => <li key={item}>{item}</li>)}</ul></>}
      <h4>Cadastro fiscal do serviço</h4>
      <fieldset disabled={!configure || busy}>
        <label>Código de tributação nacional (6 dígitos)<input inputMode="numeric" maxLength={6} value={draft.national_code ?? ""} onChange={e => set("national_code", e.target.value.replace(/\D/g, ""))} /></label>
        <label>Código de tributação municipal (3 dígitos, opcional)<input inputMode="numeric" maxLength={3} value={draft.municipal_code ?? ""} onChange={e => set("municipal_code", e.target.value.replace(/\D/g, ""))} /></label>
        <label>NBS (9 dígitos, opcional)<input inputMode="numeric" maxLength={9} value={draft.nbs ?? ""} onChange={e => set("nbs", e.target.value.replace(/\D/g, ""))} /></label>
        <label>Alíquota do ISS em % {simples ? "(opcional no Simples Nacional)" : ""}<input inputMode="decimal" maxLength={4} placeholder="2,00" value={draft.iss_rate ?? ""} onChange={e => set("iss_rate", e.target.value.replace(/[^\d,.]/g, ""))} /></label>
        <label className="check"><input type="checkbox" checked={draft.iss_withheld} onChange={e => set("iss_withheld", e.target.checked)} /> ISS retido pelo cliente (exige cliente com CNPJ)</label>
        {simples && <label>Apuração no Simples Nacional<select value={String(draft.simples_apportionment ?? (config.company.crt === "2" ? 2 : 1))} onChange={e => set("simples_apportionment", Number(e.target.value))}>
          {APPORTIONMENT.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>}
        <label>Município de prestação (código IBGE, 7 dígitos; vazio usa o da empresa)<input inputMode="numeric" maxLength={7} value={draft.municipality_code ?? ""} onChange={e => set("municipality_code", e.target.value.replace(/\D/g, ""))} /></label>
        <label>Natureza da nota de peças<select value={draft.parts_nature_id ?? ""} onChange={e => set("parts_nature_id", e.target.value || null)}>
          <option value="">{config.natures.length === 1 ? `Única possível: ${config.natures[0].description}` : "Escolha"}</option>
          {config.natures.map(nature => <option key={nature.id} value={nature.id}>{nature.description}</option>)}</select></label>
        {config.services.length > 0 && <details>
          <summary>Códigos por serviço do catálogo (só quando diferem do padrão)</summary>
          <table><thead><tr><th>Serviço</th><th>Código nacional</th><th>Municipal</th><th>Alíquota ISS</th></tr></thead><tbody>
            {config.services.map(service => <tr key={service.id}><td>{service.name}</td>
              <td><input aria-label={`Código nacional de ${service.name}`} inputMode="numeric" maxLength={6} value={draft.items[service.id]?.national_code ?? ""} onChange={e => setItem(service.id, "national_code", e.target.value.replace(/\D/g, ""))} /></td>
              <td><input aria-label={`Código municipal de ${service.name}`} inputMode="numeric" maxLength={3} value={draft.items[service.id]?.municipal_code ?? ""} onChange={e => setItem(service.id, "municipal_code", e.target.value.replace(/\D/g, ""))} /></td>
              <td><input aria-label={`Alíquota do ISS de ${service.name}`} inputMode="decimal" maxLength={4} value={draft.items[service.id]?.iss_rate ?? ""} onChange={e => setItem(service.id, "iss_rate", e.target.value.replace(/[^\d,.]/g, ""))} /></td></tr>)}
          </tbody></table>
          <p>Uma nota de serviço leva um código só: os serviços de uma mesma ordem precisam do mesmo código, alíquota e código municipal.</p>
        </details>}
      </fieldset>
      {configure ? <button type="button" disabled={busy} onClick={() => void save()}>{busy ? "Salvando…" : "Salvar nota de serviço"}</button>
        : <p>Só o administrador altera esta configuração.</p>}
      <p>IBS, CBS e IS ainda não são enviados na nota de serviço: serviço com classificação desses tributos fica bloqueado com explicação.</p>
    </>}
  </section>;
}
