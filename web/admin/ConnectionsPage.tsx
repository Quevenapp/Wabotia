// Hermes e canais: cadastro, diagnóstico e estado de cada conexão.
import React, { useState } from "react";
import { Bot, Plug, Plus, Send } from "lucide-react";
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
  Empty,
  Notice,
  SkeletonBlock,
} from "../ui";
import { ConnectionDiagnostics } from "../ConnectionDiagnostics";
import { CloudflareDeploy } from "../SystemPanel";
import { ConnectionDialog } from "./ConnectionDialog";
import { SecretDialog, useList } from "./shared";

const kindText = (kind: string) =>
  kind === "hermes"
    ? "Bots e ferramentas"
    : kind === "telegram"
      ? "Equipe humana via Telegram"
      : kind === "meta"
        ? "WhatsApp Meta · integração anterior"
        : kind === "zernio"
          ? "WhatsApp pela Zernio"
          : kind === "qr"
            ? "WhatsApp por QR"
            : "WhatsApp pelo Hermes";

const zernioWebhook = (row: Row) =>
  location.origin +
  (parse(row.config).zernio_workspace_id
    ? "/webhooks/zernio-accounts/" + parse(row.config).zernio_workspace_id
    : "/webhooks/zernio/" + row.id);

export function ConnectionsPage() {
  const app = useApp();
  const { api, root, demo } = app;
  const list = useList(root + "/connections");
  const { busy, run } = useAction();
  const [editing, setEditing] = useState<Row | null>(null),
    [secret, setSecret] = useState(""),
    [removing, setRemoving] = useState<Row | null>(null);
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
            Cadastre o Hermes para usar seus bots e o Telegram para a equipe
            humana. A Integração Zernio e seus telefones ficam em{" "}
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
        <p>Hermes fornece a inteligência. Os canais trazem as conversas.</p>
        {app.panelMode === "guided" ? (
          <div className="card-actions">
            <Button
              onClick={() => setEditing({ kind: "hermes" })}
              icon={<Bot size={17} />}
            >
              Conectar Hermes
            </Button>
            <Button
              secondary
              onClick={() => setEditing({ kind: "telegram" })}
              icon={<Send size={17} />}
            >
              Conectar Telegram
            </Button>
          </div>
        ) : (
          <Button
            onClick={() => setEditing({ kind: "hermes" })}
            icon={<Plus size={17} />}
          >
            Nova conexão
          </Button>
        )}
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
            {row.kind !== "meta" && (
              <button
                type="button"
                className="text-link"
                onClick={() => setEditing({ ...row, ...parse(row.config) })}
              >
                Editar conexão
              </button>
            )}
            <p>{kindText(row.kind)}</p>
            <small>Último contato: {date(row.last_seen)}</small>
            {row.kind !== "meta" && (
              <ConnectionDiagnostics
                hermes={row.kind === "hermes"}
                demo={demo}
                disabled={busy}
                request={(action, signal) =>
                  api(root + `/connections/${row.id}/${action}`, "POST", {}, signal)
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
              <button
                type="button"
                className="text-link"
                onClick={() =>
                  run(
                    () =>
                      api(
                        root + `/connections/${row.id}/telegram-webhook`,
                        "POST",
                        {},
                      ),
                    { success: "Webhook configurado." },
                  )
                }
              >
                Ligar recebimento Telegram
              </button>
            )}
            {row.kind === "meta" && (
              <p className="notice">
                A integração direta com a Meta foi desativada. Resolva
                operações em andamento ou sem confirmação, exclua esta linha e
                importe o telefone já conectado na Zernio. O histórico é
                preservado.
              </p>
            )}
            {["meta", "zernio", "qr", "hermes-whatsapp"].includes(row.kind) && (
              <Button
                secondary
                disabled={busy}
                onClick={() => {
                  if (!app.demoBlocked()) setRemoving(row);
                }}
              >
                Excluir telefone
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
            {row.kind === "zernio" && (
              <div className="resource-id">
                <span>Webhook Zernio</span>
                <code>{zernioWebhook(row)}</code>
                <CopyButton value={zernioWebhook(row)} />
              </div>
            )}
            {app.panelMode === "advanced" && (
              <small className="resource-id">
                ID: {row.id} <CopyButton value={row.id} />
              </small>
            )}
          </section>
        ))}
      </div>
      {list.loaded && !list.rows.length && (
        <section className="card">
          <Empty
            icon={<Plug size={28} />}
            title="Conecte seu primeiro serviço"
            description="Comece pelo Hermes. Depois configure WhatsApp e Telegram."
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
      {removing && (
        <Confirm
          title={"Excluir o telefone " + removing.name + " do Wabotia?"}
          confirmLabel="Excluir telefone"
          danger
          busy={busy}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            run(
              () => api(root + "/connections/" + removing.id, "DELETE", {}),
              { success: "Telefone excluído. Histórico preservado." },
            ).then(async () => {
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
    </>
  );
}
