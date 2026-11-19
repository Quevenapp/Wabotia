// Pessoas e acessos: contas individuais da equipe.
import React, { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import { api, type Row } from "../lib/api";
import { parse } from "../lib/format";
import {
  Badge,
  Button,
  Confirm,
  CopyButton,
  Dialog,
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
export function toggleAccess(
  catalog: Row[],
  value: string[],
  id: string,
  on: boolean,
) {
  const plain = catalog.filter((i) => !i.role && !i.explicitOnly).map((i) => i.id as string);
  const separate = value.filter((v) => v !== "*" && !plain.includes(v));
  let items = value.includes("*")
    ? plain
    : value.filter((v) => plain.includes(v));
  const isSeparate = !plain.includes(id);
  const nextSeparate = isSeparate ? toggled(separate, id, on) : separate;
  if (!isSeparate) items = toggled(items, id, on);
  const all = plain.every((p) => items.includes(p));
  return [...(all ? ["*"] : items), ...nextSeparate];
}

/**
 * Caixas do que a pessoa acessa: atalhos de perfil, áreas do atendimento e
 * cada módulo ligado com os papéis dele (entregador, garçom, técnico…).
 */
export function AccessEditor({
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
    value.includes(item.id) || (!item.role && !item.explicitOnly && value.includes("*"));
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
  const core = items.filter((i) => i.group === "core" && !i.explicitOnly);
  const explicit = items.filter((i) => i.explicitOnly);
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
      {explicit.length > 0 && (
        <fieldset className="scope-grid">
          <legend>Permissões com concessão explícita</legend>
          <p>Marque separadamente. O atalho “Atendente completo” não concede estas permissões.</p>
          {explicit.map((item) => box(item))}
        </fieldset>
      )}
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

/**
 * Papéis de módulo do administrador. Ser administrador não concede dados
 * sensíveis nem papéis de módulo (prontuário, prazos jurídicos, condomínio,
 * ensino): o servidor exige a concessão explícita também para ele.
 */
export function AdminRoles({
  catalog,
  value,
  onChange,
}: {
  catalog: Catalog;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const roles = catalog.data.filter((i) => i.role);
  if (!roles.length) return <p>O administrador acessa tudo.</p>;
  const moduleLabel = (id: string) =>
    catalog.data.find((i) => !i.role && i.id === id)?.label || id;
  return (
    <fieldset className="scope-grid">
      <legend>Papéis com concessão explícita</legend>
      <p>
        O administrador acessa tudo, menos dados sensíveis e papéis de módulo.
        Marque os que esta pessoa deve ter.
      </p>
      {roles.map((role) => (
        <label className="check-field" key={role.id} title={role.description}>
          <input
            type="checkbox"
            checked={value.includes(role.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value.filter((id) => id !== role.id), role.id]
                  : value.filter((id) => id !== role.id),
              )
            }
          />
          {moduleLabel(role.module_id)}: {role.label}
        </label>
      ))}
    </fieldset>
  );
}

/** Resumo na lista: "Completo", "Completo · Técnico" ou os itens marcados. */
function accessSummary(row: Row, items: Row[]) {
  const label = (id: string) => items.find((i) => i.id === id)?.label || id;
  if (row.role === "admin") {
    const roles = listOf(parse(row.access, null))
      .filter((id) => id.includes(":"))
      .map(label);
    return ["Tudo (administrador)", ...roles].join(" · ");
  }
  const value = listOf(parse(row.access, null));
  const roles = value.filter((v) => v.includes(":")).map(label);
  const base = value.includes("*")
    ? ["Completo"]
    : value.filter((v) => !v.includes(":")).map(label);
  return [...base, ...roles].join(" · ") || "Nada";
}
const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

/**
 * Horário de acesso (formato do Fagoo): janelas com início, fim e dias, no
 * horário de Brasília. Fora delas a pessoa não entra; o administrador é
 * isento.
 */
function ScheduleEditor({
  value,
  onChange,
}: {
  value: Row | null;
  onChange: (next: Row | null) => void;
}) {
  const on = !!value?.enabled;
  const windows: Row[] = value?.windows || [];
  const set = (next: Row[]) =>
    onChange(next.length ? { enabled: true, windows: next } : null);
  return (
    <fieldset className="scope-grid">
      <legend>Horário de acesso (Brasília)</legend>
      <label className="check-field">
        <input
          type="checkbox"
          checked={on}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? {
                    enabled: true,
                    windows: windows.length
                      ? windows
                      : [
                          {
                            start: "08:00",
                            end: "18:00",
                            days: [1, 2, 3, 4, 5],
                          },
                        ],
                  }
                : null,
            )
          }
        />
        Só entra nos horários abaixo
      </label>
      {on &&
        windows.map((w, index) => (
          <div className="queue-form-row" key={index}>
            <Field
              label="Início"
              type="time"
              value={w.start}
              onChange={(start) =>
                set(windows.map((x, i) => (i === index ? { ...x, start } : x)))
              }
            />
            <Field
              label="Fim"
              type="time"
              value={w.end}
              onChange={(end) =>
                set(windows.map((x, i) => (i === index ? { ...x, end } : x)))
              }
            />
            <span>
              {WEEKDAYS.map((label, day) => (
                <label className="check-field" key={day}>
                  <input
                    type="checkbox"
                    checked={w.days.includes(day)}
                    onChange={(event) =>
                      set(
                        windows.map((x, i) =>
                          i === index
                            ? {
                                ...x,
                                days: toggled(x.days, day, event.target.checked)
                                  .slice()
                                  .sort((a: number, b: number) => a - b),
                              }
                            : x,
                        ),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
            </span>
            <button
              type="button"
              className="text-link danger"
              onClick={() => set(windows.filter((_, i) => i !== index))}
            >
              Remover
            </button>
          </div>
        ))}
      {on && windows.length < 10 && (
        <button
          type="button"
          className="text-link"
          onClick={() =>
            set([...windows, { start: "08:00", end: "12:00", days: [6] }])
          }
        >
          Acrescentar horário
        </button>
      )}
    </fieldset>
  );
}

/**
 * A instalação envia e-mail (Gestão → Sistema, src/email.ts): os links de
 * convite e de nova senha vão também por e-mail. Lido uma vez por página.
 */
let emailStatus: Promise<boolean> | null = null;
function useEmailOn(demo: boolean) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (demo) return;
    emailStatus ??= api("auth/status")
      .then((status) => !!status.email)
      .catch(() => false);
    void emailStatus.then(setOn);
  }, [demo]);
  return on;
}

/** Resultado do envio por e-mail de um link (email_status da resposta). */
function EmailResult({ result }: { result: Row }) {
  if (!result.email_status) return null;
  return result.email_status === "failed" ? (
    <Notice tone="warn">
      O e-mail não saiu ({result.email_error?.message}). Copie o link abaixo e
      envie por outro meio.
    </Notice>
  ) : (
    <Notice tone="ok">Enviamos o link para o e-mail da pessoa.</Notice>
  );
}

/** Senha e segundo fator de outra pessoa: link de redefinir e zerar o fator. */
function SecuritySection({ user }: { user: Row }) {
  const app = useApp();
  const { busy, run } = useAction();
  const [link, setLink] = useState<Row | null>(null);
  const emailOn = useEmailOn(app.demo);
  return (
    <fieldset className="scope-grid">
      <legend>Senha e segundo fator</legend>
      {user.invite_pending ? (
        <p>Convite ainda não aceito: a pessoa não criou a senha.</p>
      ) : null}
      <div className="toolbar">
        <Button
          secondary
          size="sm"
          busy={busy}
          onClick={() =>
            void run(async () =>
              setLink(
                await app.api(
                  `v1/people/${user.id}/password-link`,
                  "POST",
                  emailOn ? { send_email: true } : {},
                ),
              ),
            )
          }
        >
          {user.invite_pending
            ? "Novo link de convite"
            : "Link para redefinir a senha"}
        </Button>
        {!!user.has_mfa && (
          <Button
            secondary
            size="sm"
            busy={busy}
            onClick={() =>
              void run(
                () => app.api(`v1/people/${user.id}/mfa/reset`, "POST", {}),
                {
                  success:
                    "Segundo fator removido; a pessoa entra só com a senha e cadastra de novo.",
                },
              )
            }
          >
            Zerar segundo fator
          </Button>
        )}
      </div>
      {link && (
        <>
          <EmailResult result={link} />
          <p>
            Envie este link à pessoa. Vale 24 horas e uma vez só; a senha atual
            continua valendo até ela trocar.
          </p>
          <div className="secret-box">
            <code>{link.url}</code>
            <CopyButton value={link.url} />
          </div>
        </>
      )}
    </fieldset>
  );
}

/** Política do segundo fator da instalação (só administrador). */
function MfaPolicy() {
  const app = useApp();
  const { run } = useAction();
  const [policy, setPolicy] = useState<string>(app.me.mfa?.policy || "off");
  const [confirmAll, setConfirmAll] = useState(false);
  const save = (next: string) =>
    void run(() => app.api("v1/system/mfa-policy", "PUT", { policy: next }), {
      success: "Política do segundo fator salva.",
    }).then(() => setPolicy(next));
  return (
    <>
      <Field
        label="Segundo fator"
        value={policy}
        emptyOption={null}
        options={[
          ["off", "Opcional"],
          ["financial", "Exigido nas operações financeiras"],
          ["all", "Exigido para todos"],
        ]}
        onChange={(next) => (next === "all" ? setConfirmAll(true) : save(next))}
      />
      {confirmAll && (
        <Confirm
          title="Exigir o segundo fator para todos?"
          confirmLabel="Exigir para todos"
          onClose={() => setConfirmAll(false)}
          onConfirm={() => {
            setConfirmAll(false);
            save("all");
          }}
        >
          <p>
            Toda pessoa vai precisar do código do aplicativo autenticador para
            entrar; quem ainda não cadastrou só consegue cadastrar. Os
            aplicativos Wabotia de celular sem o passo do código (versões
            antigas) deixam de entrar até serem atualizados. Seu fator precisa
            estar cadastrado antes.
          </p>
        </Confirm>
      )}
    </>
  );
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
  const [schedule, setSchedule] = useState<Row | null>(
    parse(user?.schedule, null),
  );
  const [invited, setInvited] = useState<Row | null>(null);
  const emailOn = useEmailOn(app.demo);
  const change = (key: string) => (value: any) =>
    setForm((current) => ({ ...current, [key]: value }));
  // Convite criado: mostra o link para copiar e enviar à pessoa.
  if (invited)
    return (
      <Dialog
        title="Convite criado"
        onClose={onClose}
        footer={<Button onClick={onClose}>Pronto</Button>}
      >
        <EmailResult result={invited} />
        <p>
          Envie este link à pessoa. Ele vale 72 horas e uma vez só; ela cria a
          própria senha.
        </p>
        <div className="secret-box">
          <code>{invited.url}</code>
          <CopyButton value={invited.url} />
        </div>
      </Dialog>
    );
  return (
    <FormDialog
      title={user ? "Editar pessoa" : "Adicionar pessoa"}
      onClose={onClose}
      onSubmit={async () => {
        // O que a pessoa acessa (atendente) ou só os papéis explícitos
        // (administrador, que já tem o resto) e o horário de acesso.
        const chosen = {
          ...(operator && catalog ? { access } : {}),
          ...(!operator && catalog
            ? { access: access.filter((id) => id.includes(":")) }
            : {}),
          ...(operator ? { schedule } : {}),
        };
        if (user) {
          // Textos guardados (access, schedule) e campos só de leitura não
          // vão; só a escolha nova.
          const {
            access: _saved,
            schedule: _schedule,
            invite_pending: _pending,
            has_mfa: _mfa,
            ...rest
          } = form;
          const body: Row = { ...rest, ...chosen };
          if (!body.password) delete body.password;
          await app.api("v1/users/" + form.id, "PATCH", body);
        } else if (form.invite) {
          const { invite: _invite, password: _password, ...rest } = form;
          setInvited(
            await app.api("v1/users/invite", "POST", {
              ...rest,
              ...chosen,
              role: form.role || "operator",
              profiles: form.profiles || [app.profile],
              ...(emailOn ? { send_email: true } : {}),
            }),
          );
          await onSaved();
          return;
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
      {!user && (
        <label className="check-field">
          <input
            type="checkbox"
            checked={!!form.invite}
            onChange={(event) => change("invite")(event.target.checked)}
          />
          {emailOn
            ? "Convidar por e-mail: a pessoa recebe o link e cria a própria senha (vale 72 horas)"
            : "Convidar por link: a pessoa cria a própria senha (vale 72 horas)"}
        </label>
      )}
      {!form.invite && (
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
      )}
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
      {!operator &&
        (catalog ? (
          <AdminRoles catalog={catalog} value={access} onChange={setAccess} />
        ) : (
          <p>O administrador acessa tudo.</p>
        ))}
      {operator && <ScheduleEditor value={schedule} onChange={setSchedule} />}
      {user && <SecuritySection user={user} />}
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
        <MfaPolicy />
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
                (row) => <Badge value={row.disabled ? "disabled" : "enabled"} />,
              ],
              [
                "has_mfa",
                "Entrada",
                (row: Row) =>
                  row.invite_pending
                    ? "Convite pendente"
                    : row.has_mfa
                      ? "Senha + código"
                      : "Só senha",
              ] as [string, string, (row: Row) => string],
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
