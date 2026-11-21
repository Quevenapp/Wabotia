import React from "react";
import { date } from "../lib/format";
import type { Row } from "../lib/api";
import { Pill, type PillTone } from "./controls";
import { Empty } from "./feedback";

// Desenhos da marca Vinki: brand/vinki/icone.svg e brand/vinki/logo.svg (arquivos do dono).
const VINKI_ICON =
  "M0 65731c0,24060 11059,40171 23266,58357 14772,22008 35562,49664 51848,70947l18237 22935c6760,7295 13544,13892 22243,18928 18091,10475 45057,12956 64263,4357 7007,-3137 12187,-6327 17893,-11000 5296,-4337 9930,-8511 14197,-13973l6418 -8029c2326,-2849 4137,-5271 6376,-8071l24873 -32190c11644,-15574 39298,-51556 47020,-67106 3618,-7285 5566,-12208 7288,-20902 8758,-44217 -22188,-79983 -60501,-79983 -26318,0 -44886,13306 -56234,28893l-618 827c-5812,7591 -31638,42506 -34883,44679 -514,-1926 -6850,-9730 -8504,-11724 -8120,-9793 -23682,-32480 -31762,-40467 -1805,-1784 -3206,-3398 -5064,-5049 -19626,-17445 -47655,-22037 -72108,-11080 -8631,3867 -15446,10681 -21042,17241 -2989,3504 -6971,10938 -8581,15255 -2742,7355 -4626,17453 -4626,27156z";
const VINKI_WORD = [
  "M258957 10731l0 105501c0,13743 24588,17669 24586,-990 -1,-8897 -76,-17813 -76,-26718 4889,1306 12421,10810 15827,15078 3568,4473 22334,24352 27866,24352 8952,0 12788,-4901 12788,-12788 0,-6992 -20185,-25592 -26925,-31687 -1790,-1618 -110,-380 -2335,-1928 -1617,-1125 -561,-775 -2710,-1552 10908,-16289 29839,-20771 29839,-36233 0,-6819 -5205,-9591 -11722,-9591 -8420,0 -31138,30671 -42627,38364l-66 -62808c-1857,-13650 -24444,-12266 -24444,1000z",
  "M151325 85328c0,19367 -3744,42627 13854,42627 28782,0 -8419,-74597 31970,-74597 36779,0 14809,60498 25231,70679 7606,7430 21658,3514 21658,-7804l0 -38364c0,-54126 -63632,-54490 -82828,-31676 -7807,9278 -9885,22534 -9885,39136z",
  "M0 44832c0,21338 18402,83122 47955,83122 26500,0 38378,-32694 44884,-53157 3662,-11519 15192,-40621 -6520,-40621 -20902,0 -10990,53782 -37298,71400 -3077,-1628 -1507,-434 -3658,-2736 -6745,-7216 -11961,-22960 -14690,-32199 -6629,-22439 -3590,-36465 -20016,-36465 -5358,0 -10657,5299 -10657,10656z",
  "M110829 42701l0 73531c0,14255 24510,15937 24510,1065l0 -74597c0,-13135 -24510,-13135 -24510,0z",
  "M351670 42701l0 72465c0,17820 24510,15478 24510,2131l0 -73531c0,-14210 -24510,-14322 -24510,-1066z",
];

/** Símbolo do aplicativo: o coração do Vinki sobre o degradê da marca. */
export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <span
      className="brand-mark"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
      aria-hidden
    >
      <svg viewBox="0 0 305418 246456" width={Math.round(size * 0.58)} height={Math.round(size * 0.47)}>
        <path d={VINKI_ICON} fill="currentColor" fillRule="evenodd" />
      </svg>
    </span>
  );
}

/** Logotipo "vinki" na cor do texto em volta (tema claro ou escuro). */
export function LogoWord({ height = 20 }: { height?: number }) {
  return (
    <svg
      className="logo-word"
      viewBox="0 0 377721 127954"
      height={height}
      width={Math.round((height * 377721) / 127954)}
      role="img"
      aria-label="Vinki"
    >
      {VINKI_WORD.map((d, i) => (
        <path key={i} d={d} fill="currentColor" fillRule="evenodd" />
      ))}
      <circle cx="123650" cy="13615" r="13594" fill="currentColor" />
      <circle cx="364128" cy="13594" r="13594" fill="currentColor" />
    </svg>
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
      <LogoWord height={Math.round(size * 0.6)} />
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
 * Em espaço estreito (celular, tablet em pé) cada linha vira um bloco com o
 * rótulo da coluna ao lado do valor (.table-stack em styles/base.css).
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
    <div className="table-stack">
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
                {columns.map(([key, label, render]) => (
                  <td key={key} data-label={label}>
                    <div className="cell">
                      {render ? (
                        render(row)
                      ) : key === "status" ? (
                        <Badge value={row[key]} />
                      ) : dateKeys.includes(key) ? (
                        date(row[key])
                      ) : (
                        String(row[key] ?? "—")
                      )}
                    </div>
                  </td>
                ))}
                {action && <td className="table-actions">{action(row)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
