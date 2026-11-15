// Gestão → Unidades e regras (módulo "reserva"): unidades reserváveis,
// bloqueios de datas e as regras da área (chave "reserva" de PUT /settings).
import React, { useEffect, useState } from "react";
import { BedDouble, Pencil, Plus, Trash2 } from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import { useIntents, type Row } from "../../lib/api";
import { FormDialog, useResource } from "../../admin/shared";
import {
  Button,
  Confirm,
  Empty,
  Field,
  IconButton,
  Notice,
  Pill,
  SkeletonRows,
  Switch,
} from "../../ui";
import {
  addDays,
  brDate,
  cents,
  dayLabel,
  kindLabel,
  KINDS,
  money,
  reais,
  type Overview,
} from "./model";
import "./reserva.css";

function UnitDialog({
  unit,
  onClose,
  onDone,
}: {
  unit: Row | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const [form, setForm] = useState({
    name: unit?.name || "",
    kind: unit?.kind || "room",
    mode: unit?.mode || "daily",
    capacity: String(unit?.capacity ?? 2),
    price: reais(unit?.price_cents ?? null),
    description: unit?.description || "",
    photos: (unit?.photos || []).join("\n"),
    active: unit?.active ?? true,
  });
  const set = (key: keyof typeof form) => (value: any) =>
    setForm((f) => ({ ...f, [key]: value }));
  return (
    <FormDialog
      title={unit ? `Editar ${unit.name}` : "Nova unidade"}
      onClose={onClose}
      onSubmit={async () => {
        const body = {
          name: form.name.trim(),
          kind: form.kind,
          mode: form.mode,
          capacity: Number(form.capacity) || 1,
          price_cents: cents(form.price) ?? 0,
          description: form.description.trim(),
          photos: form.photos
            .split(/\s+/)
            .map((p: string) => p.trim())
            .filter(Boolean),
          active: form.active,
        };
        await write(
          unit
            ? `${app.root}/reserva/units/${unit.id}`
            : `${app.root}/reserva/units`,
          unit ? "PUT" : "POST",
          body,
        );
        onDone();
      }}
    >
      <div className="reserva-grid">
        <Field
          label="Nome"
          value={form.name}
          onChange={set("name")}
          maxLength={80}
          required
        />
        <Field
          label="Tipo"
          value={form.kind}
          onChange={set("kind")}
          options={KINDS}
          emptyOption={null}
        />
        <Field
          label="Modo de reserva"
          value={form.mode}
          onChange={set("mode")}
          options={[
            ["daily", "Por diária (entrada e saída em dias)"],
            ["hourly", "Por hora (início e duração)"],
          ]}
          emptyOption={null}
          help={
            unit ? "Mudar o modo não altera as reservas já feitas." : undefined
          }
        />
        <Field
          label={
            form.mode === "daily"
              ? "Preço da diária (R$)"
              : "Preço da hora (R$)"
          }
          value={form.price}
          onChange={set("price")}
          placeholder="300,00"
          required
        />
        <Field
          label="Capacidade (pessoas)"
          type="number"
          min={1}
          max={1000}
          value={form.capacity}
          onChange={set("capacity")}
          required
        />
      </div>
      <Field
        label="Descrição"
        type="textarea"
        rows={2}
        value={form.description}
        onChange={set("description")}
        maxLength={600}
      />
      <Field
        label="Fotos (opcional)"
        type="textarea"
        rows={2}
        value={form.photos}
        onChange={set("photos")}
        help="Endereços https:// das fotos, um por linha (até 6). Aparecem no painel e nos aplicativos."
      />
      <div className="reserva-switch">
        <Switch
          checked={form.active}
          onChange={set("active")}
          label="Disponível para reserva"
        />
        <span>Disponível para reserva pelo WhatsApp.</span>
      </div>
    </FormDialog>
  );
}

function BlockDialog({
  units,
  onClose,
  onDone,
}: {
  units: Row[];
  onClose: () => void;
  onDone: () => void;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const today = brDate(Date.now());
  const [unit, setUnit] = useState("");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [reason, setReason] = useState("");
  return (
    <FormDialog
      title="Bloquear datas"
      subtitle="Ninguém reserva nesses dias. Reservas já feitas não mudam."
      onClose={onClose}
      onSubmit={async () => {
        await write(`${app.root}/reserva/blocks`, "POST", {
          unit_id: unit || null,
          from_date: from,
          to_date: to,
          reason: reason.trim(),
        });
        onDone();
      }}
    >
      <Field
        label="Unidade"
        value={unit}
        onChange={setUnit}
        options={units.map((u) => ({ id: u.id, name: u.name }))}
        emptyOption="Todas (a casa fecha)"
      />
      <div className="reserva-grid">
        <Field
          label="De"
          type="date"
          value={from}
          onChange={(v) => {
            setFrom(v);
            if (v > to) setTo(v);
          }}
          required
        />
        <Field
          label="Até (inclusive)"
          type="date"
          value={to}
          min={from}
          onChange={setTo}
          required
        />
      </div>
      <Field
        label="Motivo"
        value={reason}
        onChange={setReason}
        placeholder="Manutenção, uso próprio…"
        maxLength={200}
      />
    </FormDialog>
  );
}

const number = (value: string) => (value === "" ? NaN : Number(value));

function RulesCard({
  overview,
  onSaved,
}: {
  overview: Overview;
  onSaved: () => void;
}) {
  const app = useApp();
  const { busy, run } = useAction();
  const [form, setForm] = useState<Row>(overview.config);
  const [questions, setQuestions] = useState(
    (overview.config.checkin_questions || []).join("\n"),
  );
  useEffect(() => {
    setForm(overview.config);
    setQuestions((overview.config.checkin_questions || []).join("\n"));
  }, [JSON.stringify(overview.config)]);
  const set = (key: string) => (value: any) =>
    setForm((f) => ({ ...f, [key]: value }));
  const int = (key: string) => (value: string) => set(key)(number(value));
  const field = (key: string, value: boolean) =>
    setForm((f) => ({
      ...f,
      checkin_fields: { ...f.checkin_fields, [key]: value },
    }));
  const deposit = overview.deposit;
  return (
    <section className="card reserva-rules">
      <h2>Regras da reserva</h2>
      <h3>Datas e horários</h3>
      <div className="reserva-grid">
        <Field
          label="Antecedência mínima (horas)"
          type="number"
          min={0}
          max={720}
          value={form.min_notice_hours}
          onChange={int("min_notice_hours")}
        />
        <Field
          label="Reservas com até (dias de antecedência)"
          type="number"
          min={1}
          max={730}
          value={form.max_days_ahead}
          onChange={int("max_days_ahead")}
        />
        <Field
          label="Estadia mínima (diárias)"
          type="number"
          min={1}
          max={60}
          value={form.min_nights}
          onChange={int("min_nights")}
        />
        <Field
          label="Estadia máxima pelo WhatsApp (diárias)"
          type="number"
          min={1}
          max={90}
          value={form.max_nights}
          onChange={int("max_nights")}
        />
        <Field
          label="Entrada a partir das"
          type="time"
          value={form.checkin_time}
          onChange={set("checkin_time")}
        />
        <Field
          label="Saída até as"
          type="time"
          value={form.checkout_time}
          onChange={set("checkout_time")}
        />
        <Field
          label="Unidades por hora abrem às"
          type="time"
          value={form.hourly_open}
          onChange={set("hourly_open")}
        />
        <Field
          label="E fecham às"
          value={form.hourly_close}
          onChange={set("hourly_close")}
          placeholder="22:00 ou 24:00"
        />
        <Field
          label="Horários a cada (minutos)"
          type="number"
          min={15}
          max={240}
          value={form.hourly_step_minutes}
          onChange={int("hourly_step_minutes")}
        />
        <Field
          label="Duração mínima (horas)"
          type="number"
          min={1}
          max={24}
          value={form.min_hours}
          onChange={int("min_hours")}
        />
        <Field
          label="Duração máxima (horas)"
          type="number"
          min={1}
          max={24}
          value={form.max_hours}
          onChange={int("max_hours")}
        />
      </div>

      <h3>Sinal</h3>
      {form.deposit_type !== "none" && !deposit.available && (
        <Notice tone="warn">{deposit.message}</Notice>
      )}
      <div className="reserva-grid">
        <Field
          label="Sinal para garantir a reserva"
          value={form.deposit_type}
          onChange={set("deposit_type")}
          options={[
            ["none", "Sem sinal"],
            ["percent", "Percentual do total"],
            ["fixed", "Valor fixo"],
          ]}
          emptyOption={null}
        />
        {form.deposit_type === "percent" && (
          <Field
            label="Percentual (%)"
            type="number"
            min={1}
            max={100}
            value={form.deposit_percent}
            onChange={int("deposit_percent")}
          />
        )}
        {form.deposit_type === "fixed" && (
          <Field
            label="Valor (R$)"
            value={reais(form.deposit_cents)}
            onChange={(v) => set("deposit_cents")(cents(v) ?? 0)}
          />
        )}
        {form.deposit_type !== "none" && (
          <>
            <Field
              label="Forma"
              value={form.deposit_method}
              onChange={set("deposit_method")}
              options={[
                ["pix", "Pix"],
                ["link", "Link de pagamento (cartão, Pix e outros)"],
              ]}
              emptyOption={null}
            />
            <Field
              label="Prazo para pagar (minutos)"
              type="number"
              min={30}
              max={10080}
              value={form.deposit_deadline_minutes}
              onChange={int("deposit_deadline_minutes")}
              help="A unidade fica segura até o prazo; depois, é liberada."
            />
          </>
        )}
      </div>

      <h3>Cancelamento</h3>
      <Field
        label="Política de cancelamento (mostrada ao cliente)"
        type="textarea"
        rows={3}
        value={form.cancellation_policy}
        onChange={set("cancellation_policy")}
        maxLength={1500}
        placeholder="Ex.: cancelamento grátis até 7 dias antes; depois disso, o sinal não é devolvido."
      />
      <Field
        label="O cliente cancela pelo WhatsApp até (horas antes da entrada)"
        type="number"
        min={0}
        max={720}
        value={form.customer_cancel_hours}
        onChange={int("customer_cancel_hours")}
        help="Depois disso, só a equipe cancela. A devolução do sinal é feita no painel do Mercado Pago."
      />

      <h3>Check-in online</h3>
      <div className="reserva-switch">
        <Switch
          checked={!!form.checkin_enabled}
          onChange={set("checkin_enabled")}
          label="Check-in online"
        />
        <span>Enviar o link do check-in antes da entrada.</span>
      </div>
      {form.checkin_enabled && (
        <>
          <Field
            label="Enviar (horas antes da entrada)"
            type="number"
            min={1}
            max={336}
            value={form.checkin_hours_before}
            onChange={int("checkin_hours_before")}
          />
          <div className="reserva-checks">
            {[
              ["document", "Documento"],
              ["companions", "Acompanhantes"],
              ["arrival_time", "Horário previsto de chegada"],
              ["rules", "Aceite das regras da casa"],
            ].map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={!!form.checkin_fields?.[key]}
                  onChange={(e) => field(key, e.target.checked)}
                />
                {label}
              </label>
            ))}
          </div>
          <Field
            label="Perguntas a mais (uma por linha, até 5)"
            type="textarea"
            rows={2}
            value={questions}
            onChange={setQuestions}
            placeholder="Placa do carro"
          />
          <Field
            label="Regras da casa"
            type="textarea"
            rows={3}
            value={form.house_rules}
            onChange={set("house_rules")}
            maxLength={1400}
          />
        </>
      )}

      <h3>Lembrete e saída</h3>
      <div className="reserva-grid">
        <Field
          label="Lembrete (horas antes da entrada; 0 desliga)"
          type="number"
          min={0}
          max={168}
          value={form.reminder_hours}
          onChange={int("reminder_hours")}
        />
        <Field
          label="Mensagem de saída (minutos antes)"
          type="number"
          min={0}
          max={1440}
          value={form.checkout_minutes_before}
          onChange={int("checkout_minutes_before")}
        />
      </div>
      <div className="reserva-switch">
        <Switch
          checked={!!form.checkout_message}
          onChange={set("checkout_message")}
          label="Mensagem de saída"
        />
        <span>Enviar a mensagem de saída.</span>
      </div>

      <details className="reserva-texts">
        <summary>Textos enviados ao cliente</summary>
        <p className="muted">
          Marcadores:{" "}
          {
            "{numero} {unidade} {entrada} {saida} {nome} {valor} {sinal} {prazo}"
          }
          .
        </p>
        {[
          ["intro_text", "Abertura"],
          ["confirmed_text", "Reserva confirmada"],
          ["pending_text", "Aguardando o sinal"],
          ["expired_text", "Sinal vencido"],
          ["cancelled_text", "Cancelamento"],
          ["reminder_text", "Lembrete"],
          ["checkout_text", "Saída"],
        ].map(([key, label]) => (
          <Field
            key={key}
            label={label}
            type="textarea"
            rows={2}
            value={form[key]}
            onChange={set(key)}
            maxLength={900}
          />
        ))}
      </details>

      <div className="card-actions">
        <Button
          busy={busy}
          onClick={() =>
            run(
              async () => {
                await app.api(app.root + "/settings", "PUT", {
                  reserva: {
                    ...form,
                    checkin_questions: questions
                      .split("\n")
                      .map((q: string) => q.trim())
                      .filter(Boolean),
                  },
                });
                onSaved();
              },
              { success: "Regras salvas." },
            )
          }
        >
          Salvar regras
        </Button>
      </div>
    </section>
  );
}

export function ReservaSettingsPage() {
  const app = useApp();
  const write = useIntents(app.api);
  const { busy, run } = useAction();
  const overview = useResource(app.root + "/reserva");
  const data = overview.data as Overview | null;
  const today = brDate(Date.now());
  const blocks = useResource(
    `${app.root}/reserva/blocks?from_date=${today}&to_date=${addDays(today, 92)}`,
  );
  const [unit, setUnit] = useState<Row | null | undefined>(undefined);
  const [blocking, setBlocking] = useState(false);
  const [removing, setRemoving] = useState<Row | null>(null);
  if (!data) return <SkeletonRows />;
  const name = (id: string | null) =>
    id
      ? data.units.find((u) => u.id === id)?.name || "Unidade excluída"
      : "Todas";
  return (
    <>
      <section className="card">
        <div className="toolbar">
          <h2>Unidades</h2>
          <Button icon={<Plus size={17} />} onClick={() => setUnit(null)}>
            Nova unidade
          </Button>
        </div>
        {!data.units.length ? (
          <Empty
            compact
            icon={<BedDouble size={24} />}
            title="Nenhuma unidade"
            description="Cadastre quartos, chalés, quadras ou salões. Depois, ponha Fazer reserva e Minhas reservas no menu do WhatsApp (Menus e ações)."
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Unidade</th>
                  <th>Modo</th>
                  <th>Capacidade</th>
                  <th>Preço</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.units.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.name}</strong>{" "}
                      <small className="muted">{kindLabel(u.kind)}</small>
                      {!u.active && <Pill tone="muted">Inativa</Pill>}
                    </td>
                    <td>{u.mode === "daily" ? "Diária" : "Por hora"}</td>
                    <td>{u.capacity}</td>
                    <td>
                      {money(u.price_cents)}{" "}
                      {u.mode === "daily" ? "/ diária" : "/ hora"}
                    </td>
                    <td className="table-actions">
                      <div className="card-actions">
                        <IconButton
                          size="sm"
                          label="Editar"
                          onClick={() => setUnit(u)}
                        >
                          <Pencil size={16} />
                        </IconButton>
                        <IconButton
                          size="sm"
                          label="Excluir"
                          tone="danger"
                          disabled={busy}
                          onClick={() =>
                            run(
                              async () => {
                                await write(
                                  `${app.root}/reserva/units/${u.id}`,
                                  "DELETE",
                                  {},
                                );
                                await overview.reload();
                              },
                              { success: "Unidade excluída." },
                            )
                          }
                        >
                          <Trash2 size={16} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="toolbar">
          <h2>Bloqueios de datas</h2>
          <Button
            secondary
            icon={<Plus size={17} />}
            onClick={() => setBlocking(true)}
            disabled={!data.units.length}
          >
            Bloquear datas
          </Button>
        </div>
        {!blocks.data ? (
          <SkeletonRows />
        ) : !blocks.data.data.length ? (
          <p className="muted">Nenhum bloqueio nos próximos três meses.</p>
        ) : (
          <table>
            <tbody>
              {blocks.data.data.map((b: Row) => (
                <tr key={b.id}>
                  <td>
                    {dayLabel(b.from_date)}
                    {b.to_date !== b.from_date
                      ? ` a ${dayLabel(b.to_date)}`
                      : ""}
                  </td>
                  <td>{name(b.unit_id)}</td>
                  <td className="muted">{b.reason}</td>
                  <td className="table-actions">
                    <IconButton
                      size="sm"
                      label="Remover bloqueio"
                      tone="danger"
                      onClick={() => setRemoving(b)}
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <RulesCard overview={data} onSaved={() => void overview.reload()} />

      {unit !== undefined && (
        <UnitDialog
          unit={unit}
          onClose={() => setUnit(undefined)}
          onDone={() => {
            setUnit(undefined);
            void overview.reload();
          }}
        />
      )}
      {blocking && (
        <BlockDialog
          units={data.units}
          onClose={() => setBlocking(false)}
          onDone={() => {
            setBlocking(false);
            void blocks.reload();
          }}
        />
      )}
      {removing && (
        <Confirm
          title="Remover o bloqueio?"
          confirmLabel="Remover"
          danger
          busy={busy}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            run(
              async () => {
                await write(
                  `${app.root}/reserva/blocks/${removing.id}`,
                  "DELETE",
                  {},
                );
                setRemoving(null);
                await blocks.reload();
              },
              { success: "Bloqueio removido." },
            )
          }
        >
          As datas voltam a aceitar reservas.
        </Confirm>
      )}
    </>
  );
}
