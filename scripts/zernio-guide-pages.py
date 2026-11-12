"""Current WhatsApp onboarding chapter; no direct Meta credentials are used."""


def append_zernio_chapter(p, title, sub, steps, code, box, table, shot, link, n):
    title(n, 'WhatsApp com Zernio')
    p('A Zernio intermedeia a conexão do Wabotia com a Meta. Você precisa de um número WhatsApp Business e de um perfil Zernio. Os requisitos empresariais e as regras do WhatsApp continuam valendo.')
    steps([
        'Crie seu perfil na Zernio e obtenha a chave API. Guarde o ID do perfil, composto por 24 caracteres.',
        'No Wabotia, abra Roteador de números e cadastre a conta Zernio. Informe nome, ID do perfil, fuso, chave API e um segredo para o webhook.',
        'Clique Conectar WhatsApp. Conclua o cadastro guiado pela Zernio e volte ao Wabotia.',
        'Clique Buscar números na Zernio. Confira o telefone, nome, contador inicial e limite local; adicione o número ao roteador.',
    ])
    box('A conta local Wabotia e o accountId WhatsApp da Zernio são identificadores diferentes. Não informe Phone Number ID, WABA ID, App Secret ou Verify Token da antiga integração direta.')
    p(link('Conexão WhatsApp na Zernio', 'https://docs.zernio.com/platforms/whatsapp/connect'), 'small')

    title(n + 1, 'Webhook e primeiro atendimento')
    steps([
        'Copie o webhook único da conta exibido no Wabotia. Na Zernio, cadastre esse endereço com o mesmo segredo.',
        'Assine message.received, message.sent, message.delivered, message.read, message.failed e reaction.received.',
        'Ative o número importado. Para conexão individual cadastrada em Conexões, clique Testar conexão antes de ativar.',
        'Envie uma mensagem de um destinatário de teste. Confira o recebimento no Wabotia, responda pelo painel e teste uma mídia.',
        'Confira os recibos de entrega/leitura. Uma entrega sem confirmação precisa de reconciliação antes de nova tentativa.',
    ])
    code('https://SUA_URL/webhooks/zernio-accounts/ID_DA_CONTA_LOCAL')
    p('Na conexão individual, use a URL /webhooks/zernio/ID_DA_CONEXAO. Não configure esses endereços diretamente na Meta: o remetente dos webhooks é a Zernio.')
    box('Texto livre exige mensagem do cliente nas últimas 24 horas. Fora dessa janela, use template aprovado com consentimento e autorização de possível cobrança. O contador local não substitui as faturas Zernio/Meta.')
    p(link('Mensagens e webhooks', 'https://docs.zernio.com/platforms/whatsapp/inbox') + ' · ' + link('Preços e custos', 'https://docs.zernio.com/platforms/whatsapp/pricing'), 'small')

    title(n + 2, 'Trocar ou excluir telefones')
    steps([
        'As conexões antigas da Meta ficam pausadas após a atualização. Cadastre o telefone pela Zernio e homologue o novo caminho.',
        'Para excluir, conclua ou reconcilie envios já iniciados, ligações e operações de grupos sem confirmação.',
        'Em Conexões ou Linhas, clique Excluir telefone e confirme. O Wabotia cancela envios ainda na fila e remove credenciais locais e vínculos de roteamento.',
        'O histórico de mensagens, conversas e protocolos é preservado. A exclusão no Wabotia não remove a conta na Zernio.',
    ])
    box('Ligações ao vivo no navegador não estão disponíveis nesta integração. Os registros históricos continuam acessíveis. Consulte as capacidades da conexão para os demais recursos.')
