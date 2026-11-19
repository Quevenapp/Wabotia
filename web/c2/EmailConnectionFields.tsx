import React, { useRef, useState } from "react";
import type { ChannelUiData, ConnectionFieldsProps } from "../channel-extension-contracts";

const object = (value: unknown): ChannelUiData => value && typeof value === "object" && !Array.isArray(value) ? value as ChannelUiData : {};
const text = (value: unknown) => typeof value === "string" ? value : "";

/** Normalização operacional; não remove pontos ou +tag e não confirma identidade. */
export function normalizeChannelEmail(input: string): string {
  const address = input.trim().toLowerCase();
  if (address.length > 254 || /[\s,;<>\r\n\u0000]/.test(address) || !/^[^@]+@[^@]+\.[^@]+$/.test(address))
    throw new Error("Informe um único endereço de e-mail válido.");
  const [local, domain] = address.split("@");
  let hostname: string;
  try { hostname = new URL(`https://${domain}`).hostname; } catch { throw new Error("Revise o domínio do e-mail."); }
  if (!hostname || /[\\/:?#%]/.test(domain) || !/^[a-z0-9.-]+$/.test(hostname) || hostname.endsWith(".")) throw new Error("Revise o domínio do e-mail.");
  return `${local}@${hostname}`;
}

export function prepareEmailConnection(form: ChannelUiData) {
  const config = object(form.config);
  return { config: {
    address: normalizeChannelEmail(text(form.address ?? config.address)),
    c2_enabled: true,
    bot_enabled: (form.bot_enabled ?? config.bot_enabled) === true,
    auto_ack_enabled: (form.auto_ack_enabled ?? config.auto_ack_enabled) === true,
  }, secrets: {} };
}

export function emailTestLabel(state: unknown): string {
  return ({ received: "Teste recebido. Recebimento confirmado.", pending: "Teste pendente. O desafio vale por dez minutos.",
    expired: "Teste inconclusivo: o prazo terminou sem confirmação.", failed: "Teste inconclusivo: não foi possível confirmar o recebimento." } as Record<string, string>)[text(state)]
    ?? "Recebimento ainda não confirmado.";
}

interface PendingOperation { path: string; method: string; body: ChannelUiData; key: string }

export function EmailConnectionFields(props: ConnectionFieldsProps) {
  if (props.form.channel !== "email" && props.form.kind !== "email") return null;
  return <EmailSetupFields key={text(props.form.id)} {...props} />;
}

function EmailSetupFields({ form, change, disabled, api, root, refresh }: ConnectionFieldsProps) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [setup, setSetup] = useState<ChannelUiData>({}), [entries, setEntries] = useState<readonly ChannelUiData[] | null>(null);
  const [box, setBox] = useState("automatic"), [nextCursor, setNextCursor] = useState("");
  const [blockKind, setBlockKind] = useState("address"), [blockValue, setBlockValue] = useState("");
  const pending = useRef<PendingOperation | null>(null);
  const config = object(form.config), base = `${root}/c2/connections/${encodeURIComponent(text(form.id))}`;
  const lock = disabled || busy || !!pending.current;
  async function mutate(path: string, method: string, body: ChannelUiData) {
    if (!form.id || busy || disabled) return;
    const operation = pending.current ?? { path, method, body: structuredClone(body), key: crypto.randomUUID() };
    pending.current = operation; setBusy(true); setNotice("");
    try {
      const result = object(await api(operation.path, operation.method, operation.body, undefined, operation.key));
      if (operation.path.endsWith("/email-test")) setSetup(result);
      pending.current = null; setNotice(operation.path.endsWith("/email-test") ? "Teste iniciado. Consulte o resultado após receber a mensagem." : "Regra de bloqueio atualizada.");
    } catch { setNotice("Não foi possível confirmar a operação. Tente novamente com a mesma solicitação."); }
    finally { setBusy(false); }
    if (!pending.current) { try { await refresh(); } catch { /* A mutação já foi confirmada. */ } }
  }
  async function consult() {
    if (!form.id || busy) return;
    setBusy(true);
    try { setSetup(object(await api(`${base}/setup`))); setNotice(""); }
    catch { setNotice("Não foi possível consultar o teste de recebimento."); }
    finally { setBusy(false); }
  }
  async function loadBox(cursor = "") {
    if (!form.id || busy) return;
    setBusy(true);
    try {
      const result = object(await api(`${base}/email-inbox?state=${box}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
      const rows = Array.isArray(result.data) ? result.data.map(object) : [];
      setEntries(previous => cursor ? [...new Map([...(previous ?? []), ...rows].map(row => [text(row.id), row])).values()] : rows);
      setNextCursor(text(result.next_cursor)); setNotice("");
    } catch { setNotice("Não foi possível carregar a caixa de recebimento."); }
    finally { setBusy(false); }
  }
  function block(method: string) {
    try {
      const value = blockKind === "address" ? normalizeChannelEmail(blockValue) : normalizeChannelEmail(`caixa@${blockValue}`).split("@")[1];
      void mutate(`${base}/email-blocks`, method, { kind: blockKind, value });
    } catch { setNotice("Informe um endereço ou domínio válido para bloqueio exato."); }
  }
  return <section className="c2-connection-fields c2-email-setup" aria-label="Conexão de e-mail">
    <label>Endereço receptor exato<input type="email" value={text(form.address ?? config.address)} required disabled={disabled}
      onChange={event => change("address")(event.target.value)} /></label>
    <p>O endereço é exclusivo desta instalação. Alterá-lo exige um novo teste e conserva o histórico do endereço anterior.</p>
    <label><input type="checkbox" checked={(form.bot_enabled ?? config.bot_enabled) === true} disabled={disabled}
      onChange={event => change("bot_enabled")(event.target.checked)} /> Ativar bot para informação geral e encaminhamento</label>
    <p>Desligado por padrão. Mesmo ativado, o bot recebe somente a entrada atual e não consulta dados de clientes ou histórico privado.</p>
    <label><input type="checkbox" checked={(form.auto_ack_enabled ?? config.auto_ack_enabled) === true} disabled={disabled}
      onChange={event => change("auto_ack_enabled")(event.target.checked)} /> Ativar confirmação automática de recebimento</label>
    <p>A confirmação usa texto fixo, sem dados de cliente, até uma vez por remetente por hora. Mensagens automáticas, listas, devoluções, testes e bloqueios não abrem conversa nem recebem confirmação.</p>
    <details><summary>Configurar recebimento manualmente</summary><ol>
      <li>Escolha um domínio ou subdomínio com DNS na Cloudflare.</li>
      <li>Confira os MX antes de configurar Email Routing. Se já usa Google, Microsoft ou outro provedor, preserve seus MX e valide um subdomínio para este recebimento.</li>
      <li>Crie uma regra de endereço exato para o Worker desta instalação.</li>
      <li>Salve o mesmo endereço acima e execute “Testar recebimento”.</li>
      <li>Confira também a configuração de envio em Sistema.</li>
      <li>Mantenha o nome do Worker; se mudar, revise a regra de recebimento.</li>
    </ol><p>Convivência de subdomínio, nomes no painel e repetição após falha: a conferir com a conta real. Esta tela não altera DNS, MX ou regras de roteamento.</p></details>
    <p>Envio usa a configuração do Sistema. Esta conexão não solicita credencial SMTP nem token de zona.</p>
    <p role="status">{emailTestLabel(setup.test_state ?? setup.state ?? form.test_state ?? config.test_state)}</p>
    {form.id ? <div className="c2-actions">
      <button type="button" disabled={lock} onClick={() => void mutate(`${base}/email-test`, "POST", {})}>Testar recebimento</button>
      <button type="button" disabled={busy || disabled} onClick={() => void consult()}>Consultar resultado</button>
    </div> : <p>Salve a conexão antes de testar o recebimento.</p>}
    {!!form.id && <details><summary>Automáticos, bloqueados e quarentena</summary>
      <p>Estas caixas não criam atendimento. O bruto não é exibido.</p>
      <label>Caixa<select value={box} disabled={busy} onChange={event => { setBox(event.target.value); setEntries(null); setNextCursor(""); }}>
        <option value="automatic">Automáticos e devoluções</option><option value="blocked">Bloqueados</option><option value="quarantine">Quarentena</option>
      </select></label><button type="button" disabled={busy} onClick={() => void loadBox()}>Carregar caixa</button>
      {entries && (entries.length ? <ul>{entries.map((entry, index) => <li key={text(entry.id) || index}>
        {text(entry.sender)}{text(entry.subject) && ` · ${text(entry.subject)}`}
      </li>)}</ul> : <p>Nenhuma entrada nesta caixa.</p>)}
      {nextCursor && <button type="button" disabled={busy} onClick={() => void loadBox(nextCursor)}>Carregar mais</button>}
      <label>Bloqueio<select value={blockKind} disabled={lock} onChange={event => setBlockKind(event.target.value)}>
        <option value="address">Endereço exato</option><option value="domain">Domínio exato</option>
      </select></label><label>Endereço ou domínio<input value={blockValue} disabled={lock} onChange={event => setBlockValue(event.target.value)} /></label>
      <button type="button" disabled={lock || !blockValue} onClick={() => block("PUT")}>Bloquear</button>
      <button type="button" disabled={lock || !blockValue} onClick={() => block("DELETE")}>Remover bloqueio</button>
    </details>}
    {pending.current && !busy && <button type="button" disabled={disabled} onClick={() => { const operation = pending.current!; void mutate(operation.path, operation.method, operation.body); }}>Tentar confirmar novamente</button>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
