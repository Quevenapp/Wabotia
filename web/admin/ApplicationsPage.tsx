// Sistemas conectados: pareamento (Senhapp) e integração manual pela API.
import React, { useState } from "react";
import { ArrowUpRight, Code2, Link2, Plus } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import { navigate } from "../lib/routes";
import { Badge, Button, Empty, Field, Notice, Table, toast } from "../ui";
import { PairingPanel } from "../PairingPanel";
import { AreaAccess } from "./UsersPage";
import { FormDialog, SecretDialog, toggled, useResource } from "./shared";

const defaultScopes = [
  "calls:read",
  "calls:write",
  "groups:manage",
  "conversations:read",
  "conversations:write",
  "conversations:email",
  "contacts:read",
  "contacts:write",
  "tickets:read",
  "tickets:write",
  "bots:read",
  "bots:invoke",
  "webhooks:manage",
];

/** A exportação é concedida separadamente; juntar contatos é exclusivo de pessoas. */
export function applicationScopes(scopes: string[]) {
  return [...new Set([...(scopes.length ? scopes : defaultScopes), "conversations:email"])]
    .filter((scope) => scope !== "contacts:merge");
}

export function toggleApplicationScope(value: string[], scope: string, checked: boolean) {
  let next = toggled(value, scope, checked);
  if (scope === "conversations:email" && checked && !next.includes("conversations:read"))
    next = [...next, "conversations:read"];
  if (scope === "conversations:read" && !checked)
    next = next.filter((item) => item !== "conversations:email");
  return next.filter((item) => item !== "contacts:merge");
}

export function ApplicationScopes({ scopes, value, onChange }: {
  scopes: string[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <fieldset className="scope-grid">
      <legend>Permissões na Área de atendimento</legend>
      {applicationScopes(scopes).map((scope) => (
        <label className="check-field" key={scope}>
          <input type="checkbox" checked={value.includes(scope)} onChange={(event) =>
            onChange(toggleApplicationScope(value, scope, event.target.checked))
          } />
          {scope === "conversations:email" ? "Enviar conversa por e-mail (concessão explícita)" : scope}
        </label>
      ))}
      <p className="muted">
        Enviar conversa por e-mail exige também leitura da conversa e respeita a visibilidade
        da aplicação. “*” não concede o envio. Aplicações não têm destino “Meu e-mail”
        e não podem juntar contatos.
      </p>
    </fieldset>
  );
}

/**
 * Papéis do ERP que uma aplicação pode ter (src/modules/erp/identity.ts):
 * como o agente do Fagoo, quem movimenta dinheiro ou administra a empresa
 * fica só com pessoas, que confirmam o segundo fator.
 */
const ERP_APP_ROLES: [string, string][] = [
  ["consulta", "Consulta: só lê cadastros, documentos, estoque e relatórios"],
  ["vendas", "Vendas: clientes, produtos, propostas e pedidos de venda"],
  ["estoque", "Estoque: entradas, saídas, inventário e pedidos de compra"],
  ["fiscal", "Fiscal: notas, documentos fiscais e tributação"],
];

/** Papel do ERP de uma aplicação, como a tela mostra. */
function erpRoleLabel(row: Row) {
  const scopes: string[] = JSON.parse(row.scopes || "[]");
  if (scopes.includes("erp:write"))
    return row.erp_role ? `${row.erp_role} (lê e altera)` : "sem papel";
  return scopes.includes("erp:read") ? "consulta (só lê)" : "—";
}

/** Escolha do papel do ERP para quem tem erp:write. */
function ErpRoleField({
  value,
  onChange,
}: {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="field">
      <span>Papel no ERP</span>
      <select
        value={value || ""}
        onChange={(event) => onChange(event.target.value || null)}
        required
      >
        <option value="">Escolha o papel</option>
        {ERP_APP_ROLES.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      <small className="muted">
        A aplicação entra no ERP como um usuário técnico com este papel, e o que
        ela fizer aparece na atividade do ERP com o nome dela. Administrador e
        financeiro não são oferecidos a aplicações: ficam com pessoas, que
        confirmam o segundo fator.
      </small>
    </label>
  );
}

type Open =
  | { kind: "application" }
  | { kind: "permissions"; app: Row }
  | { kind: "erp-role"; app: Row }
  | { kind: "key"; app_id: string }
  | { kind: "webhook"; app_id: string }
  | { kind: "secret"; token: string }
  | null;

function ApplicationPermissionsDialog({ app: row, onClose, onSaved }: {
  app: Row;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { api } = useApp();
  const [value, setValue] = useState<string[]>(JSON.parse(row.scopes || "[]"));
  return (
    <FormDialog title={`Envio de conversa por e-mail · ${row.name}`} onClose={onClose} onSubmit={async () => {
      await api("v1/applications/" + row.id, "PATCH", { scopes: value });
      toast("Permissões salvas.");
      await onSaved();
      onClose();
    }}>
      <label className="check-field">
        <input type="checkbox" checked={value.includes("conversations:email")} onChange={(event) =>
          setValue(toggleApplicationScope(value, "conversations:email", event.target.checked))
        } />
        Permitir envio de conversa por e-mail
      </label>
      <p>
        Esta concessão inclui a leitura de conversas e respeita a visibilidade da aplicação.
        O envio exige confirmação do destinatário. A aplicação não tem destino “Meu e-mail”.
      </p>
    </FormDialog>
  );
}

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
      <ApplicationScopes scopes={scopes} value={form.scopes || []} onChange={change("scopes")} />
      {(form.scopes || []).includes("erp:write") ? (
        <ErpRoleField value={form.erp_role} onChange={change("erp_role")} />
      ) : (form.scopes || []).includes("erp:read") ? (
        <p className="muted">
          Com erp:read, a aplicação lê o ERP com o papel de consulta.
        </p>
      ) : null}
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

/** Troca do papel do ERP de uma aplicação (entra na auditoria do núcleo). */
function ErpRoleDialog({
  app: row,
  onClose,
  onSaved,
}: {
  app: Row;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { api } = useApp();
  const [role, setRole] = useState<string | null>(row.erp_role || null);
  return (
    <FormDialog
      title={`Papel no ERP · ${row.name}`}
      size="sm"
      onClose={onClose}
      onSubmit={async () => {
        await api("v1/applications/" + row.id, "PATCH", { erp_role: role });
        toast("Papel do ERP salvo.");
        await onSaved();
        onClose();
      }}
    >
      <ErpRoleField value={role} onChange={setRole} />
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
              ["erp_role", "ERP", (row) => erpRoleLabel(row)],
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
                <Button secondary size="sm" onClick={() => setOpen({ kind: "permissions", app: row })}>
                  Permissão de e-mail
                </Button>
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
                {JSON.parse(row.scopes || "[]").includes("erp:write") && (
                  <Button
                    secondary
                    size="sm"
                    onClick={() => setOpen({ kind: "erp-role", app: row })}
                  >
                    Papel no ERP
                  </Button>
                )}
              </div>
            )}
            empty={
              <Empty
                icon={<Link2 size={28} />}
                title="O Vinki dentro dos seus sistemas"
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
      {open?.kind === "permissions" && (
        <ApplicationPermissionsDialog
          app={open.app}
          onClose={() => setOpen(null)}
          onSaved={resource.reload}
        />
      )}
      {open?.kind === "erp-role" && (
        <ErpRoleDialog
          app={open.app}
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
            placeholder="https://seusistema.com/vinki"
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
