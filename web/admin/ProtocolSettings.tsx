// Regras de atendimento → Protocolos (docs/CENTRAL-ATENDIMENTO.md §1, §3, §4):
// unidade do prazo, dias e horário de atendimento, feriados, categorias e a
// mensagem de confirmação com prévia calculada.
import React, { useMemo, useRef, useState } from "react";
import { CalendarClock, Plus, RotateCcw, Trash2, X } from "lucide-react";
import type { Row } from "../lib/api";
import { Button, Notice, Segmented, Switch } from "../ui";
// Regras puras do servidor (sem acesso a banco): a prévia usa o mesmo cálculo.
import {
  businessHours,
  formatBrasilia,
  protocolDueAt,
} from "../../src/business-time";
import {
  defaultProtocolConfirmation,
  renderProtocolConfirmation,
} from "../../src/protocols";

const weekdays = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const weekdayNames = [
  "Domingo",
  "Segunda-feira",
  "Terça-feira",
  "Quarta-feira",
  "Quinta-feira",
  "Sexta-feira",
  "Sábado",
];
const markers = [
  ["{numero}", "Número do protocolo"],
  ["{assunto}", "Assunto informado"],
  ["{aplicativo}", "Categoria (aplicativo)"],
  ["{prazo}", "Prazo da primeira resposta"],
];
const MAX_CATEGORIES = 50,
  MAX_HOLIDAYS = 100,
  MAX_CONFIRMATION = 1500;

/** Identificador a partir do nome: minúsculas, sem acentos, [a-z0-9-]. */
export function categoryId(name: string, taken: string[]) {
  const base =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "categoria";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

const holidayLabel = (value: string) => {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
};

/** Problemas que o servidor recusaria; mostrados antes de salvar. */
export function protocolProblems(values: Row): string[] {
  const problems: string[] = [];
  const hours = values.business_hours ?? businessHours(null);
  if (values.protocol_response_unit === "business_days") {
    const days = Number(values.protocol_response_days);
    if (!Number.isInteger(days) || days < 1 || days > 60)
      problems.push("Informe o prazo em dias úteis, de 1 a 60.");
  }
  if (!(hours.days || []).length)
    problems.push("Escolha pelo menos um dia de atendimento.");
  if (!hours.start || !hours.end || hours.start >= hours.end)
    problems.push("O fim do horário de atendimento precisa ser depois do início.");
  if ((values.ticket_categories || []).some((item: Row) => !item.name?.trim()))
    problems.push("Dê um nome a cada categoria ou remova as vazias.");
  if (String(values.protocol_confirmation || "").length > MAX_CONFIRMATION)
    problems.push("A confirmação do protocolo deve ter até 1500 caracteres.");
  return problems;
}

export function ProtocolSettings({
  values,
  edit,
}: {
  /** Configurações já com as alterações não salvas aplicadas. */
  values: Row;
  edit: (patch: Row) => void;
}) {
  const unit: "hours" | "business_days" =
    values.protocol_response_unit === "business_days"
      ? "business_days"
      : "hours";
  const hours = useMemo(
    () => ({
      ...businessHours(values.business_hours),
      // Durante a edição o horário pode ficar momentaneamente inválido.
      ...(values.business_hours || {}),
    }),
    [values.business_hours],
  );
  const categories: Row[] = values.ticket_categories || [];
  const confirmation: string =
    values.protocol_confirmation ?? defaultProtocolConfirmation;
  const [holiday, setHoliday] = useState(""),
    [newCategory, setNewCategory] = useState("");
  const message = useRef<HTMLTextAreaElement>(null);

  const editHours = (patch: Row) =>
    edit({ business_hours: { ...hours, ...patch } });
  const editCategories = (next: Row[]) => edit({ ticket_categories: next });

  function addHoliday() {
    if (!holiday || hours.holidays.includes(holiday)) return;
    editHours({ holidays: [...hours.holidays, holiday].sort() });
    setHoliday("");
  }
  function addCategory() {
    const name = newCategory.trim();
    if (!name || categories.length >= MAX_CATEGORIES) return;
    editCategories([
      ...categories,
      {
        id: categoryId(
          name,
          categories.map((item) => item.id),
        ),
        name,
        enabled: true,
      },
    ]);
    setNewCategory("");
  }
  function insertMarker(marker: string) {
    const area = message.current;
    const start = area?.selectionStart ?? confirmation.length,
      end = area?.selectionEnd ?? confirmation.length;
    const next = confirmation.slice(0, start) + marker + confirmation.slice(end);
    if (next.length > MAX_CONFIRMATION) return;
    edit({ protocol_confirmation: next });
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(start + marker.length, start + marker.length);
    });
  }

  // Prévia: protocolo aberto agora, com a configuração em edição.
  const preview = useMemo(() => {
    const now = Date.now();
    const due = protocolDueAt(now, { ...values, business_hours: hours });
    const category = categories.find((item) => item.enabled !== false);
    return {
      due,
      text: renderProtocolConfirmation(confirmation, {
        numero: "WA-EXEMPLO-1A2B",
        assunto: "Nota fiscal não foi emitida",
        aplicativo: category?.name || "",
        prazo: due ? formatBrasilia(due) : "",
      }),
      category: category?.name || "",
    };
  }, [values, hours, categories, confirmation]);

  return (
    <section className="card protocol-settings" id="protocolos">
      <div className="card-heading">
        <div>
          <h2>Protocolos</h2>
          <p>
            Prazo da primeira resposta humana, categorias e a mensagem que o
            cliente recebe ao abrir um protocolo.
          </p>
        </div>
      </div>

      <h3>Prazo da primeira resposta</h3>
      <div className="protocol-deadline">
        <Segmented
          label="Unidade do prazo"
          value={unit}
          onChange={(next) => edit({ protocol_response_unit: next })}
          options={[
            { value: "hours", label: "Horas" },
            { value: "business_days", label: "Dias úteis" },
          ]}
        />
        {unit === "hours" ? (
          <label className="field">
            <span>Prazo em horas</span>
            <input
              type="number"
              min={1}
              value={values.protocol_response_hours ?? ""}
              placeholder="Sem prazo"
              onChange={(event) =>
                edit({
                  protocol_response_hours:
                    event.target.value === ""
                      ? null
                      : Number(event.target.value),
                })
              }
            />
            <small>
              Horas corridas a partir da abertura. Em branco: sem prazo.
            </small>
          </label>
        ) : (
          <label className="field">
            <span>Prazo em dias úteis</span>
            <input
              type="number"
              min={1}
              max={60}
              value={values.protocol_response_days ?? 3}
              onChange={(event) =>
                edit({
                  protocol_response_days:
                    event.target.value === ""
                      ? ""
                      : Number(event.target.value),
                })
              }
            />
            <small>
              De 1 a 60. Conta só os dias de atendimento abaixo, no horário de
              Brasília; feriados não contam.
            </small>
          </label>
        )}
      </div>
      <p className="protocol-due" role="status">
        <CalendarClock size={16} aria-hidden />
        {preview.due ? (
          <span>
            Aberto agora, venceria em{" "}
            <strong>{formatBrasilia(preview.due)}</strong> (horário de
            Brasília).
          </span>
        ) : (
          <span>Aberto agora, o protocolo ficaria sem prazo.</span>
        )}
      </p>

      <h3>Dias e horário de atendimento</h3>
      <p className="muted protocol-help">
        Usados para contar o prazo em dias úteis. Alterar não recalcula
        protocolos já abertos.
      </p>
      <div className="weekday-row" role="group" aria-label="Dias de atendimento">
        {weekdays.map((label, day) => (
          <label
            key={day}
            className={
              "weekday" + (hours.days.includes(day) ? " checked" : "")
            }
            title={weekdayNames[day]}
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={hours.days.includes(day)}
              aria-label={weekdayNames[day]}
              onChange={(event) =>
                editHours({
                  days: event.target.checked
                    ? [...hours.days, day].sort((a, b) => a - b)
                    : hours.days.filter((item: number) => item !== day),
                })
              }
            />
            {label}
          </label>
        ))}
      </div>
      <div className="protocol-hours">
        <label className="field">
          <span>Início</span>
          <input
            type="time"
            value={hours.start}
            onChange={(event) => editHours({ start: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Fim</span>
          <input
            type="time"
            value={hours.end}
            onChange={(event) => editHours({ end: event.target.value })}
          />
        </label>
      </div>
      <div className="field">
        <span>Feriados e dias sem atendimento</span>
        <div className="inline-add">
          <input
            type="date"
            aria-label="Data do feriado"
            value={holiday}
            onChange={(event) => setHoliday(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addHoliday();
              }
            }}
          />
          <Button
            secondary
            icon={<Plus size={16} />}
            disabled={
              !holiday ||
              hours.holidays.includes(holiday) ||
              hours.holidays.length >= MAX_HOLIDAYS
            }
            onClick={addHoliday}
          >
            Adicionar
          </Button>
        </div>
        {hours.holidays.length ? (
          <ul className="holiday-list" aria-label="Feriados cadastrados">
            {hours.holidays.map((value: string) => (
              <li key={value}>
                {holidayLabel(value)}
                <button
                  type="button"
                  aria-label={"Remover feriado " + holidayLabel(value)}
                  onClick={() =>
                    editHours({
                      holidays: hours.holidays.filter(
                        (item: string) => item !== value,
                      ),
                    })
                  }
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <small>Nenhum feriado cadastrado. Até {MAX_HOLIDAYS} datas.</small>
        )}
      </div>

      <h3>Categorias</h3>
      <p className="muted protocol-help">
        Identificam o aplicativo ou o assunto do protocolo. O cliente vê
        “Aplicativo: nome” na consulta. Remover uma categoria não altera
        protocolos antigos.
      </p>
      {categories.length > 0 && (
        <ul className="category-list">
          {categories.map((category, index) => (
            <li key={category.id}>
              <input
                aria-label={"Nome da categoria " + (category.name || category.id)}
                value={category.name}
                maxLength={100}
                onChange={(event) =>
                  editCategories(
                    categories.map((item, at) =>
                      at === index ? { ...item, name: event.target.value } : item,
                    ),
                  )
                }
              />
              <code title="Identificador gravado nos protocolos">
                {category.id}
              </code>
              <Switch
                label={
                  (category.enabled !== false ? "Desabilitar " : "Habilitar ") +
                  (category.name || category.id)
                }
                checked={category.enabled !== false}
                onChange={(enabled) =>
                  editCategories(
                    categories.map((item, at) =>
                      at === index ? { ...item, enabled } : item,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="icon-button sm danger"
                aria-label={"Remover categoria " + (category.name || category.id)}
                title="Remover"
                onClick={() =>
                  editCategories(categories.filter((_, at) => at !== index))
                }
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="inline-add">
        <input
          aria-label="Nome da nova categoria"
          placeholder="Nova categoria (ex.: Printher)"
          value={newCategory}
          maxLength={100}
          onChange={(event) => setNewCategory(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addCategory();
            }
          }}
        />
        <Button
          secondary
          icon={<Plus size={16} />}
          disabled={!newCategory.trim() || categories.length >= MAX_CATEGORIES}
          onClick={addCategory}
        >
          Adicionar
        </Button>
      </div>
      <small className="muted">
        {categories.length} de {MAX_CATEGORIES} categorias. Uma categoria usada
        por um destino “Abrir protocolo” do menu precisa sair do menu antes de
        ser removida.
      </small>

      <h3>Mensagem de confirmação</h3>
      <p className="muted protocol-help">
        Enviada quando um protocolo é aberto para o cliente (equipe ausente,
        destino de menu “Abrir protocolo”, palavra PROTOCOLO ou ação do bot).
        Protocolos abertos pela equipe não enviam confirmação.
      </p>
      <div className="confirmation-grid">
        <div>
          <div className="marker-row" role="group" aria-label="Inserir marcador">
            {markers.map(([marker, hint]) => (
              <button
                type="button"
                className="chip"
                key={marker}
                title={"Inserir " + hint.toLowerCase()}
                onClick={() => insertMarker(marker)}
              >
                <code>{marker}</code>
              </button>
            ))}
          </div>
          <textarea
            ref={message}
            aria-label="Mensagem de confirmação do protocolo"
            rows={12}
            maxLength={MAX_CONFIRMATION}
            value={confirmation}
            onChange={(event) =>
              edit({ protocol_confirmation: event.target.value })
            }
          />
          <div className="field-foot">
            <button
              type="button"
              className="text-link"
              disabled={confirmation === defaultProtocolConfirmation}
              onClick={() =>
                edit({ protocol_confirmation: defaultProtocolConfirmation })
              }
            >
              <RotateCcw size={14} /> Restaurar padrão
            </button>
            <span className="muted" aria-live="polite">
              {confirmation.length} / {MAX_CONFIRMATION}
            </span>
          </div>
        </div>
        <div className="confirmation-preview" aria-label="Prévia da confirmação">
          <span className="preview-label">Prévia · aberto agora</span>
          <div className="preview-bubble">{preview.text}</div>
          <small className="muted">
            Linhas cujo marcador não tem valor são omitidas inteiras
            {preview.category
              ? ""
              : " (sem categorias, a linha de aplicativo não aparece)"}
            {preview.due ? "" : " (sem prazo, a linha do prazo não aparece)"}.
          </small>
        </div>
      </div>
      {!confirmation.trim() && (
        <Notice tone="warn">
          Em branco, o servidor volta a usar a mensagem padrão.
        </Notice>
      )}
    </section>
  );
}
