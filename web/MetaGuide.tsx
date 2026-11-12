export function MetaGuide() {
  return (
    <section id="zernio-whatsapp" className="system-card card hermes-guide">
      <span id="meta-whatsapp" />
      <div className="eyebrow">WHATSAPP OFICIAL · ZERNIO</div>
      <h2>Conecte seu WhatsApp pela Zernio</h2>
      <p>
        A Zernio é a intermediária entre o Wabotia e a Meta. O Wabotia usa a API
        key da Zernio para enviar mensagens e recebe os eventos pelo webhook
        dela. A autorização da empresa e do número acontece no fluxo de conexão
        da Zernio.
      </p>
      <details open>
        <summary>1. Prepare sua conta Zernio</summary>
        <ol>
          <li>Crie ou escolha um perfil na Zernio e copie seu Profile ID.</li>
          <li>
            Crie uma API key com acesso ao perfil e prepare um segredo para
            assinar o webhook.
          </li>
          <li>
            Tenha acesso à conta empresarial Meta e ao número que deseja
            conectar.
          </li>
        </ol>
        <p>
          <a
            href="https://docs.zernio.com/platforms/whatsapp/connect"
            target="_blank"
            rel="noreferrer"
          >
            Guia oficial de conexão da Zernio ↗
          </a>
        </p>
      </details>
      <details>
        <summary>2. Salve a conta no Wabotia e conecte o WhatsApp</summary>
        <ol>
          <li>
            Abra <strong>Canais → Zernio e números</strong> e clique em{" "}
            <strong>Nova conta</strong>.
          </li>
          <li>
            Informe nome, Profile ID, fuso, API key e segredo de assinatura do
            webhook. Salve.
          </li>
          <li>
            Clique em <strong>Conectar WhatsApp pela Zernio</strong> e conclua a
            autorização exibida pelo provedor.
          </li>
          <li>
            Ao retornar ao Wabotia, abra a mesma conta e use{" "}
            <strong>Buscar números na Zernio</strong>.
          </li>
        </ol>
        <p>
          Cada número conectado possui seu próprio Account ID. A API key e o
          segredo ficam protegidos no servidor.
        </p>
      </details>
      <details>
        <summary>3. Configure o recebimento e importe as linhas</summary>
        <ol>
          <li>
            Copie o <strong>Webhook único desta conta</strong> usando o domínio
            da sua instalação HTTPS.
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
            Selecione cada número encontrado, confira o consumo inicial e
            adicione ao Wabotia.
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
          antiga do Wabotia e conecte o número pela Zernio. O histórico anterior
          permanece disponível, separado da nova conexão.
        </p>
        <p>
          <strong>Excluir telefone</strong> remove a configuração local e seus
          acessos. Mensagens e operações de grupo ainda na fila serão
          canceladas. A ação não apaga conversas e não cancela o número, a conta
          ou cobranças do provedor.
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
