// Sistemas conectados: pareamento (Senhapp) e integração manual pela API.
import React, { useState } from "react";
import { ArrowUpRight, Code2, Link2, Plus } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import { navigate } from "../lib/routes";
import { Badge, Button, Empty, Field, Notice, Table, toast } from "../ui";
import { PairingPanel } from "../PairingPanel";
import { HermesMcpPanel } from "./HermesMcpPanel";
import { AreaAccess } from "./UsersPage";
import { FormDialog, SecretDialog, toggled, useResource } from "./shared";

const defaultScopes = [
  "calls:read",
  "calls:write",
  "groups:manage",
  "conversations:read",
  "conversations:write",
  "contacts:read",
  "contacts:write",
  "tickets:read",
  "tickets:write",
  "bots:read",
  "bots:invoke",
  "webhooks:manage",
];

type Open =
  | { kind: "application" }
  | { kind: "key"; app_id: string }
  | { kind: "webhook"; app_id: string }
  | { kind: "secret"; token: string }
  | null;

function ApplicationDialog({
  scopes,
  onClose,
  onSaved,
}: {
  scopes: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const app = useApp();
  const [form, setForm] = useState<Row>({});
  const change = (key: string) => (value: any) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <FormDialog
      title="Nova aplicação"
      onClose={onClose}
      size="lg"
      onSubmit={async () => {
        await app.api("v1/applications", "POST", {
          ...form,
          profiles: form.profiles || [app.profile],
          scopes: form.scopes || [
            "conversations:read",
            "tickets:read",
            "bots:read",
          ],
          bots: form.bots || [],
        });
        toast("Salvo com sucesso.");
        await onSaved();
        onClose();
      }}
    >
      <Field
        label="Nome"
        value={form.name}
        onChange={change("name")}
        required
      />
      {app.profiles.length === 1 ? (
        <p>Acesso à Área de atendimento compartilhada pela equipe.</p>
      ) : (
        <AreaAccess
          value={form.profiles || [app.profile]}
          onChange={change("profiles")}
        />
      )}
      <fieldset className="scope-grid">
        <legend>Permissões na Área de atendimento</legend>
        {(scopes.length ? scopes : defaultScopes).map((scope) => (
          <label className="check-field" key={scope}>
            <input
              type="checkbox"
              checked={(form.scopes || []).includes(scope)}
              onChange={(event) =>
                change("scopes")(
                  toggled(form.scopes || [], scope, event.target.checked),
                )
              }
            />
            {scope}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Bots que esta aplicação pode executar</legend>
        {app.bots.map((bot) => (
          <label className="check-field" key={bot.id}>
            <input
              type="checkbox"
              checked={(form.bots || []).includes(bot.id)}
              onChange={(event) =>
                change("bots")(
                  toggled(form.bots || [], bot.id, event.target.checked),
                )
              }
            />
            {bot.name}
          </label>
        ))}
        {!app.bots.length && <p className="muted">Nenhum bot cadastrado.</p>}
      </fieldset>
    </FormDialog>
  );
}

export function ApplicationsPage() {
  const app = useApp();
  const { api, demo, root } = app;
  const resource = useResource("v1/applications");
  const { busy, run } = useAction();
  const [open, setOpen] = useState<Open>(null);
  const [days, setDays] = useState("90"),
    [url, setUrl] = useState("");
  const rows: Row = resource.data || {};
  return (
    <>
      <PairingPanel api={api} demo={demo} profiles={app.profiles} />
      <HermesMcpPanel
        api={api}
        demo={demo}
        profiles={app.profiles}
        onChange={() => void resource.reload()}
      />
      <section className="card integration-explainer">
        <h2>Depois de conectar</h2>
        <p>
          Para o Senhapp, crie as filas e os guichês em{" "}
          <strong>Gestão → Filas e guichês</strong>. O totem emite senhas, o
          painel de TV mostra as chamadas e o guichê chama e transfere, cada um
          com as permissões aprovadas no pareamento.
        </p>
        <div className="card-actions">
          <Button
            secondary
            onClick={() => navigate({ area: "admin", page: "queue-settings" })}
          >
            Configurar filas e guichês
          </Button>
        </div>
      </section>
      <details className="card" open>
        <summary>Integração manual pela API · avançado</summary>
        <div className="toolbar">
          <p>Crie chaves com as permissões necessárias para cada sistema.</p>
          <Button
            onClick={() => setOpen({ kind: "application" })}
            icon={<Plus size={17} />}
          >
            Nova aplicação
          </Button>
        </div>
        {resource.error && (
          <Notice tone="error" onRetry={() => void resource.reload()}>
            {resource.error}
          </Notice>
        )}
        <section className="card">
          <Table
            rows={rows.applications || []}
            columns={[
              ["name", "Aplicação"],
              ["rate", "Requisições/min"],
              ["run_limit", "Execuções simultâneas"],
              [
                "disabled",
                "Estado",
                (row) => (
                  <Badge value={row.disabled ? "disabled" : "enabled"} />
                ),
              ],
            ]}
            action={(row) => (
              <div className="card-actions">
                <Button
                  secondary
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () =>
                        api("v1/applications/" + row.id, "PATCH", {
                          disabled: !row.disabled,
                        }),
                      { success: "Salvo com sucesso." },
                    ).then(resource.reload)
                  }
                >
                  {row.disabled ? "Ativar" : "Desativar"}
                </Button>
                <Button
                  secondary
                  size="sm"
                  onClick={() => {
                    setDays("90");
                    setOpen({ kind: "key", app_id: row.id });
                  }}
                >
                  Gerar chave
                </Button>
                <Button
                  secondary
                  size="sm"
                  onClick={() => {
                    setUrl("");
                    setOpen({ kind: "webhook", app_id: row.id });
                  }}
                >
                  Webhook
                </Button>
              </div>
            )}
            empty={
              <Empty
                icon={<Link2 size={28} />}
                title="O Wabotia dentro dos seus sistemas"
                description="Cadastre uma aplicação para integrar mensagens, protocolos e bots à sua operação."
              />
            }
          />
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
            action={(row) =>
              row.revoked ? (
                <Badge value="revoked" />
              ) : (
                <button
                  type="button"
                  className="text-link danger"
                  disabled={busy}
                  onClick={() =>
                    run(() => api("v1/keys/" + row.id, "DELETE"), {
                      success: "Salvo com sucesso.",
                    }).then(resource.reload)
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
      </details>
      {open?.kind === "application" && (
        <ApplicationDialog
          scopes={rows.scopes || []}
          onClose={() => setOpen(null)}
          onSaved={resource.reload}
        />
      )}
      {open?.kind === "key" && (
        <FormDialog
          title="Gerar chave"
          size="sm"
          onClose={() => setOpen(null)}
          onSubmit={async () => {
            const result = await api(
              `v1/applications/${open.app_id}/keys`,
              "POST",
              { days: Number(days) || 90 },
            );
            await resource.reload();
            setOpen(
              result.token ? { kind: "secret", token: result.token } : null,
            );
          }}
        >
          <Field
            label="Validade em dias (até 365)"
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={setDays}
          />
        </FormDialog>
      )}
      {open?.kind === "webhook" && (
        <FormDialog
          title="Cadastrar webhook"
          onClose={() => setOpen(null)}
          onSubmit={async () => {
            const result = await api(root + "/webhook-subscriptions", "POST", {
              app_id: open.app_id,
              url,
              events: [
                "message.received",
                "ticket.updated",
                "bot.run.completed",
              ],
            });
            const token = result.token || result.signing_secret;
            setOpen(token ? { kind: "secret", token } : null);
          }}
        >
          <Field
            label="URL HTTPS do seu sistema"
            type="url"
            value={url}
            onChange={setUrl}
            placeholder="https://seusistema.com/wabotia"
            required
          />
          <p>
            Receberá novas mensagens, atualizações de protocolo e conclusão de
            bots. O segredo de assinatura será exibido após salvar.
          </p>
        </FormDialog>
      )}
      {open?.kind === "secret" && (
        <SecretDialog token={open.token} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
