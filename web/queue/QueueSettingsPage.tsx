// Gestão → Filas e guichês: filas, guichês, fila no WhatsApp, painéis de TV,
// totens Senhapp e lista negra. Contrato: docs/FILA-SENHAS.md.
import React, { useEffect, useState } from "react";
import { Ban, Monitor, Plus, Ticket } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import { linkProps } from "../lib/routes";
import type { Row } from "../lib/api";
import {
  Button,
  Card,
  CopyButton,
  Dialog,
  Empty,
  Field,
  Notice,
  Pill,
  SkeletonBlock,
  Switch,
  Table,
  toast,
} from "../ui";
import { FormDialog, toggled, useResource } from "../admin/shared";
import "../styles/queue.css";

const queueDefaults = {
  front_door: false,
  notify_ahead: 2,
  max_daily_per_contact: 3,
  kiosk_per_minute: 6,
  block_no_shows: 3,
  block_window_days: 30,
  block_days: 7,
  block_too_many: true,
  operators_can_block: true,
  blocked_can_talk: true,
};
const date = (at?: number | null) =>
  at
    ? new Date(at).toLocaleString("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";

function QueueDialog({
  initial,
  lines,
  onClose,
  onSaved,
}: {
  initial: Row | null;
  lines: Row[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useApp();
  const [form, setForm] = useState<Row>(
    initial || {
      name: "",
      prefix_normal: "N",
      prefix_preferential: "P",
      normals_per_preferential: 2,
      wait_mode: "average",
      service_minutes: 10,
      channels: ["whatsapp", "kiosk"],
      enabled: true,
    },
  );
  const set = (key: string) => (value: any) =>
    setForm((f) => ({ ...f, [key]: value }));
  return (
    <FormDialog
      title={initial ? `Editar fila ${initial.name}` : "Nova fila"}
      onClose={onClose}
      onSubmit={async () => {
        const body = {
          name: form.name,
          prefix_normal: String(form.prefix_normal || "").toUpperCase(),
          prefix_preferential: String(
            form.prefix_preferential || "",
          ).toUpperCase(),
          normals_per_preferential: Number(form.normals_per_preferential),
          wait_mode: form.wait_mode,
          service_minutes: Number(form.service_minutes),
          channels: form.channels,
          preferential_notice: form.preferential_notice,
          whatsapp_line_id: form.whatsapp_line_id || null,
          enabled: form.enabled,
        };
        await app.api(
          `${app.root}/queue/queues${initial ? "/" + initial.id : ""}`,
          initial ? "PUT" : "POST",
          body,
        );
        toast("Fila salva.");
        onSaved();
        onClose();
      }}
    >
      <Field
        label="Nome da fila"
        value={form.name}
        onChange={set("name")}
        required
        maxLength={60}
      />
      <div className="queue-form-row">
        <Field
          label="Prefixo normal"
          value={form.prefix_normal}
          onChange={set("prefix_normal")}
          maxLength={3}
        />
        <Field
          label="Prefixo preferencial"
          value={form.prefix_preferential}
          onChange={set("prefix_preferential")}
          maxLength={3}
        />
      </div>
      <Field
        label="Normais entre duas preferenciais"
        type="number"
        min={0}
        max={20}
        value={form.normals_per_preferential}
        onChange={set("normals_per_preferential")}
        help="0 = preferencial sempre na frente. 2 = depois de uma preferencial, chama duas normais."
      />
      <Field
        label="Tempo de espera mostrado ao cliente"
        value={form.wait_mode}
        onChange={set("wait_mode")}
        emptyOption={null}
        options={[
          ["average", "Média real dos atendimentos do dia"],
          ["fixed", "Tempo fixo por atendimento"],
        ]}
      />
      <Field
        label={
          form.wait_mode === "fixed"
            ? "Minutos por atendimento"
            : "Minutos por atendimento (padrão sem histórico)"
        }
        type="number"
        min={1}
        max={600}
        value={form.service_minutes}
        onChange={set("service_minutes")}
      />
      <fieldset className="queue-checks">
        <legend>Onde o cliente retira senha</legend>
        {[
          ["whatsapp", "WhatsApp"],
          ["kiosk", "Totem Senhapp"],
        ].map(([value, label]) => (
          <label key={value}>
            <input
              type="checkbox"
              checked={(form.channels || []).includes(value)}
              onChange={(event) =>
                set("channels")(
                  toggled(form.channels || [], value, event.target.checked),
                )
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      <Field
        label="Linha do WhatsApp para o QR do cupom"
        value={form.whatsapp_line_id || ""}
        onChange={set("whatsapp_line_id")}
        options={lines.map((l) => [
          l.id,
          `${l.name}${l.number ? " · " + l.number : ""}`,
        ])}
        emptyOption="Primeira linha com número"
      />
      <Field
        label="Aviso do atendimento preferencial"
        type="textarea"
        rows={3}
        maxLength={500}
        value={form.preferential_notice}
        onChange={set("preferential_notice")}
        help="Mostrado no WhatsApp e no totem quando o cliente escolhe o tipo de senha."
      />
      <label className="queue-switch">
        <Switch
          label="Fila ativa"
          checked={!!form.enabled}
          onChange={set("enabled")}
        />
        Fila ativa
      </label>
    </FormDialog>
  );
}

function CounterDialog({
  initial,
  queues,
  onClose,
  onSaved,
}: {
  initial: Row | null;
  queues: Row[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useApp();
  const [form, setForm] = useState<Row>(
    initial || { name: "", queue_ids: queues.map((q) => q.id), enabled: true },
  );
  return (
    <FormDialog
      title={initial ? `Editar ${initial.name}` : "Novo guichê"}
      onClose={onClose}
      onSubmit={async () => {
        await app.api(
          `${app.root}/queue/counters${initial ? "/" + initial.id : ""}`,
          initial ? "PUT" : "POST",
          { name: form.name, queue_ids: form.queue_ids, enabled: form.enabled },
        );
        toast("Guichê salvo.");
        onSaved();
        onClose();
      }}
    >
      <Field
        label="Nome (falado no painel)"
        value={form.name}
        onChange={(name) => setForm({ ...form, name })}
        placeholder="Guichê 1"
        required
        maxLength={40}
      />
      <fieldset className="queue-checks">
        <legend>Filas que este guichê atende</legend>
        {queues.map((q) => (
          <label key={q.id}>
            <input
              type="checkbox"
              checked={form.queue_ids.includes(q.id)}
              onChange={(event) =>
                setForm({
                  ...form,
                  queue_ids: toggled(
                    form.queue_ids,
                    q.id,
                    event.target.checked,
                  ),
                })
              }
            />
            {q.name}
          </label>
        ))}
      </fieldset>
      <label className="queue-switch">
        <Switch
          label="Guichê ativo"
          checked={!!form.enabled}
          onChange={(enabled) => setForm({ ...form, enabled })}
        />
        Guichê ativo
      </label>
    </FormDialog>
  );
}

function WhatsAppCard({
  settings,
  onSaved,
}: {
  settings: Row;
  onSaved: () => void;
}) {
  const app = useApp();
  const { busy, run } = useAction();
  const menus = useResource(`${app.root}/menus`);
  const [form, setForm] = useState<Row>({
    ...queueDefaults,
    ...(settings.queue || {}),
  });
  useEffect(
    () => setForm({ ...queueDefaults, ...(settings.queue || {}) }),
    [settings.queue],
  );
  const tree: Row[] = menus.data?.data || [];
  const hasQueueMenu = tree.some((m) => m.type === "queue" && !m.parent_id);
  const save = (patch: Row) =>
    run(() => app.api(`${app.root}/settings`, "PUT", { queue: patch }), {
      success: "Configuração salva.",
    }).then(onSaved);
  return (
    <Card
      title="Fila no WhatsApp"
      description="O cliente manda qualquer mensagem, recebe o menu e escolhe entrar na fila."
    >
      <div className="queue-settings-list">
        <label className="queue-switch">
          <Switch
            label="Qualquer mensagem abre o menu"
            checked={!!form.front_door}
            busy={busy}
            onChange={(front_door) => {
              setForm({ ...form, front_door });
              void save({ front_door });
            }}
          />
          <span>
            <strong>Qualquer mensagem abre o menu</strong>
            <small>
              A primeira mensagem de cada conversa (texto, áudio ou foto) recebe
              o menu principal, mesmo com bot atendente. Ela também abre a
              janela de 24 h do WhatsApp para enviar os avisos de graça.
            </small>
          </span>
        </label>
        {menus.loaded && !hasQueueMenu && (
          <Notice tone="warn">
            O menu principal ainda não tem a opção da fila.{" "}
            <button
              type="button"
              className="text-link"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    const next = [
                      {
                        id: "fila-senha",
                        label: "Entrar na fila",
                        type: "queue",
                        parent_id: null,
                      },
                      ...(tree.some((m) => m.type === "human" && !m.parent_id)
                        ? []
                        : [
                            {
                              id: "fila-atendente",
                              label: "Falar com atendente",
                              type: "human",
                              parent_id: null,
                            },
                          ]),
                      ...tree,
                    ];
                    await app.api(`${app.root}/settings`, "PUT", {
                      menus: next,
                      menus_revision: menus.data.revision,
                    });
                  },
                  { success: "Opções adicionadas ao menu principal." },
                ).then(() => menus.reload())
              }
            >
              Adicionar "Entrar na fila" e "Falar com atendente"
            </button>
          </Notice>
        )}
        <div className="queue-form-row">
          <Field
            label="Avisar quando faltar (senhas)"
            type="number"
            min={0}
            max={20}
            value={form.notify_ahead}
            onChange={(v) => setForm({ ...form, notify_ahead: v })}
            help="0 desliga o aviso. Só sai com a janela de 24 h aberta."
          />
          <Button
            secondary
            busy={busy}
            onClick={() =>
              void save({ notify_ahead: Number(form.notify_ahead) })
            }
          >
            Salvar
          </Button>
        </div>
        <p className="queue-hint">
          A chamada ("Senha N023, dirija-se ao Guichê 2") é enviada como texto
          dentro da janela de 24 h e como modelo aprovado fora dela (Regras de
          atendimento → Notificações). Edite o texto e a ordem do menu em{" "}
          <a
            className="text-link"
            {...linkProps({ area: "admin", page: "menus" })}
          >
            Menus e ações
          </a>
          .
        </p>
      </div>
    </Card>
  );
}

function AbuseCard({
  settings,
  onSaved,
}: {
  settings: Row;
  onSaved: () => void;
}) {
  const app = useApp();
  const { busy, run } = useAction();
  const list = useResource(`${app.root}/queue/blocklist`);
  const [form, setForm] = useState<Row>({
    ...queueDefaults,
    ...(settings.queue || {}),
  });
  const [adding, setAdding] = useState(false);
  useEffect(
    () => setForm({ ...queueDefaults, ...(settings.queue || {}) }),
    [settings.queue],
  );
  const num = (key: string) => (value: string) =>
    setForm({ ...form, [key]: value });
  const rows: Row[] = list.data?.data || [];
  return (
    <Card
      title="Lista negra e limites"
      description="Contra quem tira várias senhas e não comparece."
    >
      <div className="queue-form-grid">
        <Field
          label="Senhas por telefone por dia"
          type="number"
          min={1}
          max={50}
          value={form.max_daily_per_contact}
          onChange={num("max_daily_per_contact")}
        />
        <Field
          label="Ausências que bloqueiam"
          type="number"
          min={0}
          max={50}
          value={form.block_no_shows}
          onChange={num("block_no_shows")}
          help="0 desliga o bloqueio automático."
        />
        <Field
          label="…dentro de (dias)"
          type="number"
          min={1}
          max={365}
          value={form.block_window_days}
          onChange={num("block_window_days")}
        />
        <Field
          label="Dias de bloqueio"
          type="number"
          min={1}
          max={365}
          value={form.block_days}
          onChange={num("block_days")}
          help="Dobra a cada reincidência."
        />
        <Field
          label="Senhas por minuto em cada totem"
          type="number"
          min={1}
          max={120}
          value={form.kiosk_per_minute}
          onChange={num("kiosk_per_minute")}
        />
      </div>
      <div className="queue-settings-list">
        {[
          ["block_too_many", "Bloquear quem insiste depois do limite diário"],
          [
            "operators_can_block",
            "Atendentes podem bloquear (desbloquear é só do administrador)",
          ],
          ["blocked_can_talk", "Bloqueado ainda pode falar com atendente"],
        ].map(([key, label]) => (
          <label className="queue-switch" key={key}>
            <Switch
              label={label}
              checked={!!form[key]}
              onChange={(value) => setForm({ ...form, [key]: value })}
            />
            {label}
          </label>
        ))}
      </div>
      <div className="toolbar">
        <Button
          busy={busy}
          onClick={() =>
            void run(
              () =>
                app.api(`${app.root}/settings`, "PUT", {
                  queue: {
                    max_daily_per_contact: Number(form.max_daily_per_contact),
                    block_no_shows: Number(form.block_no_shows),
                    block_window_days: Number(form.block_window_days),
                    block_days: Number(form.block_days),
                    kiosk_per_minute: Number(form.kiosk_per_minute),
                    block_too_many: !!form.block_too_many,
                    operators_can_block: !!form.operators_can_block,
                    blocked_can_talk: !!form.blocked_can_talk,
                  },
                }),
              { success: "Limites salvos." },
            ).then(onSaved)
          }
        >
          Salvar limites
        </Button>
        <Button
          secondary
          icon={<Ban size={16} />}
          onClick={() => setAdding(true)}
        >
          Bloquear telefone
        </Button>
      </div>
      {!list.loaded ? (
        <SkeletonBlock height={80} />
      ) : (
        <Table
          rows={rows}
          columns={[
            ["phone", "Telefone"],
            [
              "reason",
              "Motivo",
              (r) =>
                r.reason === "auto_no_show"
                  ? "Ausências"
                  : r.reason === "auto_too_many"
                    ? "Excesso de pedidos"
                    : r.note || "Manual",
            ],
            ["no_shows", "Ausências", (r) => String(r.no_shows)],
            ["created", "Desde", (r) => date(r.created)],
            [
              "expires_at",
              "Até",
              (r) => (r.expires_at ? date(r.expires_at) : "Permanente"),
            ],
            [
              "active",
              "Estado",
              (r) =>
                r.active ? (
                  <Pill tone="danger">Bloqueado</Pill>
                ) : (
                  <Pill>Encerrado</Pill>
                ),
            ],
          ]}
          action={(r) =>
            r.active && app.isAdmin ? (
              <button
                type="button"
                className="text-link"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      app.api(`${app.root}/queue/blocklist/${r.id}`, "DELETE"),
                    {
                      success: "Desbloqueado.",
                    },
                  ).then(() => list.reload())
                }
              >
                Desbloquear
              </button>
            ) : null
          }
          empty={
            <Empty
              compact
              title="Ninguém bloqueado"
              description="Os bloqueios automáticos e manuais aparecem aqui."
            />
          }
        />
      )}
      {adding && (
        <BlockDialog
          defaultDays={Number(form.block_days) || 7}
          onClose={() => setAdding(false)}
          onSaved={() => void list.reload()}
        />
      )}
    </Card>
  );
}

function BlockDialog({
  defaultDays,
  onClose,
  onSaved,
}: {
  defaultDays: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useApp();
  const [form, setForm] = useState<Row>({
    phone: "",
    days: String(defaultDays),
    note: "",
  });
  return (
    <FormDialog
      title="Bloquear telefone"
      onClose={onClose}
      submitLabel="Bloquear"
      danger
      onSubmit={async () => {
        await app.api(`${app.root}/queue/blocklist`, "POST", {
          phone: form.phone,
          days: form.days === "" ? null : Number(form.days),
          note: form.note,
        });
        toast("Telefone bloqueado.");
        onSaved();
        onClose();
      }}
    >
      <Field
        label="Telefone com DDI e DDD"
        value={form.phone}
        onChange={(phone) => setForm({ ...form, phone })}
        placeholder="5511999998888"
        required
      />
      <Field
        label="Dias (vazio = permanente)"
        type="number"
        min={1}
        max={3650}
        value={form.days}
        onChange={(days) => setForm({ ...form, days })}
      />
      <Field
        label="Observação"
        value={form.note}
        onChange={(note) => setForm({ ...form, note })}
        maxLength={300}
      />
    </FormDialog>
  );
}

function DisplaysCard({ queues }: { queues: Row[] }) {
  const app = useApp();
  const { busy, run } = useAction();
  const list = useResource(app.isAdmin ? `${app.root}/queue/displays` : null);
  const [creating, setCreating] = useState(false),
    [created, setCreated] = useState<Row | null>(null),
    [form, setForm] = useState<Row>({ name: "", queue_ids: [] });
  const rows: Row[] = (list.data?.data || []).filter((d: Row) => !d.revoked);
  const url = created ? new URL(created.path, location.origin).href : "";
  return (
    <Card
      title="Painéis de TV e totens"
      description="Painel pelo navegador da TV, ou o app Senhapp para totem com impressão de cupom e painel híbrido."
      actions={
        <Button
          secondary
          icon={<Monitor size={16} />}
          onClick={() => setCreating(true)}
        >
          Novo painel de TV
        </Button>
      }
    >
      <Table
        rows={rows}
        columns={[
          ["name", "Painel"],
          [
            "queue_ids",
            "Filas",
            (d) =>
              d.queue_ids.length
                ? d.queue_ids
                    .map(
                      (id: string) =>
                        queues.find((q) => q.id === id)?.name || "—",
                    )
                    .join(", ")
                : "Todas",
          ],
          ["created", "Criado em", (d) => date(d.created)],
        ]}
        action={(d) => (
          <button
            type="button"
            className="text-link danger"
            disabled={busy}
            onClick={() =>
              void run(
                () => app.api(`${app.root}/queue/displays/${d.id}`, "DELETE"),
                { success: "Painel revogado." },
              ).then(() => list.reload())
            }
          >
            Revogar
          </button>
        )}
        empty={
          <Empty
            compact
            icon={<Monitor size={26} />}
            title="Nenhum painel de TV"
            description="Crie um link e abra no navegador da TV."
          />
        }
      />
      <p className="queue-hint">
        <strong>Senhapp (totem e painel híbrido):</strong> no aparelho, toque em
        Conectar ao Wabotia e informe o endereço desta instalação. Aprove o
        código em{" "}
        <a
          className="text-link"
          {...linkProps({ area: "admin", page: "applications" })}
        >
          Sistemas conectados
        </a>{" "}
        com as permissões da fila.
      </p>
      {creating && (
        <FormDialog
          title="Novo painel de TV"
          onClose={() => setCreating(false)}
          submitLabel="Criar link"
          onSubmit={async () => {
            const result = await app.api(
              `${app.root}/queue/displays`,
              "POST",
              form,
            );
            setCreated(result);
            setCreating(false);
            setForm({ name: "", queue_ids: [] });
            await list.reload();
          }}
        >
          <Field
            label="Nome"
            value={form.name}
            onChange={(name) => setForm({ ...form, name })}
            placeholder="TV da recepção"
            required
          />
          <fieldset className="queue-checks">
            <legend>Filas mostradas (nenhuma marcada = todas)</legend>
            {queues.map((q) => (
              <label key={q.id}>
                <input
                  type="checkbox"
                  checked={form.queue_ids.includes(q.id)}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      queue_ids: toggled(
                        form.queue_ids,
                        q.id,
                        event.target.checked,
                      ),
                    })
                  }
                />
                {q.name}
              </label>
            ))}
          </fieldset>
        </FormDialog>
      )}
      {created && (
        <Dialog
          title="Link do painel"
          onClose={() => setCreated(null)}
          footer={<Button onClick={() => setCreated(null)}>Pronto</Button>}
        >
          <p>
            Abra este endereço no navegador da TV. Ele aparece só agora; para
            trocar, revogue e crie outro.
          </p>
          <div className="secret-box">
            <code>{url}</code>
            <CopyButton value={url} />
          </div>
          <p>
            <a
              className="text-link"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              Abrir agora
            </a>
          </p>
        </Dialog>
      )}
    </Card>
  );
}

export function QueueSettingsPage() {
  const app = useApp();
  const overview = useResource(`${app.root}/queue`);
  const lines = useResource(app.isAdmin ? `${app.root}/lines` : null);
  const [editingQueue, setEditingQueue] = useState<Row | null | undefined>(
      undefined,
    ),
    [editingCounter, setEditingCounter] = useState<Row | null | undefined>(
      undefined,
    );
  if (!app.isAdmin)
    return <Notice>Somente administradores configuram as filas.</Notice>;
  if (overview.error)
    return (
      <Notice tone="error" onRetry={() => void overview.reload()}>
        {overview.error}
      </Notice>
    );
  if (!overview.loaded) return <SkeletonBlock height={240} />;
  const queues: Row[] = overview.data.queues;
  const counters: Row[] = overview.data.counters;
  const reload = () => {
    void overview.reload();
    void app.refresh().catch(() => {});
  };
  return (
    <div className="queue-settings">
      <Card
        title="Filas"
        description="Cada fila numera senhas normais e preferenciais separadamente, recomeçando todo dia."
        actions={
          <Button
            icon={<Plus size={16} />}
            onClick={() => setEditingQueue(null)}
          >
            Nova fila
          </Button>
        }
      >
        <Table
          rows={queues}
          columns={[
            ["name", "Fila"],
            [
              "prefix_normal",
              "Senhas",
              (q) => `${q.prefix_normal}001 · ${q.prefix_preferential}001`,
            ],
            [
              "normals_per_preferential",
              "Normais por preferencial",
              (q) => String(q.normals_per_preferential),
            ],
            [
              "wait_mode",
              "Tempo de espera",
              (q) =>
                q.wait_mode === "fixed"
                  ? `Fixo · ${q.service_minutes} min`
                  : `Média real · padrão ${q.service_minutes} min`,
            ],
            [
              "channels",
              "Canais",
              (q) =>
                q.channels
                  .map((c: string) => (c === "kiosk" ? "Totem" : "WhatsApp"))
                  .join(", ") || "—",
            ],
            [
              "enabled",
              "Estado",
              (q) =>
                q.enabled ? (
                  <Pill tone="ok">Ativa</Pill>
                ) : (
                  <Pill>Desativada</Pill>
                ),
            ],
          ]}
          action={(q) => (
            <button
              type="button"
              className="text-link"
              onClick={() => setEditingQueue(q)}
            >
              Editar
            </button>
          )}
          empty={
            <Empty
              compact
              icon={<Ticket size={26} />}
              title="Nenhuma fila"
              description="Crie a primeira fila, por exemplo Atendimento geral."
            />
          }
        />
      </Card>
      <Card
        title="Guichês"
        description="A equipe escolhe o guichê na área Fila e chama a próxima senha das filas dele."
        actions={
          <Button
            secondary
            icon={<Plus size={16} />}
            disabled={!queues.length}
            onClick={() => setEditingCounter(null)}
          >
            Novo guichê
          </Button>
        }
      >
        <Table
          rows={counters}
          columns={[
            ["name", "Guichê"],
            [
              "queue_ids",
              "Filas",
              (c) =>
                c.queue_ids
                  .map(
                    (id: string) =>
                      queues.find((q) => q.id === id)?.name || "—",
                  )
                  .join(", ") || "—",
            ],
            [
              "status",
              "Agora",
              (c) =>
                c.status === "open" ? (
                  <Pill tone="ok">Aberto</Pill>
                ) : c.status === "paused" ? (
                  <Pill tone="warn">Pausado</Pill>
                ) : (
                  <Pill>Fechado</Pill>
                ),
            ],
            ["user_name", "Atendente", (c) => c.user_name || "—"],
          ]}
          action={(c) => (
            <button
              type="button"
              className="text-link"
              onClick={() => setEditingCounter(c)}
            >
              Editar
            </button>
          )}
          empty={
            <Empty
              compact
              title="Nenhum guichê"
              description="Crie os guichês que vão chamar senhas."
            />
          }
        />
      </Card>
      <WhatsAppCard settings={app.settings} onSaved={reload} />
      <DisplaysCard queues={queues} />
      <AbuseCard settings={app.settings} onSaved={reload} />
      {editingQueue !== undefined && (
        <QueueDialog
          initial={editingQueue}
          lines={lines.data?.data || []}
          onClose={() => setEditingQueue(undefined)}
          onSaved={reload}
        />
      )}
      {editingCounter !== undefined && (
        <CounterDialog
          initial={editingCounter}
          queues={queues}
          onClose={() => setEditingCounter(undefined)}
          onSaved={reload}
        />
      )}
    </div>
  );
}
