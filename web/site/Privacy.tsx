// Política de privacidade dos aplicativos e do site oficial. Os aplicativos
// abrem esta página pelo endereço fixo /privacidade.
import React from "react";
import { SitePage } from "./SiteChrome";

// Contato sobre privacidade.
const contact = "suporte@queven.com.br";

export function Privacy() {
  return (
    <SitePage
      className="guide-page policy-page"
      nav={
        <>
          <a href="/install">Guia de instalação</a>
          <a href="/" className="text-link">
            Voltar ao início
          </a>
        </>
      }
    >
      <main>
        <div className="eyebrow">PRIVACIDADE</div>
        <h1>Política de privacidade</h1>
        <p className="lead">
          Vale para os aplicativos Wabotia de Android e iOS e para o site
          oficial. Atualizada em 13 de novembro de 2026.
        </p>

        <section className="account-setup hermes-guide">
          <h2>Quem cuida dos seus dados</h2>
          <p>
            O Wabotia é um programa de código aberto que cada empresa instala na
            própria conta de nuvem. O aplicativo se conecta ao{" "}
            <strong>servidor que você informa na primeira tela</strong>, que
            pertence à empresa onde você atende. Essa empresa é a responsável
            pelas conversas, contatos, protocolos e contas de usuário guardados
            ali, e é a ela que você deve pedir acesso, correção ou exclusão
            desses dados.
          </p>
          <p>
            Os aplicativos são publicados pela Quéven (Veneri &amp; Quellis
            Ltda, CNPJ 21.484.166/0001-09), que mantém dois serviços: o site
            oficial e o serviço de notificações descrito abaixo. A Quéven não
            tem acesso ao servidor da sua empresa.
          </p>
        </section>

        <section className="account-setup hermes-guide">
          <h2>O que o aplicativo usa</h2>
          <ul>
            <li>
              <strong>Dados de acesso:</strong> seu e-mail e sua senha são
              enviados somente ao servidor informado. A senha não fica guardada
              no aparelho; fica uma chave de sessão em armazenamento protegido
              do sistema.
            </li>
            <li>
              <strong>Conversas e arquivos:</strong> mensagens, contatos,
              protocolos e mídias são lidos do servidor da sua empresa e
              enviados a ele. O aparelho guarda cópias temporárias para abrir
              mais rápido; elas são apagadas quando você sai da conta.
            </li>
            <li>
              <strong>Microfone:</strong> para gravar mensagens de voz, quando
              você toca em gravar.
            </li>
            <li>
              <strong>Câmera e fotos:</strong> para enviar fotos e vídeos que
              você escolhe ou captura.
            </li>
            <li>
              <strong>Localização:</strong> somente no momento em que você
              escolhe compartilhar sua localização em uma conversa. O aplicativo
              não acompanha sua localização.
            </li>
            <li>
              <strong>Contatos:</strong> somente o contato que você escolhe para
              compartilhar como cartão. A agenda do aparelho não é copiada.
            </li>
            <li>
              <strong>Identificação do aparelho:</strong> nome do modelo, versão
              do aplicativo, um identificador da instalação e o endereço de
              notificações, registrados no servidor da sua empresa para entregar
              avisos.
            </li>
          </ul>
          <p>
            O aplicativo não tem anúncios, não usa ferramentas de análise de uso
            e não rastreia você em outros aplicativos ou sites.
          </p>
        </section>

        <section className="account-setup hermes-guide">
          <h2>Notificações</h2>
          <p>
            Para avisar sobre mensagens novas, o servidor da sua empresa envia a
            notificação ao serviço de notificações do Wabotia (
            <code>push.wabotia.queven.app</code>), que a repassa ao Firebase
            Cloud Messaging, do Google, e ao serviço de notificações da Apple. A
            notificação leva o endereço de notificações do aparelho, um título,
            que costuma ser o nome ou telefone do contato, e um trecho de até
            120 caracteres da mensagem.
          </p>
          <p>
            O serviço de notificações da Quéven só repassa esses dados: não
            guarda o conteúdo das notificações. A empresa pode configurar o
            servidor para enviar avisos sem o nome e sem o texto da mensagem, ou
            para usar um serviço de notificações próprio.
          </p>
        </section>

        <section className="account-setup hermes-guide">
          <h2>Site oficial</h2>
          <p>
            O site <code>wabotia.queven.app</code> distribui o programa e o
            guia. No instalador pelo navegador, o identificador da conta e a
            autorização da Cloudflare que você informa passam pelo servidor do
            site apenas durante a instalação e não são guardados. O site não usa
            cookies de publicidade.
          </p>
        </section>

        <section className="account-setup hermes-guide">
          <h2>Sua conta e seus direitos</h2>
          <p>
            As contas são criadas pelo administrador da empresa no painel do
            Wabotia; não é possível criar conta pelo aplicativo. Para alterar ou
            excluir sua conta e os dados ligados a ela, fale com o administrador
            da empresa onde você atende. Sair da conta no aplicativo apaga as
            cópias guardadas no aparelho.
          </p>
          <p>
            Dúvidas sobre os aplicativos ou sobre o serviço de notificações:{" "}
            <a href={"mailto:" + contact}>{contact}</a>.
          </p>
        </section>
      </main>
    </SitePage>
  );
}
