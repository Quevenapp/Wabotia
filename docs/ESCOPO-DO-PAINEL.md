# Escopo e organização do painel

O Wabotia conecta o WhatsApp à operação de atendimento: recebe os telefones pela integração Zernio, direciona mensagens para pessoas ou bots, oferece menus e acompanha protocolos e avaliações. Também permite que sistemas externos usem linhas autorizadas. A configuração deve explicar essas tarefas em linguagem comum, com um assistente guiado e os detalhes técnicos sempre à mão em Gestão.

Este documento descreve as capacidades verificadas no código e as dependências de configuração e homologação dos serviços externos.

Cada instalação possui uma **Área de atendimento** da empresa, criada automaticamente e compartilhada pela equipe. As pessoas acessam o mesmo atendimento com suas próprias contas e permissões; não precisam criar uma área pessoal para começar. Instalações com áreas existentes preservam seus dados e controles de acesso.

## Navegação por tarefa

A partir da 0.14.0 o painel tem a mesma organização dos aplicativos (desenho em [`web/DESIGN.md`](../web/DESIGN.md)). Um trilho à esquerda leva às áreas de quem atende, **Conversas**, **Protocolos**, **Equipe**, **Ligações** e **Contatos**, e a **Gestão**, que reúne as áreas de administração abaixo. Em telas estreitas o trilho vira uma barra de abas, como no aplicativo.

| Área | O que a pessoa encontra |
| --- | --- |
| Conversas | Lista com prévia, não lidas e relógio da janela de 24 horas; conversa com assumir, transferir e dados do contato. |
| Protocolos | Cartões com estado, categoria, responsável e prazo; detalhe com linha do tempo. |
| Equipe | Presença, pessoas, bots, setores e conversa interna. |
| Ligações | Histórico e tela da ligação. |
| Contatos | Cadastro, busca, importação e vínculo de clientes às conversas. |
| Gestão → Início | Situação do atendimento e próximos passos de configuração. |
| Gestão → Pessoas e acessos | Contas e permissões da equipe. |
| Gestão → Automação | Bot Atendente, especialistas, menus, modelos de atendimento, conhecimento e regras de atendimento. |
| Canais | Integração Zernio, Telefones, destino de atendimento por linha e Hermes. |
| Avaliações e relatórios | Notas, comentários e acompanhamento da operação. |
| Integrações | Aplicações externas, chaves e permissões de acesso. |
| Sistema | Instalação, atualizações e configuração da infraestrutura. |

O assistente de configuração tem um atalho próprio e conduz às mesmas configurações usadas pelo restante do painel. O painel tem um único modo: consentimentos, execuções, entregas, webhooks e identificadores técnicos aparecem sempre em Gestão. O antigo modo simplificado, que os escondia, foi removido.

Uma conexão identifica o serviço e guarda sua autorização. **Integração Zernio** reúne a autorização do provedor; **Telefones** reúne os números de WhatsApp disponíveis. O destino de cada linha define quem atende; o roteamento define quais números uma integração pode usar. Esses conceitos devem aparecer juntos em **Canais**, sem exigir que a pessoa recadastre credenciais em telas diferentes.

## Atendente e especialistas Hermes

O Bot Atendente conversa com o cliente. Para uma operação de sistema, ele seleciona uma ação interna autorizada e consulta o especialista correspondente pelo Hermes. O especialista acessa a API do sistema e devolve o resultado ao Atendente, que prepara a resposta ao cliente.

```text
Cliente no WhatsApp
        ↓
Wabotia → Bot Atendente no Hermes
                  ↓ consulta interna autorizada
          Bot especialista no Hermes
                  ↓ credenciais do sistema
             API do Fagoo, Vinki ou outro sistema
                  ↓ resultado
          Especialista → Atendente → Cliente
```

Por exemplo, a ação “segunda via de boleto” pode consultar um bot financeiro que já tem acesso à API do Fagoo. As credenciais financeiras pertencem ao especialista e à sua configuração no Hermes. O Wabotia guarda as credenciais necessárias para chamar o Hermes, a lista de especialistas autorizados e as condições de uso; cadastrar uma ação no painel não instala uma integração financeira no bot.

O contrato existente usa `settings.attendant_bot` e `settings.capabilities`. Cada ação interna identifica o bot, a condição e as instruções. O especialista recebe a solicitação e o telefone do cliente; seu resultado volta a uma execução do Atendente. Ver [execução e consulta de especialistas](../src/engine.ts), [validação das configurações](../src/service.ts) e [conexão Hermes](../src/integrations.ts).

O Atendente também pode ser um bot de **provedor de IA direto** (Anthropic, OpenAI, DeepSeek ou API compatível), sem Hermes nem servidor próprio. Ele conversa e decide as mesmas ações do Atendente, mas não tem ferramentas: não pode ser especialista nem item de menu do tipo bot, e o painel o oculta nesses seletores. Ver [Bot por provedor de IA](PROVEDOR-IA.md).

O JEV é opcional, controlado por `settings.jev_enabled` (padrão `false`). A chave é salva separadamente por `POST /api/v1/profiles/{profile}/jev`, com `{ "key": "..." }`. O fluxo é **Atendente → interpretação estruturada → decisão JEV → ação autorizada**. Após a consulta a um especialista, a resposta preparada pelo Atendente também passa pela decisão. Com JEV desligado, permanece o fluxo normal do Atendente. Ver [regras, limites e recuperação](JEV.md).

## Capacidades e lacunas verificadas

“Implementado” significa que há lógica e contrato no código; não substitui a homologação com as contas, números e serviços reais da instalação. “Parcial” indica que apenas parte do comportamento solicitado está disponível. “Pendente” indica ausência do fluxo solicitado.

| Função solicitada | Estado | O que existe e o que falta |
| --- | --- | --- |
| Conectar o WhatsApp e receber os telefones | Implementado | Chave API e Profile ID da integração Zernio, autorização pelo provedor, descoberta paginada, importação e webhook compartilhado. Exclusão local de telefone preserva histórico e cancela a fila não enviada. [Integração Zernio](../src/zernio-accounts.ts), [guia](ZERNIO-WHATSAPP.md). |
| Conectar bot ou pessoa a mensagens e ligações | Parcial | Mensagens têm destino por linha, fila humana e transferência para pessoa ou bot. Áudio de chamadas no navegador não está disponível pela Zernio; históricos anteriores são preservados. [Linhas](../src/line-service.ts), [atendimento](../src/service.ts), [ligações](../src/calls.ts). |
| Menus, ações rápidas, conteúdo e encaminhamento | Implementado | Botões/listas interativas Meta, texto nos demais canais, submenus, conteúdo, links, protocolos, avaliações, bots e setores. Respeita linha, sessão e validade da apresentação. [Guia](MENUS-PROTOCOLOS.md). |
| Protocolo com prazo e consulta pelo cliente | Implementado | Consulta por número completo e telefone verificado entre conversas da mesma área de atendimento, pelo cliente, menu, bot ou pessoa. Pesquisa no painel por protocolo/telefone. Prazo da primeira resposta e andamento público; notas internas não são enviadas. [Guia](MENUS-PROTOCOLOS.md). |
| Sistema de avaliações | Implementado | Pesquisa de 1 a 5 com comentário após encerramento, consulta de resultados e convite associado a aplicativo. Depende de habilitação nas configurações. [Pesquisa e leitura de respostas](../src/engine.ts), [encerramento](../src/service.ts), [consulta](../src/index.ts). |
| Roteamento para Vinki com janela de 24 horas | Implementado | Sem teto local de mensagens; Vinki continua restrito a respostas sem template. Janela renovada pela última mensagem recebida no mesmo telefone; remetente fixo. Totais mensais de mensagens entregues por categoria. [Regras operacionais](ROTEADOR.md). |
| Parear Vinki e Fagoo sem digitar credenciais ou tokens | Fora do painel desde a 0.18.0; vínculos existentes seguem ativos e podem ser revogados | Código temporário com aprovação administrativa da área de atendimento, permissões, telefones, grupos e bots. Troca automática entre servidores, armazenamento protegido e revogação. Exige instalar também as alterações dos clientes Vinki/Fagoo. [Guia](PAREAMENTO.md). |
| Contatos | Implementado | Cadastro, busca, edição, importação CSV e vínculo com conversas. Telefones não unem clientes automaticamente. [Contatos](../src/contacts.ts), [guia](CONTATOS.md). |
| Atualizações automáticas | Implementado | Ativação opcional, janela diária, publicação oficial verificada, bloqueio de concorrência e recuperação conservadora. Exige instalador direto e autorização Cloudflare configurada. QR e Hermes permanecem processos separados. [Guia](ATUALIZACOES.md). |
| Ponte WhatsApp–Telegram | Removido | A equipe atende pelo painel e pelos aplicativos. Conexões Telegram antigas só podem ser excluídas; o webhook responde `410 telegram_removed`. |
| Bot sem servidor, direto no provedor de IA | Implementado | Conexão `ai` com Anthropic (SDK oficial), OpenAI, DeepSeek ou API compatível; um bot por conexão, como Atendente, bot de linha, transferência e conversa com a equipe. Sem ferramentas, arquivos ou transcrição de áudio; opção "apenas mensagens" para áudio e vídeo. Não validado ainda contra as APIs reais. [Guia](PROVEDOR-IA.md). |
| JEV opcional e especialistas internos Hermes | Implementado | Atendente interpreta e propõe; JEV decide antes da ação. Respostas incertas ou indisponibilidade encaminham à equipe humana. As APIs e credenciais de sistemas precisam estar configuradas nos especialistas Hermes. [Guia](JEV.md). |

## Limites da configuração guiada

O assistente pode orientar o cadastro, testar conexões, descobrir números e bots, escolher destinos e salvar opções existentes. Ele deve distinguir “configurado” de “testado” e indicar quais passos dependem do serviço externo. Ter um formulário preenchido não comprova que um webhook recebe mensagens, que o especialista pode emitir um boleto ou que a Meta habilitou ligações para a conta.

O painel mantém acesso aos contratos e registros necessários para diagnóstico. Eles não devem ser requisito para configurar tarefas comuns, nem dar a entender que funções pendentes já existem. Veja também [linhas, menus e equipe](ATENDIMENTO-EQUIPE.md), [API](API.md) e [validação](VALIDACAO.md).
