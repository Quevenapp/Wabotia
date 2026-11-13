// Pessoas e acessos: contas individuais da equipe.
import React, { useState } from "react";
import { Plus } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import { parse } from "../lib/format";
import { Badge, Button, Field, Notice, SkeletonBlock, Table, toast } from "../ui";
import { FormDialog, Pager, toggled, useList } from "./shared";

/** Caixas de seleção das áreas de atendimento a que a pessoa ou sistema tem acesso. */
export function AreaAccess({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const app = useApp();
  return (
    <fieldset className="scope-grid">
      <legend>Acesso à Área de atendimento</legend>
      {app.profiles.map((area) => (
        <label className="check-field" key={area.id}>
          <input
            type="checkbox"
            checked={value.includes(area.id)}
            onChange={(event) =>
              onChange(toggled(value, area.id, event.target.checked))
            }
          />
          {area.name}
        </label>
      ))}
    </fieldset>
  );
}

function UserDialog({
  user,
  onClose,
  onSaved,
}: {
  /** Pessoa em edição; sem ela, cadastra uma nova. */
  user?: Row;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const app = useApp();
  const [form, setForm] = useState<Row>(
    user
      ? { ...user, profiles: parse(user.profiles, []) }
      : { role: "operator" },
  );
  const change = (key: string) => (value: any) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <FormDialog
      title={user ? "Editar pessoa" : "Adicionar pessoa"}
      onClose={onClose}
      onSubmit={async () => {
        if (user) {
          const body = { ...form };
          if (!body.password) delete body.password;
          await app.api("v1/users/" + form.id, "PATCH", body);
        } else
          await app.api("v1/users", "POST", {
            ...form,
            role: form.role || "operator",
            profiles: form.profiles || [app.profile],
          });
        toast("Salvo com sucesso.");
        await onSaved();
        // A própria conta pode ter mudado de nome ou de acesso.
        if (user?.id === app.me.id) void app.reloadSession();
        onClose();
      }}
    >
      <Field label="Nome" value={form.name} onChange={change("name")} required />
      {!user && (
        <Field
          label="E-mail"
          type="email"
          value={form.email}
          onChange={change("email")}
          autoComplete="off"
        />
      )}
      <Field
        label={
          user
            ? "Nova senha (mínimo 12 caracteres)"
            : "Senha inicial (mínimo 12 caracteres)"
        }
        type="password"
        value={form.password}
        onChange={change("password")}
        autoComplete="new-password"
        help={user ? "Deixe em branco para manter a senha atual." : undefined}
      />
      {!user && (
        <Field
          label="Papel"
          value={form.role}
          onChange={change("role")}
          emptyOption={null}
          options={[
            ["operator", "Atendente"],
            ["admin", "Administrador"],
          ]}
        />
      )}
      {!user && app.profiles.length === 1 && (
        <p>Acesso à Área de atendimento compartilhada pela equipe.</p>
      )}
      {(app.profiles.length > 1 || user) && (
        <AreaAccess
          value={form.profiles || [app.profile]}
          onChange={change("profiles")}
        />
      )}
    </FormDialog>
  );
}

export function UsersPage() {
  const app = useApp();
  const list = useList("v1/users");
  const { busy, run } = useAction();
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  return (
    <>
      <div className="toolbar">
        <p>Acesso individual, responsabilidade clara.</p>
        <Button onClick={() => setEditing("new")} icon={<Plus size={17} />}>
          Adicionar pessoa
        </Button>
      </div>
      {list.error && (
        <Notice tone="error" onRetry={() => void list.reload()}>
          {list.error}
        </Notice>
      )}
      <section className="card">
        {!list.loaded && !list.error ? (
          <SkeletonBlock height={160} />
        ) : (
          <Table
            rows={list.rows}
            columns={[
              ["name", "Pessoa"],
              ["email", "E-mail"],
              [
                "role",
                "Papel",
                (row) => (row.role === "admin" ? "Administrador" : "Atendente"),
              ],
              [
                "disabled",
                "Acesso",
                (row) => <Badge value={row.disabled ? "disabled" : "enabled"} />,
              ],
            ]}
            action={(row) => (
              <div className="card-actions">
                <Button secondary size="sm" onClick={() => setEditing(row)}>
                  Editar
                </Button>
                <Button
                  secondary
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () =>
                        app.api("v1/users/" + row.id, "PATCH", {
                          disabled: !row.disabled,
                        }),
                      { success: "Salvo com sucesso." },
                    ).then(list.reload)
                  }
                >
                  {row.disabled ? "Ativar" : "Desativar"}
                </Button>
              </div>
            )}
          />
        )}
      </section>
      <Pager {...list} />
      {editing && (
        <UserDialog
          user={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await list.reload();
            void app.refresh().catch(() => {});
          }}
        />
      )}
    </>
  );
}
