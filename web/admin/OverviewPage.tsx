// Início: resumo do atendimento em cartões com atalhos (web/DESIGN.md §8).
import React from "react";
import {
  AlarmClock,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Hourglass,
  Link2,
  ShieldCheck,
  UserCheck,
  Users,
  Zap,
} from "lucide-react";
import { useApp } from "../app/AppContext";
import type { Row } from "../lib/api";
import { linkProps, navigate, type Route } from "../lib/routes";
import { Badge, Button, Empty, type PillTone } from "../ui";
import { useResource } from "./shared";

function Stat({
  to,
  icon,
  label,
  value,
  hint,
  tone,
}: {
  to: Route;
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint: string;
  tone: PillTone;
}) {
  return (
    <a className={"stat-card tone-" + tone} {...linkProps(to)}>
      <span className="stat-icon">{icon}</span>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      <small>{hint}</small>
      <ArrowRight className="stat-arrow" size={16} aria-hidden />
    </a>
  );
}

const connectionKinds: Row = {
  hermes: "Hermes",
  zernio: "WhatsApp · Zernio",
  qr: "WhatsApp · QR",
  "hermes-whatsapp": "WhatsApp · Hermes",
  meta: "WhatsApp · Meta (anterior)",
};

export function OverviewPage() {
  const app = useApp();
  const { status } = app;
  // "Minhas" é contada nas conversas em atendimento humano carregadas.
  const mine = useResource(
    app.profile ? app.root + "/conversations?state=human&limit=100" : null,
  );
  const mineRows: Row[] = mine.data?.data || [];
  const mineCount = mineRows.filter((row) => row.owner === app.me.id).length;
  const overdue = app.ticketCounts.overdue;
  const total = (status.conversations || []).reduce(
    (sum: number, item: Row) => sum + item.count,
    0,
  );
  return (
    <>
      <div className="stat-grid" aria-label="Resumo do atendimento">
        <Stat
          to={{ area: "conversations" }}
          icon={<Hourglass size={20} />}
          label="Fila"
          value={app.statusLoaded ? app.count("waiting") : "–"}
          hint="Prontas para assumir"
          tone={app.count("waiting") ? "warn" : "muted"}
        />
        <Stat
          to={{ area: "conversations" }}
          icon={<UserCheck size={20} />}
          label="Minhas"
          value={
            mine.loaded
              ? mineCount + (mine.data?.next_cursor ? "+" : "")
              : "–"
          }
          hint="Em atendimento com você"
          tone="brand"
        />
        <Stat
          to={{ area: "conversations" }}
          icon={<Bot size={20} />}
          label="Com bot"
          value={app.statusLoaded ? app.count("ai") : "–"}
          hint="Atendidas pelos bots"
          tone="bot"
        />
        <Stat
          to={{ area: "tickets" }}
          icon={<AlarmClock size={20} />}
          label="Protocolos atrasados"
          value={overdue >= 100 ? "99+" : overdue}
          hint={
            app.ticketCounts.active
              ? `${app.ticketCounts.active >= 100 ? "99+" : app.ticketCounts.active} ativos`
              : "Nenhum protocolo ativo"
          }
          tone={overdue ? "danger" : "ticket"}
        />
        <Stat
          to={{ area: "team" }}
          icon={<Users size={20} />}
          label="Pessoas online"
          value={app.peopleOnline}
          hint={app.online ? "Você está online" : "Você está offline"}
          tone={app.peopleOnline ? "ok" : "muted"}
        />
      </div>
      <p className="stat-summary">
        {total} {total === 1 ? "conversa" : "conversas"} no total ·{" "}
        {app.count("closed")} concluídas ·{" "}
        {app.count("human")} com atendentes
      </p>
      {app.isAdmin && (
        <section className="card welcome-card">
          <div>
            <h2>
              {status.enabled
                ? "Seu atendimento, em um só lugar"
                : "Vamos preparar seu atendimento?"}
            </h2>
            <p>
              Conecte o WhatsApp, escolha quem atende e organize os caminhos do
              cliente. O assistente acompanha cada etapa.
            </p>
          </div>
          <Button
            onClick={() => navigate({ area: "admin", page: "setup" })}
            icon={<Zap size={17} />}
          >
            Abrir configuração guiada
          </Button>
        </section>
      )}
      <div className="overview-grid">
        <section className="card getting-started">
          <div className="section-heading">
            <div>
              <h2>Como o atendimento funciona</h2>
              <p>Cada parte tem um papel claro.</p>
            </div>
            <span className="soft-icon">
              <Zap size={20} />
            </span>
          </div>
          <div className="service-flow" aria-label="Fluxo de atendimento">
            <span>Cliente no WhatsApp</span>
            <ArrowRight size={16} />
            <span>Menu ou Bot Atendente</span>
            <ArrowRight size={16} />
            <span>Resposta ou equipe humana</span>
          </div>
          <p className="workspace-help">
            O Atendente pode consultar especialistas pelo Hermes, como o bot
            financeiro do Fagoo, e trazer o resultado para o cliente. As
            credenciais dos sistemas ficam com os especialistas.
          </p>
          <p className="workspace-help">
            Quando a equipe está ausente, uma solicitação encaminhada gera um
            protocolo para acompanhamento.
          </p>
        </section>
        <section className="card status-card">
          <div className="section-heading">
            <div>
              <h2>Suas conexões</h2>
              <p>
                {status.enabled ? "Atendimento ativo" : "Atendimento pausado"}
              </p>
            </div>
            <Link2 size={18} />
          </div>
          {status.connections?.length ? (
            status.connections.map((connection: Row) => (
              <div className="connection-row" key={connection.id}>
                <div>
                  <strong>{connection.name}</strong>
                  <small>
                    {connectionKinds[connection.kind] || connection.kind}
                  </small>
                </div>
                <Badge value={connection.status} />
              </div>
            ))
          ) : (
            <Empty
              compact
              icon={<Link2 size={24} />}
              title="O primeiro elo começa aqui"
              description="Conecte o Hermes e seus canais para acompanhar o estado de cada serviço."
            />
          )}
          {app.isAdmin && (
            <Button
              secondary
              onClick={() => navigate({ area: "admin", page: "connections" })}
            >
              Conferir canais <ArrowRight size={16} />
            </Button>
          )}
        </section>
      </div>
      <div className="bottom-note">
        <ShieldCheck size={18} />
        <span>
          Você tem o controle. Assumir uma conversa pausa as respostas da IA.
        </span>
        <a href="/api-docs">
          Conheça a API <ArrowUpRight size={14} />
        </a>
      </div>
   </>
  );
}
