// Guia de instalação (web/DESIGN.md §9). O conteúdo de cada etapa mora nos
// componentes de guia; esta página cuida da moldura, do índice e das âncoras.
import React, { useEffect } from "react";
import { ArrowRight, ArrowUpRight, Code2, ShieldCheck } from "lucide-react";
import { DirectInstall } from "../DirectInstall";
import { CloudflarePrerequisites } from "../cloudflare-prerequisites";
import { InstallKeys } from "../InstallKeys";
import { HermesInstall } from "../hermes-install";
import { MaintenanceGuide } from "../maintenance-guide";
import { ContactGuide } from "../ContactGuide";
import { MetaGuide } from "../MetaGuide";
import { WhatsAppGuide } from "../WhatsAppGuide";
import { RouterGuide } from "../RouterGuide";
import { SitePage } from "./SiteChrome";

const installSteps = [
  [
    "Prepare a Cloudflare",
    "Ative R2, confira D1 e Workers e prepare Zero Trust para o túnel do Hermes.",
  ],
  [
    "Execute o instalador",
    "Baixe o instalador oficial. Informe Account ID, token Cloudflare e um nome novo. Ele publica os recursos e gera as chaves.",
  ],
  [
    "Crie seu administrador",
    "Abra a URL exibida e use SETUP_TOKEN do arquivo chaves.local.json para criar sua conta individual.",
  ],
  [
    "Conecte o Hermes",
    "Cadastre as APIs e as chaves do Hermes. Teste a conexão, descubra os bots e selecione o Atendente.",
  ],
  [
    "Escolha seus canais",
    "Importe os telefones já conectados na Zernio ou use QR. Configure o bot Telegram dedicado. Use apenas um modo por número.",
  ],
  [
    "Teste e atualize pelo painel",
    "Confira mensagens e tomada humana antes de ativar. As próximas versões oficiais são instaladas em Sistema e atualizações.",
  ],
];

// Âncoras que abrem o bloco recolhido correspondente ao chegar pela URL.
const anchors = [
  "#nodejs",
  "#nodejs-erros",
  "#instalar",
  "#reinstalar",
  "#requisitos",
  "#servicos-cloudflare",
  "#hermes",
  "#cloudflare-hermes",
  "#deploy-hermes",
  "#atualizacoes",
  "#agenda",
  "#meta-whatsapp",
  "#zernio-whatsapp",
  "#whatsapp-recursos",
  "#roteador",
];

const contents: [string, string][] = [
  ["#nodejs", "Node.js"],
  ["#instalar", "Instalar na Cloudflare"],
  ["#requisitos", "Serviços da Cloudflare"],
  ["#chaves", "Gerador de chaves"],
  ["#resumo", "Resumo das etapas"],
  ["#hermes", "Hermes"],
  ["#atualizacoes", "Atualizações"],
  ["#agenda", "Agenda de contatos"],
  ["#zernio-whatsapp", "WhatsApp pela Zernio"],
  ["#whatsapp-recursos", "Recursos do WhatsApp"],
  ["#roteador", "Distribuição por telefone"],
];

export function Install() {
  useEffect(() => {
    const showStep = () => {
      if (anchors.includes(location.hash)) {
        const target = document.getElementById(location.hash.slice(1));
        if (target instanceof HTMLDetailsElement) target.open = true;
        target?.scrollIntoView();
      }
      // O gerador de chaves fica dentro de um bloco recolhido.
      if (location.hash === "#chaves") {
        const keys = document.getElementById("chaves");
        const holder = keys?.closest("details");
        if (holder) holder.open = true;
        keys?.scrollIntoView();
      }
    };
    const frame = requestAnimationFrame(showStep);
    window.addEventListener("load", showStep, { once: true });
    window.addEventListener("hashchange", showStep);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("load", showStep);
      window.removeEventListener("hashchange", showStep);
    };
  }, []);
  return (
    <SitePage
      className="guide-page"
      nav={
        <>
          <a href="/api-docs">Para desenvolvedores</a>
          <a href="/" className="text-link">
            Voltar ao início
          </a>
        </>
      }
    >
      <div className="guide-layout">
        <aside className="guide-toc" aria-label="Nesta página">
          <strong>Nesta página</strong>
          {contents.map(([href, label]) => (
            <a key={href} href={href}>
              {label}
            </a>
          ))}
        </aside>
        <main>
          <div className="eyebrow">GUIA DE INSTALAÇÃO</div>
          <h1>
            Seu primeiro atendimento, <em>passo a passo.</em>
          </h1>
          <p className="lead">
            Você configura uma vez. Depois, tudo acontece pelo painel.
          </p>
          <DirectInstall />
          <CloudflarePrerequisites />
          <div className="guide-actions">
            <a className="button secondary" href="#zernio-whatsapp">
              Importar telefones da Zernio <ArrowRight size={18} />
            </a>
          </div>
          <details className="guide-disclosure">
            <summary>
              Gerador de chaves para configuração manual (opcional)
            </summary>
            <InstallKeys />
          </details>
          <div className="guide-grid" id="resumo">
            {installSteps.map(([title, desc], i) => (
              <article key={title}>
                <span className="step-no">0{i + 1}</span>
                <h2>{title}</h2>
                <p>{desc}</p>
                {i === 0 && (
                  <div className="inline-links">
                    <a href="https://dash.cloudflare.com/">Cloudflare ↗</a>
                  </div>
                )}
              </article>
            ))}
          </div>
          <HermesInstall />
          <MaintenanceGuide />
          <ContactGuide />
          <MetaGuide />
          <WhatsAppGuide />
          <RouterGuide />
          <aside className="callout">
            <ShieldCheck />
            <div>
              <strong>Guarde suas chaves com cuidado</strong>
              <p>
                Tokens e senhas ficam nos campos protegidos. Não publique esses
                valores no GitHub nem envie em mensagens de suporte.
              </p>
            </div>
          </aside>
          <div className="guide-links">
            <a href="/app">
              Abrir painel <ArrowRight size={17} />
            </a>
            <a href="/api-docs">
              Documentação da API <Code2 size={17} />
            </a>
            <a href="/app?demo=1">
              Conhecer as telas com dados fictícios <ArrowUpRight size={17} />
            </a>
          </div>
        </main>
      </div>
    </SitePage>
  );
}
