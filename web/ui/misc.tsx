import React from "react";
import { date } from "../lib/format";
import type { Row } from "../lib/api";
import { Pill, type PillTone } from "./controls";
import { Empty } from "./feedback";

/** Símbolo do aplicativo: balão sobre o degradê da marca. */
export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <span
      className="brand-mark"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" width={Math.round(size * 0.62)} height={Math.round(size * 0.62)}>
        <path
          d="M12 3.2c-5 0-9 3.6-9 8.1 0 1.9.7 3.6 1.9 5L4 20.8l4.3-1.5c1.1.4 2.4.7 3.7.7 5 0 9-3.6 9-8.1S17 3.2 12 3.2Z"
          fill="currentColor"
        />
        <circle className="brand-mark-dot" cx="8.4" cy="11.4" r="1.25" />
        <circle className="brand-mark-dot" cx="12" cy="11.4" r="1.25" />
        <circle className="brand-mark-dot" cx="15.6" cy="11.4" r="1.25" />
      </svg>
    </span>
  );
}

export function Logo({
  light = false,
  size = 32,
  href = "/",
}: {
  light?: boolean;
  size?: number;
  href?: string | null;
}) {
  const content = (
    <>
      <BrandMark size={size} />
      <span className="logo-word">Wabotia</span>
    </>
  );
  return href ? (
    <a className={"logo" + (light ? " light" : "")} href={href}>
      {content}
    </a>
  ) : (
    <span className={"logo" + (light ? " light" : "")}>{content}</span>
  );
}

/** Nomes e cores dos estados genéricos (conexões, entregas, execuções…). */
export const statusNames: Row = {
  ai: "Com o bot",
  waiting: "Na fila",
  human: "Com atendente",
  closed: "Concluído",
  open: "Recebido",
  in_progress: "Em análise",
  waiting_customer: "Aguardando cliente",
  waiting_third: "Aguardando terceiro",
  resolved: "Resolvido",
  active: "Conectado",
  enabled: "Habilitado",
  disabled: "Desabilitado",
  paused: "Pausado",
  pending: "Pendente",
  sent: "Enviado",
  delivered: "Entregue",
  read: "Lida",
  failed: "Falhou",
  unknown: "Conferir entrega",
  ready: "Disponível",
  unavailable: "Indisponível",
  queued: "Na fila",
  completed: "Concluído",
  running: "Em execução",
  starting: "Iniciando",
  cancelled: "Cancelado",
  granted: "Autorizado",
  revoked: "Revogado",
  answered: "Respondida",
  error: "Com erro",
  processing: "Processando",
};
const statusTones: Record<string, PillTone> = {
  ai: "bot",
  waiting: "warn",
  human: "brand",
  closed: "muted",
  open: "ticket",
  in_progress: "warn",
  waiting_customer: "bot",
  waiting_third: "bot",
  resolved: "ok",
  active: "ok",
  enabled: "ok",
  ready: "ok",
  sent: "ok",
  delivered: "ok",
  read: "ok",
  completed: "ok",
  granted: "ok",
  answered: "ok",
  pending: "warn",
  queued: "warn",
  running: "warn",
  starting: "warn",
  processing: "warn",
  paused: "muted",
  disabled: "muted",
  cancelled: "muted",
  unavailable: "muted",
  failed: "danger",
  error: "danger",
  revoked: "danger",
  unknown: "warn",
};

/** Pílula de estado genérica; estados desconhecidos aparecem como texto neutro. */
export function Badge({ value }: { value: string }) {
  return (
    <Pill tone={statusTones[value] || "muted"} className={"badge " + value}>
      {statusNames[value] || value || "—"}
    </Pill>
  );
}

const dateKeys = ["created", "updated", "expires", "response_due_at", "last_seen"];

/**
 * Tabela de Gestão: cabeçalho fixo, linhas de 44 px, ações à direita.
 * `columns` é uma lista de [chave, rótulo] ou [chave, rótulo, render].
 */
export function Table({
  rows,
  columns,
  action,
  empty,
}: {
  rows: Row[];
  columns: [string, string, ((row: Row) => React.ReactNode)?][];
  action?: (row: Row) => React.ReactNode;
  empty?: React.ReactNode;
}) {
  if (!rows.length)
    return (
      <>
        {empty || (
          <Empty
            compact
            title="Nenhum registro por aqui"
            description="Os dados aparecerão conforme sua operação começar."
          />
        )}
      </>
    );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map(([key, label]) => (
              <th key={key} scope="col">
                {label}
              </th>
            ))}
            {action && (
              <th className="table-actions" scope="col">
                <span className="sr-only">Ações</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id || index}>
              {columns.map(([key, , render]) => (
                <td key={key}>
                  {render ? (
                    render(row)
                  ) : key === "status" ? (
                    <Badge value={row[key]} />
                  ) : dateKeys.includes(key) ? (
                    date(row[key])
                  ) : (
                    String(row[key] ?? "—")
                  )}
                </td>
              ))}
              {action && <td className="table-actions">{action(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Cabeçalho de página de Gestão. */
export function PageHeader({
  title,
  description,
  actions,
  icon,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      {icon && <span className="page-header-icon">{icon}</span>}
      <div className="page-header-text">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}

/** Cartão com título opcional (formulários e blocos de Gestão). */
export function Card({
  title,
  description,
  actions,
  children,
  className = "",
  id,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={"card " + className} id={id}>
      {(title || actions) && (
        <div className="card-heading">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
