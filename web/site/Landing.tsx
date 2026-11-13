// Página pública (web/DESIGN.md §9): a promessa do produto e uma prévia fiel
// do painel, desenhada com os mesmos componentes e tokens.
import React from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  Clock,
  Cloud,
  Code2,
  Forward,
  Mic,
  Plus,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Avatar, CountBadge, Pill, ProgressRing, type StateBadge } from "../ui";
import { Bubble, DayChip, EventChip, Ticks } from "../ui/chat";
import type { Tone } from "../lib/window";
import { SitePage } from "./SiteChrome";

const today = (hours: number, minutes: number) => {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
};

const rows: {
  name: string;
  seed: string;
  badge: StateBadge;
  time: string;
  waiting?: boolean;
  preview: string;
  ticks?: string;
  tags: string[];
  owner: string;
  tone: Tone;
  fraction: number;
  left: string;
  unread?: number;
  selected?: boolean;
}[] = [
  {
    name: "Mariana Albuquerque",
    seed: "mariana",
    badge: "mine",
    time: "14:32",
    preview: "Assumi seu atendimento. Já estou com o histórico.",
    ticks: "read",
    tags: ["Pedidos"],
    owner: "Com você",
    tone: "ok",
    fraction: 0.88,
    left: "21h",
    selected: true,
  },
  {
    name: "João Pedro Santos",
    seed: "joao-pedro",
    badge: "waiting",
    time: "espera 12 min",
    waiting: true,
    preview: "Preciso falar com uma pessoa, por favor.",
    tags: ["Suporte"],
    owner: "Na fila",
    tone: "warn",
    fraction: 0.21,
    left: "5h",
    unread: 2,
  },
  {
    name: "Loja Centro",
    seed: "loja-centro",
    badge: "bot",
    time: "13:05",
    preview: "Posso ajudar com mais alguma coisa?",
    ticks: "delivered",
    tags: [],
    owner: "Bot Atendente",
    tone: "danger",
    fraction: 0.03,
    left: "42m",
  },
];

/** Prévia do painel: lista com selo e anel da janela, conversa com bolhas. */
function ProductPreview() {
  return (
    <div
      className="mock"
      role="img"
      aria-label="Prévia do painel: lista de conversas com o relógio da janela de 24 horas e uma conversa em que o bot passa o atendimento para a equipe"
    >
      <div className="mock-list">
        <div className="mock-list-head">
          <strong>Conversas</strong>
          <span className="presence-pill online">
            <i /> Online
          </span>
        </div>
        <div className="mock-chips">
          <span className="chip active">Todas</span>
          <span className="chip tone-warn">
            <span>Fila</span>
            <b>1</b>
          </span>
          <span className="chip">
            <span>Minhas</span>
            <b>1</b>
          </span>
        </div>
        {rows.map((row) => (
          <div
            className={"mock-row" + (row.selected ? " selected" : "")}
            key={row.seed}
          >
            <Avatar name={row.name} seed={row.seed} size={44} badge={row.badge} />
            <div className="mock-row-main">
              <strong className="truncate">{row.name}</strong>
              <span className="mock-preview">
                {row.ticks && <Ticks status={row.ticks} size={15} />}
                <span className="truncate">{row.preview}</span>
              </span>
              <span className="mock-row-tags">
                {row.tags.map((tag) => (
                  <Pill key={tag}>{tag}</Pill>
                ))}
                <small>{row.owner}</small>
              </span>
            </div>
            <div className="mock-row-side">
              <small className={row.waiting ? "waiting" : ""}>{row.time}</small>
              <span className={"mock-window tone-" + row.tone}>
                <ProgressRing
                  fraction={row.fraction}
                  tone={row.tone}
                  size={20}
                  icon={<Clock size={10} strokeWidth={2.4} />}
                />
                {row.left}
              </span>
              {row.unread ? <CountBadge count={row.unread} /> : null}
            </div>
          </div>
        ))}
      </div>
      <div className="mock-chat">
        <div className="mock-chat-head">
          <Avatar name="Mariana Albuquerque" seed="mariana" size={38} badge="mine" />
          <div>
            <strong>Mariana Albuquerque</strong>
            <small>Com você</small>
          </div>
          <Forward size={19} />
        </div>
        <div className="mock-window-strip tone-ok">
          <ProgressRing
            fraction={0.88}
            tone="ok"
            size={18}
            icon={<Clock size={9} strokeWidth={2.4} />}
          />
          <span>Janela de 24h · 21h 14min restantes</span>
          <small>até amanhã 11:46</small>
        </div>
        <div className="mock-messages">
          <DayChip>Hoje</DayChip>
          <Bubble side="in" tail at={today(14, 28)}>
            <p>Olá! Preciso de ajuda com meu pedido.</p>
          </Bubble>
          <Bubble
            side="out"
            tail
            at={today(14, 28)}
            status="read"
            label={
              <>
                <Bot size={12} /> Atendente · Hermes
              </>
            }
            labelTone="bot"
          >
            <p>Claro! Vou consultar as informações e ajudar você.</p>
          </Bubble>
          <EventChip icon={<Users size={13} />}>
            Contexto preservado, do bot à equipe.
          </EventChip>
          <Bubble side="out" tail at={today(14, 32)} status="read">
            <p>Assumi seu atendimento. Já estou com o histórico.</p>
          </Bubble>
        </div>
        <div className="mock-composer">
          <Plus size={20} />
          <span>Mensagem</span>
          <i>
            <Mic size={17} />
          </i>
        </div>
      </div>
    </div>
  );
}

export function Landing() {
  return (
    <SitePage
      className="landing"
      nav={
        <>
          <a href="#como-funciona">Como funciona</a>
          <a href="/install">Instalação</a>
          <a href="/api-docs">Para desenvolvedores</a>
          <a className="button small" href="/app">
            Abrir painel <ArrowUpRight size={16} />
          </a>
        </>
      }
    >
      <main>
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow">
              <span /> CÓDIGO ABERTO · FEITO PARA O HERMES
            </div>
            <h1>
              Conversas que chegam ao <em>lugar certo.</em>
            </h1>
            <p>
              Seus bots, sua equipe e seus clientes. Um atendimento conectado no
              WhatsApp, com a inteligência do Hermes e o controle nas suas mãos.
            </p>
            <div className="hero-actions">
              <a className="button lg" href="/install#nodejs">
                Publicar na Cloudflare <Cloud size={19} />
              </a>
              <a className="text-link" href="/install">
                Ver passo a passo <ArrowRight size={17} />
              </a>
            </div>
            <div className="hero-proof">
              <ShieldCheck size={16} /> Na sua conta Cloudflare. Com os seus
              dados.
            </div>
          </div>
          <div className="hero-visual">
            <ProductPreview />
            <div className="hero-connections">
              <div>
                <Bot size={20} />
                <span>
                  <strong>Hermes</strong>
                  <small>Inteligência</small>
                </span>
              </div>
              <div>
                <Users size={20} />
                <span>
                  <strong>Sua equipe</strong>
                  <small>Atendimento humano</small>
                </span>
              </div>
              <div>
                <Code2 size={20} />
                <span>
                  <strong>Seus sistemas</strong>
                  <small>API aberta</small>
                </span>
              </div>
            </div>
            <p className="hero-caption">
              <strong>Um atendimento, conectado.</strong> Uma visão de como seu
              atendimento se conecta: WhatsApp · Web + API.
            </p>
          </div>
        </section>
        <section className="feature-band" id="como-funciona">
          <article>
            <span className="step-no">01</span>
            <h3>Conecte seu Hermes</h3>
            <p>
              Local, em Docker ou na sua VPS. Ligue seus bots ao painel por uma
              conexão segura.
            </p>
          </article>
          <article>
            <span className="step-no">02</span>
            <h3>Organize o atendimento</h3>
            <p>Conversas, protocolos, conhecimento e equipe no mesmo lugar.</p>
          </article>
          <article>
            <span className="step-no">03</span>
            <h3>Integre seus sistemas</h3>
            <p>
              Uma API documentada para mensagens, chamados e execução de bots.
            </p>
          </article>
        </section>
        <section className="landing-bottom">
          <div>
            <div className="eyebrow">SIMPLES DE OPERAR. SEU PARA EVOLUIR.</div>
            <h2>Comece com um guia ao seu lado.</h2>
            <p>
              Do primeiro deploy à primeira conversa, com instruções em
              português.
            </p>
          </div>
          <a className="button secondary lg" href="/install">
            Abrir guia de instalação <ArrowRight size={18} />
          </a>
        </section>
      </main>
    </SitePage>
  );
}
