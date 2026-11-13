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
import { installTokenUrl } from "../../src/install-links";

const installSteps = [
  [
    "Prepare a Cloudflare",
    "Ative R2 e confira D1 e Workers. Zero Trust e domínio só são necessários se você escolher ligar o Hermes por túnel.",
  ],
  [
    "Instale pelo navegador",
    "Abra o instalador do site oficial. Informe o ID da conta, o token Cloudflare (há um link que abre o formulário preenchido) e um nome novo. Ele publica os recursos e gera as chaves, sem terminal.",
  ],
  [
    "Crie seu administrador",
    "Baixe o arquivo de chaves e clique em Criar meu administrador ao final. O link já leva o código de instalação; você só escolhe nome, e-mail e senha.",
  ],
  [
    "Conecte o Hermes",
    "Em Hermes e canais, crie a conexão por plugin e execute um comando na máquina do Hermes. Teste a conexão, descubra os bots e selecione o Atendente. Não precisa de túnel nem de domínio.",
  ],
  [
    "Escolha seus canais",
    "Importe os telefones já conectados na Zernio ou use QR. Use apenas um modo por número.",
  ],
  [
    "Teste e atualize pelo painel",
    "Confira mensagens e tomada humana antes de ativar. As próximas versões oficiais são instaladas em Sistema e atualizações.",
  ],
];

// Âncoras que abrem o bloco recolhido correspondente ao chegar pela URL.
const anchors = [
  "#navegador",
  "#regras",
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
  ["#navegador", "Instalar pelo navegador"],
  ["#requisitos", "Serviços da Cloudflare"],
  ["#resumo", "Resumo das etapas"],
  ["#hermes", "Hermes"],
  ["#zernio-whatsapp", "WhatsApp pela Zernio"],
  ["#regras", "Regras de atendimento"],
  ["#atualizacoes", "Atualizações"],
  ["#agenda", "Contatos"],
  ["#whatsapp-recursos", "Recursos do WhatsApp"],
  ["#roteador", "Distribuição por telefone"],
  ["#nodejs", "Alternativa: terminal"],
  ["#chaves", "Gerador de chaves"],
];

const officialInstaller = "https://wabotia.queven.app/instalar";

function BrowserInstall() {
  return (
    <section className="account-setup hermes-guide" id="navegador">
      <div className="eyebrow">CAMINHO RECOMENDADO · SEM TERMINAL</div>
      <h2>Instale pelo navegador</h2>
      <p>
        O instalador do site oficial publica o Wabotia na sua conta Cloudflare
        sem Node.js e sem linha de comando. O painel, o banco e os arquivos
        ficam na sua conta. O token passa pelo servidor do Wabotia durante a
        instalação e não é guardado; quem preferir que ele vá direto do
        computador para a Cloudflare usa o{" "}
        <a href="#nodejs">instalador pelo terminal</a>.
      </p>
      <ol>
        <li>
          Na Cloudflare, ative o R2 (<a href="#requisitos">veja como</a>) e
          copie o <strong>ID da conta</strong>: na página inicial da conta, abra
          o menu de três pontos ao lado do nome e escolha{" "}
          <strong>Copiar ID da conta</strong>.
        </li>
        <li>
          Crie o token:{" "}
          <a href={installTokenUrl} target="_blank" rel="noopener noreferrer">
            abrir a Cloudflare com o token já preenchido ↗
          </a>
          . O formulário chega com o nome e as três permissões. Em recursos da
          conta, escolha somente a conta da instalação, continue até o resumo e
          crie. O valor aparece uma única vez.
        </li>
        <li>
          Abra o instalador, cole o ID da conta e o token, escolha um nome novo,
          como <code>wabotia-atendimento</code>, e clique em{" "}
          <strong>Conferir a conta</strong>.
        </li>
        <li>
          Clique em <strong>Baixar chaves</strong> e guarde o arquivo{" "}
          <code>NOME-chaves.local.json</code> em local privado. Ele traz
          MASTER_KEY e SETUP_TOKEN, que não são mostradas de novo. Depois clique
          em <strong>Guardei o arquivo, instalar</strong> e acompanhe as etapas
          sem fechar a página. Se uma etapa falhar, use{" "}
          <strong>Tentar este passo de novo</strong>.
        </li>
        <li>
          Ao terminar, clique em <strong>Criar meu administrador</strong>. O
          link já leva o código de instalação; escolha nome, e-mail e senha.
        </li>
      </ol>
      <div className="guide-actions">
        <a className="button" href={officialInstaller}>
          Abrir o instalador <ArrowRight size={18} />
        </a>
        <a
          className="button secondary"
          href="/guide/wabotia-instalacao.pdf"
          target="_blank"
          rel="noopener noreferrer"
        >
          Guia ilustrado em PDF <ArrowUpRight size={18} />
        </a>
      </div>
    </section>
  );
}

function ServiceRulesGuide() {
  return (
    <section className="account-setup hermes-guide" id="regras">
      <div className="eyebrow">DEPOIS DE CONECTAR · ATENDIMENTO</div>
      <h2>Defina as regras de atendimento</h2>
      <p>
        Em <strong>Gestão → Automação → Regras de atendimento</strong> você
        escolhe o que acontece quando ninguém da equipe está disponível e como
        as respostas são assinadas.
      </p>
      <ul>
        <li>
          <strong>Protocolo na ausência:</strong> o cliente recebe um número de
          protocolo quando não há pessoa disponível.
        </li>
        <li>
          <strong>Bot continua respondendo:</strong> depois do protocolo, o
          Atendente segue na conversa até alguém da equipe assumir.
        </li>
        <li>
          <strong>Pedido de autorização:</strong> o cliente confirma por botões
          antes de continuar com o bot.
        </li>
        <li>
          <strong>Assinatura:</strong> cada resposta pode levar o nome de quem
          escreveu, como “Bruno - Humano” ou “Bia - IA”. Menus e avisos
          automáticos não levam assinatura.
        </li>
      </ul>
      <p>
        Nas linhas da Zernio, o cliente vê <strong>digitando...</strong>{" "}
        enquanto o bot prepara a resposta; não há o que configurar.
      </p>
    </section>
  );
}

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
          <a
            href="/guide/wabotia-instalacao.pdf"
            target="_blank"
            rel="noopener noreferrer"
          >
            Guia em PDF
          </a>
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
          <BrowserInstall />
          <CloudflarePrerequisites />
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
          <MetaGuide />
          <ServiceRulesGuide />
          <MaintenanceGuide />
          <ContactGuide />
          <WhatsAppGuide />
          <RouterGuide />
          <DirectInstall />
          <details className="guide-disclosure">
            <summary>
              Gerador de chaves para configuração manual (opcional)
            </summary>
            <InstallKeys />
          </details>
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
