// Hermes e canais: cadastro, diagnóstico e estado de cada conexão.
import React, { useState } from "react";
import { Bot, Plug, Plus } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import { date, parse } from "../lib/format";
import { linkProps, navigate } from "../lib/routes";
import {
  Badge,
  Button,
  Confirm,
  CopyButton,
  Dialog,
  Empty,
  Notice,
  SkeletonBlock,
} from "../ui";
import { ConnectionDiagnostics } from "../ConnectionDiagnostics";
import { CloudflareDeploy } from "../SystemPanel";
import { ConnectionDialog } from "./ConnectionDialog";
import { SecretDialog, useList } from "./shared";

const aiProviderText: Row = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  compatible: "API compatível com OpenAI",
};

const kindText = (kind: string) =>
  kind === "hermes"
    ? "Bots e ferramentas"
    : kind === "ai"
      ? "Bot por provedor de IA, sem servidor"
      : kind === "telegram"
        ? "Telegram · canal removido"
        : kind === "meta"
          ? "WhatsApp Meta · integração anterior"
          : kind === "zernio"
            ? "WhatsApp pela Zernio"
            : kind === "qr"
              ? "WhatsApp por QR"
              : "WhatsApp pelo Hermes";

// Tipos de conexão que deixaram de existir: só podem ser excluídos.
const removedKinds = ["meta", "telegram"];
// Conexões de telefone: excluir remove a linha, não a conta no provedor.
const phoneKinds = ["meta", "zernio", "qr", "hermes-whatsapp"];

const zernioWebhook = (row: Row) =>
  location.origin +
  (parse(row.config).zernio_workspace_id
    ? "/webhooks/zernio-accounts/" + parse(row.config).zernio_workspace_id
    : "/webhooks/zernio/" + row.id);

// Variantes do comando de instalação do plugin para Hermes em Docker (imagem
// oficial: dados em /opt/data, do usuário hermes).
function dockerCommand(pairing: Row, where: "host" | "inside") {
  const script = `curl -fsSL ${location.origin}/hermes-plugin/install.sh`,
    args = `${location.origin} ${pairing.code}`;
  return where === "host"
    ? `${script} | docker exec -i -u hermes CONTEINER bash -s -- ${args}`
    : `${script} | su -s /bin/bash hermes -c 'HERMES_BIN=/opt/hermes/bin/hermes HERMES_HOME=/opt/data bash -s -- ${args}'`;
}
const dockerSteps = {
  list: "docker ps --format '{{.Names}}  {{.Image}}'",
  restart: "docker restart CONTEINER",
  version:
    "docker exec -u hermes CONTEINER grep PLUGIN_VERSION /opt/data/plugins/wabotia/link.py",
};

export function ConnectionsPage() {
  const app = useApp();
  const { api, root, demo } = app;
  const list = useList(root + "/connections");
  const { busy, run } = useAction();
  const [editing, setEditing] = useState<Row | null>(null),
    [secret, setSecret] = useState(""),
    [removing, setRemoving] = useState<Row | null>(null),
    [pairing, setPairing] = useState<Row | null>(null),
    [revoking, setRevoking] = useState<Row | null>(null);
  const reload = async () => {
    await Promise.all([list.reload(), app.refresh().catch(() => {})]);
  };
  return (
    <>
      <div className="callout">
        <Plug size={22} />
        <div>
          <strong>Um lugar para cada conexão</strong>
          <p>
            Use bots pelo Hermes, com ferramentas, ou direto por um provedor de
            IA, sem servidor. A equipe atende pelo painel e pelos aplicativos. A
            Integração Zernio e seus telefones ficam em{" "}
            <a {...linkProps({ area: "admin", page: "router" })}>
              Integração Zernio
            </a>
            .
          </p>
        </div>
      </div>
      <details className="workspace-disclosure">
        <summary>Meu Hermes está no computador ou em uma rede privada</summary>
        <CloudflareDeploy
          key={app.profile}
          api={api}
          demo={demo}
          profile={app.profile}
          openSystem={() => navigate({ area: "admin", page: "system" })}
          refreshConnections={reload}
        />
      </details>
      <div className="toolbar">
        <p>
          O Hermes ou o provedor de IA fornece a inteligência. Os canais trazem
          as conversas.
        </p>
        <Button
          onClick={() => setEditing({ kind: "hermes" })}
          icon={<Plus size={17} />}
        >
          Nova conexão
        </Button>
      </div>
      {list.error && (
        <Notice tone="error" onRetry={() => void list.reload()}>
          {list.error}
        </Notice>
      )}
      {!list.loaded && !list.error && <SkeletonBlock height={220} />}
      <div className="cards-grid">
        {list.rows.map((row) => (
          <section className="card integration-card" key={row.id}>
            <div className="section-heading">
              <span className="integration-icon">
                {["hermes", "ai"].includes(row.kind) ? <Bot /> : <Plug />}
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
            {!removedKinds.includes(row.kind) && (
              <button
                type="button"
                className="text-link"
                onClick={() => setEditing({ ...row, ...parse(row.config) })}
              >
                Editar conexão
              </button>
            )}
            <p>{kindText(row.kind)}</p>
            {row.kind === "ai" && (
              <p>
                {aiProviderText[parse(row.config).provider] ||
                  parse(row.config).provider}{" "}
                · {parse(row.config).model}
                {parse(row.config).effort
                  ? ` · esforço ${({ low: "baixo", medium: "médio", high: "alto" } as Row)[parse(row.config).effort] || parse(row.config).effort}`
                  : ""}
                {parse(row.config).text_only !== false
                  ? " · apenas mensagens"
                  : ""}
              </p>
            )}
            <small>Último contato: {date(row.last_seen)}</small>
            {!removedKinds.includes(row.kind) && (
              <ConnectionDiagnostics
                hermes={row.kind === "hermes"}
                listsBots={["hermes", "ai"].includes(row.kind)}
                demo={demo}
                disabled={busy}
                request={(action, signal) =>
                  api(
                    root + `/connections/${row.id}/${action}`,
                    "POST",
                    {},
                    signal,
                  )
                }
                refresh={reload}
                showBots={() => navigate({ area: "admin", page: "bots" })}
              >
                <Button
                  secondary
                  disabled={busy}
                  onClick={() =>
                    run(
                      () =>
                        api(root + `/connections/${row.id}/state`, "PUT", {
                          status: row.status === "active" ? "paused" : "active",
                        }),
                      { success: "Salvo com sucesso." },
                    ).then(reload)
                  }
                >
                  {row.status === "active" ? "Pausar" : "Ativar"}
                </Button>
              </ConnectionDiagnostics>
            )}
            {row.kind === "telegram" && (
              <p className="notice">
                O atendimento pelo Telegram foi removido. Esta conexão não é
                mais usada: exclua-a. A equipe atende pelo painel e pelos
                aplicativos.
              </p>
            )}
            {row.kind === "meta" && (
              <p className="notice">
                A integração direta com a Meta foi desativada. Resolva operações
                em andamento ou sem confirmação, exclua esta linha e importe o
                telefone já conectado na Zernio. O histórico é preservado.
              </p>
            )}
            {[
              "meta",
              "zernio",
              "qr",
              "hermes-whatsapp",
              "telegram",
              "hermes",
              "ai",
            ].includes(row.kind) && (
              <Button
                secondary
                disabled={busy}
                onClick={() => {
                  if (!app.demoBlocked()) setRemoving(row);
                }}
              >
                {phoneKinds.includes(row.kind)
                  ? "Excluir telefone"
                  : "Excluir conexão"}
              </Button>
            )}
            {["qr", "hermes-whatsapp"].includes(row.kind) && (
              <button
                type="button"
                className="text-link"
                onClick={() =>
                  run(
                    () =>
                      api(
                        root + `/connections/${row.id}/connector-token`,
                        "POST",
                        {},
                      ),
                    { success: "Salvo com sucesso.", retry: false },
                  ).then((result) => {
                    if (result?.token) setSecret(result.token);
                  })
                }
              >
                Gerar chave do conector
              </button>
            )}
            {row.kind === "hermes" &&
              parse(row.config).transport === "link" && (
                <>
                  <p>
                    {parse(row.config).link
                      ? `Plugin pareado em ${parse(row.config).link.host || "máquina sem nome"}, em ${date(parse(row.config).link.paired_at)}.`
                      : "Plugin ainda não pareado. Gere o comando e execute na máquina do Hermes."}
                  </p>
                  <button
                    type="button"
                    className="text-link"
                    onClick={() =>
                      run(
                        () =>
                          api(
                            root + `/connections/${row.id}/link-code`,
                            "POST",
                            {},
                          ),
                        { success: "Comando gerado.", retry: false },
                      ).then((result) => {
                        if (result?.command) setPairing(result);
                      })
                    }
                  >
                    {parse(row.config).link
                      ? "Parear novamente"
                      : "Gerar comando de instalação"}
                  </button>{" "}
                  {parse(row.config).link && (
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => {
                        if (!app.demoBlocked()) setRevoking(row);
                      }}
                    >
                      Revogar plugin
                    </button>
                  )}
                </>
              )}
            {row.kind === "zernio" && (
              <div className="resource-id">
                <span>Webhook Zernio</span>
                <code>{zernioWebhook(row)}</code>
                <CopyButton value={zernioWebhook(row)} />
              </div>
            )}
            <small className="resource-id">
              ID: {row.id} <CopyButton value={row.id} />
            </small>
          </section>
        ))}
      </div>
      {list.loaded && !list.rows.length && (
        <section className="card">
          <Empty
            icon={<Plug size={28} />}
            title="Conecte seu primeiro serviço"
            description="Comece pelo Hermes ou por um provedor de IA. Depois configure o WhatsApp."
          />
        </section>
      )}
      {editing && (
        <ConnectionDialog
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}
      {secret && <SecretDialog token={secret} onClose={() => setSecret("")} />}
      {pairing && (
        <Dialog
          title="Instale o plugin no Hermes"
          onClose={() => {
            setPairing(null);
            void reload();
          }}
          footer={
            <Button
              onClick={() => {
                setPairing(null);
                void reload();
              }}
            >
              Concluir
            </Button>
          }
        >
          <p>
            Execute na máquina onde o Hermes está instalado (Linux, macOS ou
            WSL2), com o mesmo usuário do Hermes. O código vale até{" "}
            {date(pairing.expires)} e só pode ser usado uma vez.
          </p>
          <div className="secret-box">
            <code>{pairing.command}</code>
            <CopyButton value={pairing.command} />
          </div>
          <details>
            <summary>Meu Hermes roda em Docker</summary>
            <p>
              Nesse caso o comando acima não encontra o Hermes. Siga estes
              passos no terminal do servidor, trocando <code>CONTEINER</code>{" "}
              pelo nome do contêiner do Hermes.
            </p>
            <p>1. Descubra o nome do contêiner:</p>
            <div className="secret-box">
              <code>{dockerSteps.list}</code>
              <CopyButton value={dockerSteps.list} />
            </div>
            <p>2. Instale o plugin:</p>
            <div className="secret-box">
              <code>{dockerCommand(pairing, "host")}</code>
              <CopyButton value={dockerCommand(pairing, "host")} />
            </div>
            <p>
              Se o terminal já abre dentro do contêiner (como no painel da
              Hostinger), use este no lugar:
            </p>
            <div className="secret-box">
              <code>{dockerCommand(pairing, "inside")}</code>
              <CopyButton value={dockerCommand(pairing, "inside")} />
            </div>
            <p>3. Reinicie o contêiner, pelo servidor:</p>
            <div className="secret-box">
              <code>{dockerSteps.restart}</code>
              <CopyButton value={dockerSteps.restart} />
            </div>
            <p>4. Confira a versão do plugin instalado:</p>
            <div className="secret-box">
              <code>{dockerSteps.version}</code>
              <CopyButton value={dockerSteps.version} />
            </div>
          </details>
          {parse(list.rows.find((r) => r.id === pairing.connection_id)?.config)
            .link && (
            <p>
              Esta conexão já está pareada: o plugin atual funciona até o
              comando ser executado e, depois dele, os bots ficam fora do ar até
              o gateway reiniciar. É assim que se atualiza o plugin.
            </p>
          )}
          <p>
            Depois de reiniciar o gateway do Hermes, volte a este cartão e use{" "}
            <strong>Testar conexão</strong>, <strong>Descobrir bots</strong> e{" "}
            <strong>Ativar</strong>.
          </p>
        </Dialog>
      )}
      {revoking && (
        <Confirm
          title={"Revogar o plugin de " + revoking.name + "?"}
          confirmLabel="Revogar plugin"
          danger
          busy={busy}
          onClose={() => setRevoking(null)}
          onConfirm={() =>
            run(
              () =>
                api(
                  root + `/connections/${revoking.id}/link-revoke`,
                  "POST",
                  {},
                ),
              { success: "Plugin revogado." },
            ).then(async () => {
              setRevoking(null);
              await reload();
            })
          }
        >
          <p>
            O Hermes dessa máquina deixa de receber execuções desta conexão. Os
            bots continuam cadastrados; para voltar a usar, pareie novamente.
          </p>
        </Confirm>
      )}
      {removing && phoneKinds.includes(removing.kind) && (
        <Confirm
          title={"Excluir o telefone " + removing.name + " do Wabotia?"}
          confirmLabel="Excluir telefone"
          danger
          busy={busy}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            run(() => api(root + "/connections/" + removing.id, "DELETE", {}), {
              success: "Telefone excluído. Histórico preservado.",
            }).then(async () => {
              setRemoving(null);
              await reload();
            })
          }
        >
          <p>
            O histórico será preservado. A conta no provedor não será
            desconectada nem excluída. Mensagens e operações de grupo ainda na
            fila serão canceladas. Resolva envios em andamento, operações sem
            confirmação e ligações abertas antes de excluir.
          </p>
        </Confirm>
      )}
      {removing && !phoneKinds.includes(removing.kind) && (
        <Confirm
          title={"Excluir a conexão " + removing.name + " do Wabotia?"}
          confirmLabel="Excluir conexão"
          danger
          busy={busy}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            run(() => api(root + "/connections/" + removing.id, "DELETE", {}), {
              success: "Conexão excluída. Histórico preservado.",
            }).then(async () => {
              setRemoving(null);
              await reload();
            })
          }
        >
          {removing.kind === "telegram" ? (
            <p>A conexão Telegram não é mais usada e será removida.</p>
          ) : (
            <>
              <p>
                Os bots desta conexão deixam de existir no Wabotia e a chave
                guardada é apagada. Conversas, mensagens e execuções anteriores
                continuam no histórico.{" "}
                {removing.kind === "ai"
                  ? "A conta no provedor de IA não é alterada."
                  : "O Hermes não é alterado; se o plugin estiver instalado, ele perde o acesso e pode ser desativado no Hermes."}
              </p>
              <p>
                Pause a conexão antes. Se um bot dela for o Bot Atendente, um
                especialista, um item de menu ou o bot de uma linha, troque-o
                antes de excluir.
              </p>
            </>
          )}
        </Confirm>
      )}
    </>
  );
}
