export function RouterGuide() {
  return (
    <section id="roteador" className="system-card card hermes-guide">
      <div className="eyebrow">WHATSAPP · DISTRIBUIÇÃO POR NÚMERO</div>
      <h2>Uma entrada para seus números WhatsApp</h2>
      <p>
        Conecte os números por uma conta Zernio e escolha quais linhas podem
        atender, receber bots, participar de grupos de roteamento ou ser usadas
        por sistemas externos. Comece pelo{" "}
        <a href="#zernio-whatsapp">guia de conexão da Zernio</a>.
      </p>
      <details open>
        <summary>1. Importe os números conectados à Zernio</summary>
        <ol>
          <li>
            Em <strong>Zernio e números</strong>, salve sua conta e conclua{" "}
            <strong>Conectar WhatsApp pela Zernio</strong>.
          </li>
          <li>
            Configure o webhook da conta e clique em{" "}
            <strong>Buscar números na Zernio</strong>.
          </li>
          <li>
            Selecione um telefone, informe seu consumo inicial e a cota local
            que deseja configurar.
          </li>
          <li>
            O número entra pausado. Confira a conexão, ative e teste uma
            conversa antes de receber clientes.
          </li>
        </ol>
      </details>
      <details>
        <summary>2. Escolha a função de cada linha</summary>
        <p>
          Em <strong>Função e permissões</strong>, use Atendimento oficial para
          a linha de contato da empresa ou Integração com janela de 24 horas
          para linhas usadas por sistemas. Revise as permissões de serviço,
          templates, bots, menus e atendimento humano. As permissões da linha
          também valem para mensagens que ainda estão na fila.
        </p>
      </details>
      <details>
        <summary>3. Distribua novos atendimentos</summary>
        <ol>
          <li>
            Abra <strong>Distribuição</strong>, crie um grupo e marque os
            números da mesma conta.
          </li>
          <li>
            Escolha as permissões, ative o grupo e habilite o link público se
            desejar.
          </li>
          <li>
            Divulgue o link para novos clientes ou use o ID do grupo na
            integração.
          </li>
        </ol>
        <p>
          O rodízio escolhe uma linha para cada novo atendimento. As conversas
          existentes mantêm seu remetente. A janela de 24 horas é aberta pelo
          cliente e pertence ao número que recebeu a mensagem.
        </p>
      </details>
      <details>
        <summary>4. Autorize seus sistemas</summary>
        <p>
          Crie a aplicação em <strong>API e integrações</strong>. Em
          <strong> Acesso dos sistemas</strong>, escolha os números ou grupos
          permitidos. A API aceita <code>number_id</code> ou{" "}
          <code>pool_id</code>. Templates exigem aprovação, consentimento e
          autorização para cobrança. Uma resposta na fila ainda precisa da
          confirmação de envio e entrega.
        </p>
      </details>
      <details>
        <summary>5. Exclua um telefone</summary>
        <p>
          Em <strong>Números</strong> ou <strong>Conexões</strong>, clique em
          <strong> Excluir telefone</strong> e confira a confirmação. Resolva
          envios em andamento ou sem confirmação e ligações abertas antes.
          Mensagens e operações de grupo ainda na fila serão canceladas. O
          histórico é preservado e a conta remota continua na Zernio. Para
          cancelar serviços do provedor, use a própria Zernio.
        </p>
      </details>
      <p>
        Os contadores locais acompanham histórico inicial, entregas e reservas;
        eles não substituem a fatura da Zernio ou da Meta. Cobrança não
        informada não significa gratuidade. Consulte as{" "}
        <a
          href="https://docs.zernio.com/platforms/whatsapp/pricing"
          target="_blank"
          rel="noreferrer"
        >
          tarifas atuais
        </a>
        .
      </p>
      <p>
        <a href="/api-docs">API interativa</a>
      </p>
    </section>
  );
}
