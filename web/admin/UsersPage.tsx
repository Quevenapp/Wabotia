// Pessoas e acessos: contas individuais da equipe.
import React, { useState } from "react";
import { Plus } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import { parse } from "../lib/format";
import { Badge, Button, Field, Notice, SkeletonBlock, Table, toast } from "../ui";
import { FormDialog, Pager, toggled, useList, useResource } from "./shared";

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

/**
 * Papéis da pessoa nos módulos ligados da área aberta (entregador, garçom,
 * técnico, caixa), de GET /profiles/{p}/grants. Gravados em PUT /settings,
 * chave module_grants (docs/MODULOS.md, "Papéis por pessoa").
 */
function ModuleRoles({
  grants,
  value,
  onChange,
}: {
  grants: Row[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const app = useApp();
  if (!grants.length) return null;
  const area = app.profiles.find((p) => p.id === app.profile)?.name;
  return (
    <fieldset className="scope-grid">
      <legend>Papéis nos módulos{area ? ` (${area})` : ""}</legend>
      {grants.map((grant) => (
        <label className="check-field" key={grant.id} title={grant.description}>
          <input
            type="checkbox"
            checked={value.includes(grant.id)}
            onChange={(event) =>
              onChange(toggled(value, grant.id, event.target.checked))
            }
          />
          {grant.label} · {grant.module_name}
        </label>
      ))}
    </fieldset>
  );
}

/** Listas novas só dos papéis que mudaram para esta pessoa. */
function changedGrants(grants: Row[], person: string, chosen: string[]) {
  const patch: Record<string, string[]> = {};
  for (const grant of grants) {
    const ids: string[] = grant.people.map((p: Row) => p.id);
    const had = ids.includes(person),
      wants = chosen.includes(grant.id);
    if (had !== wants)
      patch[grant.id] = wants
        ? [...ids, person]
        : ids.filter((id) => id !== person);
  }
  return patch;
}

function UserDialog({
  user,
  grants,
  onClose,
  onSaved,
}: {
  /** Pessoa em edição; sem ela, cadastra uma nova. */
  user?: Row;
  /** Papéis da área aberta, com quem tem cada um. */
  grants: Row[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const app = useApp();
  const [form, setForm] = useState<Row>(
    user
      ? { ...user, profiles: parse(user.profiles, []) }
      : { role: "operator" },
  );
  const [roles, setRoles] = useState<string[]>(
    user
      ? grants
          .filter((g) => g.people.some((p: Row) => p.id === user.id))
          .map((g) => g.id)
      : [],
  );
  const change = (key: string) => (value: any) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <FormDialog
      title={user ? "Editar pessoa" : "Adicionar pessoa"}
      onClose={onClose}
      onSubmit={async () => {
        let id = user?.id;
        if (user) {
          const body = { ...form };
          if (!body.password) delete body.password;
          await app.api("v1/users/" + form.id, "PATCH", body);
        } else
          id = (
            await app.api("v1/users", "POST", {
              ...form,
              role: form.role || "operator",
              profiles: form.profiles || [app.profile],
            })
          ).id;
        const patch = id ? changedGrants(grants, id, roles) : {};
        if (Object.keys(patch).length)
          await app.api(`${app.root}/settings`, "PUT", {
            module_grants: patch,
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
      <ModuleRoles grants={grants} value={roles} onChange={setRoles} />
    </FormDialog>
  );
}

export function UsersPage() {
  const app = useApp();
  const list = useList("v1/users");
  const grants = useResource(`${app.root}/grants`);
  const roles: Row[] = grants.data?.data || [];
  const rolesOf = (id: string) =>
    roles
      .filter((g) => g.people.some((p: Row) => p.id === id))
      .map((g) => g.label)
      .join(", ") || "—";
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
              ...(roles.length
                ? [
                    [
                      "grants",
                      "Papéis nos módulos",
                      (row: Row) => rolesOf(row.id),
                    ] as [string, string, (row: Row) => string],
                  ]
                : []),
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
          grants={roles}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await Promise.all([list.reload(), grants.reload()]);
            void app.refresh().catch(() => {});
          }}
        />
      )}
    </>
  );
}
