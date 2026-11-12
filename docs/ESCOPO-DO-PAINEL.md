# Escopo e organização do painel

O Wabotia conecta o WhatsApp à operação de atendimento: recebe os números da conta Meta, direciona mensagens para pessoas ou bots, oferece menus e acompanha protocolos e avaliações. Também permite que sistemas externos usem linhas autorizadas e que a equipe atenda pelo Telegram. A configuração deve explicar essas tarefas em linguagem comum, com um assistente guiado e acesso aos detalhes pelo modo avançado.

Este documento descreve as capacidades verificadas no código e as dependências de configuração e homologação dos serviços externos.

## Navegação por tarefa

| Área | O que a pessoa encontra |
| --- | --- |
| Início | Situação do atendimento e próximos passos de configuração. |
| Atendimento | Conversas, ligações, grupos e protocolos. |
| Contatos | Cadastro, busca, importação e vínculo de clientes às conversas. |
| Equipe | Pessoas, disponibilidade e conversa interna. |
| Automação | Bot Atendente, especialistas, menus, conhecimento e regras de atendimento. |
| Canais | Conta Meta e números, destino de atendimento por linha, Hermes e Telegram. |
| Avaliações e relatórios | Notas, comentários e acompanhamento da operação. |
| Integrações | Aplicações externas, chaves e permissões de acesso. |
| Sistema | Instalação, atualizações e configuração da infraestrutura. |

O assistente de configuração tem um atalho próprio e conduz às mesmas configurações usadas pelo restante do painel. O modo avançado revela consentimentos, execuções, entregas, webhooks e detalhes técnicos. Ambos os modos devem compartilhar os mesmos dados; não são instalações nem configurações independentes.

Uma conexão identifica o serviço e guarda sua autorização. Uma linha é o número de WhatsApp recebido por essa conexão. O destino da linha define quem atende; o roteamento define quais números uma integração pode usar. Esses conceitos devem aparecer juntos em **Canais**, sem exigir que a pessoa recadastre credenciais em telas diferentes.

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

O JEV é opcional, controlado por `settings.jev_enabled` (padrão `false`). A chave é salva separadamente por `POST /api/v1/profiles/{profile}/jev`, com `{ "key": "..." }`. O fluxo é **Atendente → interpretação estruturada → decisão JEV → ação autorizada**. Após a consulta a um especialista, a resposta preparada pelo Atendente também passa pela decisão. Com JEV desligado, permanece o fluxo normal do Atendente. Ver [regras, limites e recuperação](JEV.md).

## Capacidades e lacunas verificadas

“Implementado” significa que há lógica e contrato no código; não substitui a homologação com as contas, números e serviços reais da instalação. “Parcial” indica que apenas parte do comportamento solicitado está disponível. “Pendente” indica ausência do fluxo solicitado.

| Função solicitada | Estado | O que existe e o que falta |
| --- | --- | --- |
| Conectar o WhatsApp e receber os números da conta | Implementado | Chave API e perfil Zernio, autorização pelo provedor, descoberta paginada, importação e webhook compartilhado. Exclusão local de telefone preserva histórico e cancela a fila não enviada. [Contas Zernio](../src/zernio-accounts.ts), [guia](ZERNIO-WHATSAPP.md). |
| Conectar bot ou pessoa a mensagens e ligações | Parcial | Mensagens têm destino por linha, fila humana e transferência para pessoa ou bot. Áudio de chamadas no navegador não está disponível pela Zernio; históricos anteriores são preservados. [Linhas](../src/line-service.ts), [atendimento](../src/service.ts), [ligações](../src/calls.ts). |
| Menus, ações rápidas, conteúdo e encaminhamento | Implementado | Botões/listas interativas Meta, texto nos demais canais, submenus, conteúdo, links, protocolos, avaliações, bots e setores. Respeita linha, sessão e validade da apresentação. [Guia](MENUS-PROTOCOLOS.md). |
| Protocolo com prazo e consulta pelo cliente | Implementado | Consulta por número completo e telefone verificado entre conversas do mesmo perfil, pelo cliente, menu, bot ou pessoa. Pesquisa no painel por protocolo/telefone. Prazo da primeira resposta e andamento público; notas internas não são enviadas. [Guia](MENUS-PROTOCOLOS.md). |
| Sistema de avaliações | Implementado | Pesquisa de 1 a 5 com comentário após encerramento, consulta de resultados e convite associado a aplicativo. Depende de habilitação nas configurações. [Pesquisa e leitura de respostas](../src/engine.ts), [encerramento](../src/service.ts), [consulta](../src/index.ts). |
| Roteamento para Vinki com janela de 24 horas e franquia | Implementado | Reserva atômica de franquia e opção de bloquear excedentes, aplicada no preset Vinki. Janela pertence ao número que recebeu a mensagem; remetente permanece fixo. Estimativa local não substitui a fatura Meta. [Regras operacionais](ROTEADOR.md). |
| Parear Vinki e Fagoo sem digitar credenciais ou tokens | Implementado | Código temporário com aprovação administrativa de perfil, permissões, números, grupos e bots. Troca automática entre servidores, armazenamento protegido e revogação. Exige instalar também as alterações dos clientes Vinki/Fagoo. [Guia](PAREAMENTO.md). |
| Contatos | Implementado | Cadastro, busca, edição, importação CSV e vínculo com conversas. Telefones não unem clientes automaticamente. [Contatos](../src/contacts.ts), [guia](CONTATOS.md). |
| Atualizações automáticas | Implementado | Ativação opcional, janela diária, publicação oficial verificada, bloqueio de concorrência e recuperação conservadora. Exige instalador direto e autorização Cloudflare configurada. QR e Hermes permanecem processos separados. [Guia](ATUALIZACOES.md). |
| Ponte WhatsApp–Telegram | Implementado | Encaminhamento para tópicos, mensagens e anexos, presença, assumir conversa e transferir atendimento. Exige bot dedicado, grupo privado com tópicos e usuários autorizados. [Webhook Telegram](../src/index.ts), [validação da conexão](../src/integrations.ts), [entrega à equipe](../src/engine.ts). |
| JEV opcional e especialistas internos Hermes | Implementado | Atendente interpreta e propõe; JEV decide antes da ação. Respostas incertas ou indisponibilidade encaminham à equipe humana. As APIs e credenciais de sistemas precisam estar configuradas nos especialistas Hermes. [Guia](JEV.md). |

## Limites da configuração guiada

O assistente pode orientar o cadastro, testar conexões, descobrir números e bots, escolher destinos e salvar opções existentes. Ele deve distinguir “configurado” de “testado” e indicar quais passos dependem do serviço externo. Ter um formulário preenchido não comprova que um webhook recebe mensagens, que o especialista pode emitir um boleto ou que a Meta habilitou ligações para a conta.

O modo avançado mantém acesso aos contratos e registros necessários para diagnóstico. Ele não deve ser requisito para configurar tarefas comuns, nem dar a entender que funções pendentes já existem. Veja também [linhas, menus e equipe](ATENDIMENTO-EQUIPE.md), [API](API.md) e [validação](VALIDACAO.md).
