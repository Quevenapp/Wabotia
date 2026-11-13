// Integrações: cria a aplicação e a chave que o Hermes Agent usa no servidor
// MCP publicado pelo próprio Worker em /api/mcp, e mostra a configuração.
import React, { useEffect, useState } from "react";
import { Bot, Check } from "lucide-react";
import { Button, CopyButton, Field, Notice } from "../ui";

type Row = Record<string, any>;
const baseScopes = [
  "conversations:read",
  "conversations:write",
  "contacts:read",
  "contacts:write",
  "tickets:read",
  "tickets:write",
  "knowledge:read",
  "bots:read",
  "bots:invoke",
  "presence:read",
  "events:read",
  "reports:read",
];
const extras: [string, string[], string][] = [
  ["Ler notas internas das conversas", ["notes:read"], "notes"],
  [
    "Consultar e enviar pelas linhas WhatsApp da Zernio",
    ["routing:read", "routing:send"],
    "router",
  ],
  ["Cadastrar conhecimento", ["knowledge:write"], "knowledge"],
];
export const mcpUrl = () => location.origin + "/api/mcp";
export const hermesConfig = (url: string) =>
  `mcp_servers:
  wabotia:
    url: "${url}"
    headers:
      Authorization: "Bearer \${WABOTIA_MCP_KEY}"
    timeout: 90
    keepalive_interval: 120`;

export function HermesMcpPanel({
  api,
  demo,
  profiles,
  onChange,
}: {
  api: any;
  demo: boolean;
  profiles: Row[];
  onChange: () => void;
}) {
  const [selectedProfile, setProfile] = useState(""),
    [bots, setBots] = useState<Row[]>([]),
    [botIds, setBotIds] = useState<string[]>([]),
    [chosen, setChosen] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [issued, setIssued] = useState<Row | null>(null);
  const profile =
    profiles.length === 1
      ? profiles[0].id
      : profiles.find((p) => p.id === selectedProfile)?.id || "";
  const profileName = profiles.find((p) => p.id === profile)?.name || "";
  useEffect(() => {
    setBots([]);
    setBotIds([]);
    if (demo || !profile) return;
    api(`v1/profiles/${profile}/bots`)
      .then((list: any) => setBots(list.data || list || []))
      .catch(() => setBots([]));
  }, [profile, demo]);
  const scopes = [
    ...baseScopes,
    ...extras.filter(([, , key]) => chosen.includes(key)).flatMap(([, s]) => s),
  ];
  async function create() {
    if (demo) {
      setError("Indisponível no modo de demonstração.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const app = await api("v1/applications", "POST", {
        name: `Hermes Agent (MCP) · ${profileName}`.slice(0, 100),
        profiles: [profile],
        scopes,
        bots: botIds,
        rate: 120,
        run_limit: 3,
      });
      const key = await api(`v1/applications/${app.id}/keys`, "POST", {
        days: 365,
      });
      setIssued({ token: key.token, expires: key.expires, app_id: app.id });
      onChange();
    } catch (e: any) {
      setError(e.message || "Não foi possível concluir.");
    } finally {
      setBusy(false);
    }
  }
  const url = mcpUrl();
  const config = hermesConfig(url);
  return (
    <section className="card" id="hermes-mcp">
      <h2>
        <Bot size={18} /> Ferramentas do Wabotia no Hermes Agent (MCP)
      </h2>
      <p>
        Esta instalação já publica um servidor MCP em <code>{url}</code>, junto
        com o painel, a cada deploy na Cloudflare. O Hermes Agent o usa como
        ferramentas nativas: consultar e responder conversas, abrir protocolos,
        agenda de contatos, bots e linhas. Não há nada para instalar no
        servidor: basta uma chave de aplicação e o trecho de configuração abaixo
        no Hermes.
      </p>
      {issued ? (
        <>
          <p>
            <strong>Chave emitida.</strong> Ela aparece somente agora e vale até{" "}
            {new Date(issued.expires).toLocaleDateString("pt-BR", {
              timeZone: "America/Sao_Paulo",
            })}
            . Guarde-a no arquivo <code>.env</code> do perfil Hermes, sem
            publicá-la em chats ou repositórios.
          </p>
          <div className="secret-box">
            <code>WABOTIA_MCP_KEY={issued.token}</code>
            <CopyButton value={`WABOTIA_MCP_KEY=${issued.token}`} />
          </div>
          <p>
            1. Cole a linha acima em <code>~/.hermes/.env</code> (perfil padrão)
            ou <code>~/.hermes/profiles/NOME/.env</code>. 2. Acrescente ao{" "}
            <code>config.yaml</code> do mesmo perfil:
          </p>
          <pre>
            <code>{config}</code>
          </pre>
          <div className="card-actions">
            <CopyButton value={config} label="Copiar configuração" />
            <Button onClick={() => setIssued(null)} icon={<Check size={16} />}>
              Guardei minha chave
            </Button>
          </div>
          <p>
            3. Confira com <code>hermes mcp test wabotia</code> ou envie{" "}
            <code>/reload-mcp</code> em uma sessão aberta. As ferramentas
            aparecem como <code>mcp__wabotia__list_conversations</code>,{" "}
            <code>mcp__wabotia__reply_conversation</code> e assim por diante.
            Para limitar o que o agente pode fazer, use{" "}
            <code>tools: include</code> ou <code>tools: exclude</code> no mesmo
            bloco, ou revogue a chave aqui.
          </p>
        </>
      ) : (
        <>
          {profiles.length > 1 && (
            <Field
              label="Área de atendimento"
              value={selectedProfile}
              onChange={setProfile}
              options={profiles}
            />
          )}
          <p>
            A aplicação criada recebe leitura e escrita de conversas, contatos,
            protocolos, conhecimento, presença, eventos e relatórios, além da
            execução dos bots marcados. Permissões adicionais:
          </p>
          <div className="scope-grid">
            {extras.map(([label, , key]) => (
              <label className="check-field" key={key}>
                <input
                  type="checkbox"
                  checked={chosen.includes(key)}
                  onChange={(e) =>
                    setChosen(
                      e.target.checked
                        ? [...chosen, key]
                        : chosen.filter((k) => k !== key),
                    )
                  }
                />
                {label}
              </label>
            ))}
          </div>
          {bots.length > 0 && (
            <>
              <h3>Bots que o Hermes pode executar pelo MCP</h3>
              <div className="scope-grid">
                {bots.map((b) => (
                  <label className="check-field" key={b.id}>
                    <input
                      type="checkbox"
                      checked={botIds.includes(b.id)}
                      onChange={(e) =>
                        setBotIds(
                          e.target.checked
                            ? [...botIds, b.id]
                            : botIds.filter((id) => id !== b.id),
                        )
                      }
                    />
                    {b.name}
                  </label>
                ))}
              </div>
            </>
          )}
          <div className="card-actions">
            <Button
              disabled={busy || !profile}
              busy={busy}
              onClick={() => void create()}
            >
              Criar aplicação e chave para o Hermes
            </Button>
          </div>
          {error && (
            <Notice tone="error" onClose={() => setError("")}>
              {error}
            </Notice>
          )}
          <details>
            <summary>Já tenho uma chave de aplicação</summary>
            <p>
              Qualquer chave emitida em{" "}
              <strong>Integração manual pela API</strong> funciona, com as
              permissões que ela tiver. Guarde-a como{" "}
              <code>WABOTIA_MCP_KEY</code> no <code>.env</code> do perfil Hermes
              e adicione ao <code>config.yaml</code>:
            </p>
            <pre>
              <code>{config}</code>
            </pre>
            <div className="card-actions">
              <CopyButton value={config} label="Copiar configuração" />
            </div>
            <p>
              Teste com <code>hermes mcp test wabotia</code>. O endpoint
              responde JSON-RPC por POST sem sessão; HEAD e GET retornam 405, o
              que o cliente do Hermes trata como endpoint válido. Chaves de
              sessão dos aplicativos móveis não são aceitas.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
