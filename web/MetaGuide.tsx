export function MetaGuide() {
  return (
    <section id="zernio-whatsapp" className="system-card card hermes-guide">
      <span id="meta-whatsapp" />
      <div className="eyebrow">WHATSAPP OFICIAL · ZERNIO</div>
      <h2>Importe seus telefones da Zernio</h2>
      <p>
        O Wabotia usa os telefones já cadastrados e conectados na Zernio. A API
        key permite encontrar a integração e suas linhas, além de enviar
        mensagens. Os eventos chegam pelo webhook da Zernio.
      </p>
      <details open>
        <summary>1. Prepare sua integração Zernio</summary>
        <ol>
          <li>
            Confira no painel da Zernio quais telefones já estão cadastrados e
            conectados.
          </li>
          <li>
            Crie uma API key com acesso à integração e prepare um segredo para
            assinar o webhook.
          </li>
          <li>
            Se um telefone não estiver disponível, gerencie seu cadastro no
            painel da Zernio.
          </li>
        </ol>
        <p>
          <a href="https://zernio.com" target="_blank" rel="noreferrer">
            Abrir painel Zernio ↗
          </a>
        </p>
      </details>
      <details>
        <summary>2. Salve a API key e encontre sua integração</summary>
        <ol>
          <li>
            Abra <strong>WhatsApp e canais → Integração Zernio</strong> e clique
            em <strong>Nova integração</strong>.
          </li>
          <li>
            Informe nome, fuso, API key e segredo de assinatura do webhook. O ID
            da integração é opcional neste momento. Salve.
          </li>
          <li>
            Clique em <strong>Encontrar ID na Zernio</strong>, confira o nome e
            confirme com <strong>Usar esta integração</strong>.
          </li>
          <li>
            Abra a etapa <strong>Telefones</strong> e use{" "}
            <strong>Buscar telefones na Zernio</strong>.
          </li>
        </ol>
        <p>
          O ID da integração é o Profile ID. Cada telefone possui seu próprio
          Account ID, que é diferente do ID da integração. A API key e o segredo
          ficam protegidos no servidor.
        </p>
      </details>
      <details>
        <summary>3. Configure o recebimento e importe as linhas</summary>
        <ol>
          <li>
            Copie o <strong>Webhook único desta integração</strong> usando o
            domínio da sua instalação HTTPS.
          </li>
          <li>
            Cadastre essa URL nos webhooks da Zernio, com o mesmo segredo
            informado no Wabotia.
          </li>
          <li>
            Habilite os eventos de recebimento, envio, entrega, leitura e falha
            de mensagens.
          </li>
          <li>
            Selecione cada telefone encontrado e clique em{" "}
            <strong>Adicionar telefone ao Wabotia</strong>. A linha entra
            pausada, sem alterar seu cadastro na Zernio.
          </li>
          <li>
            Ative a linha, escolha quem atende e faça um teste de entrada,
            resposta e confirmação de entrega.
          </li>
        </ol>
      </details>
      <details>
        <summary>Já usava a integração direta com a Meta</summary>
        <p>
          As conexões diretas são pausadas na atualização. As credenciais
          antigas não viram credenciais Zernio automaticamente. Resolva envios
          em andamento ou sem confirmação e ligações abertas, exclua a linha
          antiga do Wabotia e importe o telefone já conectado na Zernio. O
          histórico anterior permanece disponível, separado da nova conexão.
        </p>
        <p>
          <strong>Excluir telefone</strong> remove a configuração local e seus
          acessos. Mensagens e operações de grupo ainda na fila serão
          canceladas. A ação não apaga conversas e não cancela o telefone, a
          conta ou cobranças do provedor.
        </p>
      </details>
      <p>
        A janela de atendimento de 24 horas e a aprovação de templates continuam
        sendo regras do WhatsApp. A Zernio e a Meta podem cobrar por serviços
        diferentes; confira o plano e as tarifas antes de ativar.
      </p>
      <p>
        <a
          href="https://docs.zernio.com/platforms/whatsapp"
          target="_blank"
          rel="noreferrer"
        >
          Documentação WhatsApp da Zernio ↗
        </a>
        {" · "}
        <a
          href="https://docs.zernio.com/platforms/whatsapp/pricing"
          target="_blank"
          rel="noreferrer"
        >
          Tarifas e cobranças ↗
        </a>
      </p>
    </section>
  );
}
