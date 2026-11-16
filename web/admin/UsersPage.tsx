// Pessoas e acessos: contas individuais da equipe.
import React, { useState } from "react";
import { Plus } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import { parse } from "../lib/format";
import {
  Badge,
  Button,
  Field,
  Notice,
  SkeletonBlock,
  Table,
  toast,
} from "../ui";
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

/** O que a pessoa acessa, de GET /profiles/{p}/access (src/access.ts). */
type Catalog = { data: Row[]; presets: Row[] };

/** Lista guardada → marcada: null vale como ["*"] (atendente completo). */
const listOf = (value: string[] | null | undefined) => value ?? ["*"];

/** Marca ou desmarca um item; "*" se desfaz e se refaz conforme o caso. */
function toggleAccess(
  catalog: Row[],
  value: string[],
  id: string,
  on: boolean,
) {
  const plain = catalog.filter((i) => !i.role).map((i) => i.id as string);
  const roles = value.filter((v) => v.includes(":"));
  let items = value.includes("*")
    ? plain
    : value.filter((v) => v !== "*" && !v.includes(":"));
  const isRole = id.includes(":");
  const nextRoles = isRole ? toggled(roles, id, on) : roles;
  if (!isRole) items = toggled(items, id, on);
  const all = plain.every((p) => items.includes(p));
  return [...(all ? ["*"] : items), ...nextRoles];
}

/**
 * Caixas do que a pessoa acessa: atalhos de perfil, áreas do atendimento e
 * cada módulo ligado com os papéis dele (entregador, garçom, técnico…).
 */
function AccessEditor({
  catalog,
  value,
  onChange,
}: {
  catalog: Catalog;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const items = catalog.data;
  const checked = (item: Row) =>
    value.includes(item.id) || (!item.role && value.includes("*"));
  const preset =
    catalog.presets.find(
      (p) =>
        p.access.length === value.length &&
        p.access.every((id: string) => value.includes(id)),
    )?.id || "";
  const box = (item: Row, indent = false) => (
    <label
      className="check-field"
      key={item.id}
      title={item.description}
      style={indent ? { paddingLeft: 24 } : undefined}
    >
      <input
        type="checkbox"
        checked={checked(item)}
        onChange={(event) =>
          onChange(toggleAccess(items, value, item.id, event.target.checked))
        }
      />
      {item.label}
    </label>
  );
  const core = items.filter((i) => i.group === "core");
  const mods = items.filter((i) => i.group === "module" && !i.role);
  return (
    <>
      <Field
        label="Atalho de perfil"
        value={preset}
        onChange={(id) => {
          const chosen = catalog.presets.find((p) => p.id === id);
          if (chosen) onChange([...chosen.access]);
        }}
        emptyOption="Personalizado"
        options={catalog.presets.map((p) => [p.id, p.label])}
        help="Só preenche as caixas abaixo; ajuste depois se quiser."
      />
      <fieldset className="scope-grid">
        <legend>Atendimento</legend>
        {core.map((item) => box(item))}
      </fieldset>
      {mods.length > 0 && (
        <fieldset className="scope-grid">
          <legend>Módulos</legend>
          {mods.map((mod) => (
            <React.Fragment key={mod.id}>
              {box(mod)}
              {items
                .filter((i) => i.role && i.module_id === mod.id)
                .map((role) => box(role, true))}
            </React.Fragment>
          ))}
        </fieldset>
      )}
    </>
  );
}

/** Resumo na lista: "Completo", "Completo · Técnico" ou os itens marcados. */
function accessSummary(row: Row, items: Row[]) {
  if (row.role === "admin") return "Tudo (administrador)";
  const value = listOf(parse(row.access, null));
  const label = (id: string) => items.find((i) => i.id === id)?.label || id;
  const roles = value.filter((v) => v.includes(":")).map(label);
  const base = value.includes("*")
    ? ["Completo"]
    : value.filter((v) => !v.includes(":")).map(label);
  return [...base, ...roles].join(" · ") || "Nada";
}
function UserDialog({
  user,
  catalog,
  onClose,
  onSaved,
}: {
  /** Pessoa em edição; sem ela, cadastra uma nova. */
  user?: Row;
  /** Catálogo de acessos da área aberta (GET /access). */
  catalog: Catalog | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const app = useApp();
  const [form, setForm] = useState<Row>(
    user
      ? { ...user, profiles: parse(user.profiles, []) }
      : { role: "operator" },
  );
  const [access, setAccess] = useState<string[]>(
    listOf(user ? parse(user.access, null) : null),
  );
  const operator = (user?.role || form.role) !== "admin";
  const change = (key: string) => (value: any) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <FormDialog
      title={user ? "Editar pessoa" : "Adicionar pessoa"}
      onClose={onClose}
      onSubmit={async () => {
        // O que a pessoa acessa (só atendente; o administrador tem tudo).
        const chosen = operator && catalog ? { access } : {};
        if (user) {
          // form.access é o texto guardado; só a escolha nova vai junto.
          const { access: _saved, ...rest } = form;
          const body: Row = { ...rest, ...chosen };
          if (!body.password) delete body.password;
          await app.api("v1/users/" + form.id, "PATCH", body);
        } else
          await app.api("v1/users", "POST", {
            ...form,
            ...chosen,
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
      <Field
        label="Nome"
        value={form.name}
        onChange={change("name")}
        required
      />
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
      {operator && catalog && (
        <AccessEditor catalog={catalog} value={access} onChange={setAccess} />
      )}
      {!operator && <p>O administrador acessa tudo.</p>}
    </FormDialog>
  );
}

export function UsersPage() {
  const app = useApp();
  const list = useList("v1/users");
  const catalog = useResource(`${app.root}/access`);
  const items: Row[] = catalog.data?.data || [];
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
                "access",
                "O que acessa",
                (row: Row) => accessSummary(row, items),
              ] as [string, string, (row: Row) => string],
              [
                "disabled",
                "Acesso",
                (row) => (
                  <Badge value={row.disabled ? "disabled" : "enabled"} />
                ),
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
          catalog={catalog.data || null}
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
