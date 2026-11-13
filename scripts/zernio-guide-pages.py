"""Import existing Zernio WhatsApp phones; provider setup stays outside Wabotia."""


def append_zernio_chapter(p, title, sub, steps, code, box, table, shot, link, n):
    title(n, 'WhatsApp com Zernio', 'zernio')
    p('O Wabotia importa telefones WhatsApp já cadastrados na Zernio. Gerencie o cadastro do telefone no painel Zernio; no Wabotia, informe as credenciais e escolha quais linhas importar.')
    steps([
        'Confira os telefones já cadastrados no painel Zernio e obtenha a chave API.',
        'No Wabotia, abra Gestão &gt; WhatsApp e canais &gt; Integração Zernio. Informe nome, fuso, chave API e segredo para o webhook; o ID pode ficar vazio inicialmente.',
        'Salve, clique Encontrar ID na Zernio e confirme a integração pelo nome.',
        'Em Telefones, clique Buscar telefones na Zernio. Confira a linha encontrada, contador inicial e limite local; adicione o telefone ao Wabotia.',
    ])
    box('A conta local Wabotia e o accountId WhatsApp da Zernio são identificadores diferentes. Não informe Phone Number ID, WABA ID, App Secret ou Verify Token da antiga integração direta.')
    p(link('Telefones cadastrados na Zernio', 'https://docs.zernio.com/accounts/list-accounts'), 'small')

    title(n + 1, 'Webhook e primeiro atendimento')
    steps([
        'Copie o webhook único da conta exibido no Wabotia. Na Zernio, cadastre esse endereço com o mesmo segredo.',
        'Assine message.received, message.sent, message.delivered, message.read, message.failed e reaction.received.',
        'Ative o número importado. Para conexão individual cadastrada em Hermes e canais, clique Testar conexão antes de ativar.',
        'Envie uma mensagem de um destinatário de teste. Confira o recebimento no Wabotia, responda pelo painel e teste uma mídia.',
        'Confira os recibos de entrega/leitura. Uma entrega sem confirmação precisa de reconciliação antes de nova tentativa.',
    ])
    code('https://SUA_URL/webhooks/zernio-accounts/ID_DA_CONTA_LOCAL')
    p('Na conexão individual, use a URL /webhooks/zernio/ID_DA_CONEXAO. Não configure esses endereços diretamente na Meta: o remetente dos webhooks é a Zernio.')
    box('Texto livre exige mensagem do cliente nas últimas 24 horas. Fora dessa janela, use template aprovado com consentimento e autorização de possível cobrança. O contador local não substitui as faturas Zernio/Meta.')
    p(link('Mensagens e webhooks', 'https://docs.zernio.com/platforms/whatsapp/inbox') + ' · ' + link('Preços e custos', 'https://docs.zernio.com/platforms/whatsapp/pricing'), 'small')

    title(n + 2, 'Trocar ou excluir telefones')
    steps([
        'As conexões antigas da Meta ficam pausadas após a atualização. Importe o telefone já cadastrado na Zernio e homologue o novo caminho.',
        'Para excluir, conclua ou reconcilie envios já iniciados, ligações e operações de grupos sem confirmação.',
        'Em Hermes e canais ou Integração Zernio, clique Excluir telefone e confirme. O Wabotia cancela envios ainda na fila e remove credenciais locais e vínculos de roteamento.',
        'O histórico de mensagens, conversas e protocolos é preservado. A exclusão no Wabotia não remove a conta na Zernio.',
    ])
    box('Ligações ao vivo no navegador não estão disponíveis nesta integração. Os registros históricos continuam acessíveis. Consulte as capacidades da conexão para os demais recursos.')
