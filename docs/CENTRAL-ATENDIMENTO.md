# Central de atendimento por modelo (versão 0.14.0)

Este documento define o que o Wabotia 0.14.0 acrescenta para que uma instalação possa ser configurada como uma **central única de atendimento para vários aplicativos**: ajuda gratuita pelo bot, protocolo gratuito com prazo em dias úteis, serviços pagos apresentados no menu e acompanhamento por estados. É o contrato comum do servidor, do painel web e dos aplicativos móveis.

Nada aqui muda o comportamento de quem não usa os recursos novos: todos os campos são opcionais e os padrões preservam o que a 0.13 fazia.

## 1. Prazo do protocolo em dias úteis

Configurações do perfil (`PUT /api/v1/profiles/{p}/settings`, administrador):

| Campo | Tipo | Padrão | Significado |
|---|---|---|---|
| `protocol_response_unit` | `"hours"` ou `"business_days"` | `"hours"` | Como contar o prazo da primeira resposta humana. |
| `protocol_response_hours` | número ou `null` | `24` | Já existia. Usado quando a unidade é `hours`. `null` = sem prazo. |
| `protocol_response_days` | inteiro de 1 a 60 | `3` | Usado quando a unidade é `business_days`. |
| `business_hours.days` | lista de 0 a 6 (0 = domingo) | `[1,2,3,4,5]` | Dias de atendimento humano. |
| `business_hours.start` / `end` | `"HH:MM"` | `"09:00"` / `"18:00"` | Horário de atendimento, no horário de Brasília. |
| `business_hours.holidays` | lista de `"AAAA-MM-DD"` (até 100) | `[]` | Dias sem atendimento. |

Regra de cálculo com `business_days` (função pura `protocolDueAt(agora, config)` em `src/business-time.ts`, sempre em `America/Sao_Paulo`, UTC−3 sem horário de verão):

1. Ponto de partida: o momento da abertura, se cair dentro do horário de atendimento de um dia útil. Fora dele, a próxima abertura (`start` do próximo dia útil).
2. Prazo: a mesma hora do relógio, N dias úteis depois do ponto de partida. Feriados e dias fora de `days` não contam.
3. Exemplos com seg–sex 09:00–18:00 e 3 dias: aberto terça 14:00 vence sexta 14:00; aberto sábado 10:00 parte de segunda 09:00 e vence quinta 09:00; aberto sexta 19:30 parte de segunda 09:00 e vence quinta 09:00.

`response_due_at` continua sendo o campo do protocolo; só muda como ele é calculado na abertura. Alterar a configuração não recalcula protocolos já abertos.

Validação ao salvar: `days` tem de um a sete valores sem repetição, `start` precisa ser anterior a `end` (o atendimento vai de `start` inclusive até `end` exclusive: aberto exatamente às 18:00 já parte da próxima abertura) e `holidays` não repete datas. `business_hours` aceita envio parcial: as chaves omitidas mantêm o valor salvo.

## 2. Estados do protocolo

`tickets.status` passa a aceitar seis valores. Os três antigos continuam válidos e com o mesmo significado.

| Valor | Para a equipe | Para o cliente | Ativo |
|---|---|---|---|
| `open` | Recebido | Recebido | sim |
| `in_progress` | Em análise | Em análise | sim |
| `waiting_customer` | Aguardando cliente | Aguardando você | sim |
| `waiting_third` | Aguardando terceiro | Aguardando atualização | sim |
| `resolved` | Resolvido | Resolvido | não |
| `closed` | Encerrado | Encerrado | não |

- **Ativo** = não é `resolved` nem `closed`. Toda regra que hoje usa "não está fechado" (um protocolo ativo por conversa na abertura automática, alertas de prazo, filtro de atrasados, responsável ao assumir, marcação da primeira resposta) passa a usar "ativo".
- `PATCH /tickets/{id}` aceita qualquer transição entre os seis estados, com as permissões atuais.
- Quando o cliente envia mensagem em uma conversa com protocolo em `waiting_customer`, esse protocolo volta sozinho para `in_progress` e gera `ticket.updated` com `actor: "system"`, `reason: "customer_message"`, `conversation_id` e `message_id`, além dos campos habituais. Uma mensagem repetida pelo provedor não gera um segundo evento.
- `GET /tickets` aceita `status` com qualquer dos seis valores e o novo filtro `active=1`. `status` também aceita uma lista separada por vírgulas, combinada com OU (por exemplo `status=waiting_customer,waiting_third` ou `status=resolved,closed`); cada item é validado contra os seis valores e qualquer outro retorna 400. Um valor único funciona como antes. `overdue=1` passa a considerar só protocolos ativos. `status`, `active`, `category`, `overdue` e `q` se combinam.
- O prazo (`response_due_at`) só pode ser alterado enquanto o protocolo está ativo e sem primeira resposta.
- Nas notificações dos aplicativos e na consulta do cliente, os três estados antigos passam a usar os textos desta tabela (antes: Aberto, Em andamento, Concluído).
- A consulta do cliente (`protocols`) usa os textos da coluna "Para o cliente".
- Clientes antigos que só conhecem três estados continuam funcionando; estados desconhecidos devem ser exibidos como texto neutro.

## 3. Categoria do protocolo (aplicativo ou assunto)

- Configuração `ticket_categories`: lista de até 50 `{ "id": "printher", "name": "Printher", "enabled": true }` (`id` no formato `[a-zA-Z0-9_-]{1,100}`, único).
- `tickets.category` (texto, opcional): `id` de uma categoria habilitada. `POST /tickets` e `PATCH /tickets/{id}` aceitam `category` (string ou `null`); valor desconhecido ou de categoria desabilitada é recusado com 400. Reenviar no `PATCH` o valor já gravado é aceito mesmo depois de a categoria ter sido removida.
- `ticket.created` inclui `category` quando houver; `ticket.updated` inclui `category` e `previous_category` quando o pedido altera a categoria.
- `GET /tickets` aceita o filtro `category`. A consulta do cliente mostra "Aplicativo: {nome}" quando houver.
- Remover uma categoria da configuração não altera protocolos antigos; eles mostram o `id` gravado. Uma categoria usada por um destino de menu "Abrir protocolo" só pode ser removida depois de o destino ser alterado.

## 4. Mensagem de confirmação do protocolo

Configuração `protocol_confirmation` (texto, até 1500 caracteres). Marcadores: `{numero}`, `{assunto}`, `{aplicativo}`, `{prazo}`. Padrão:

```
Sua solicitação foi registrada.

Protocolo: {numero}
Aplicativo: {aplicativo}
Assunto: {assunto}

Primeira resposta da equipe: até {prazo}, no horário de Brasília.

Vamos analisar o que você informou. Se precisarmos de mais detalhes, entraremos em contato por este atendimento. A previsão de solução será informada após a análise.

Para acompanhar, envie MEUS PROTOCOLOS.
```

- `{prazo}` vira data e hora concretas ("14/11/2026 às 14:00"). Linhas cujo marcador não tem valor (sem categoria, sem prazo) são omitidas inteiras.
- A confirmação é enviada sempre que um protocolo é aberto **para o cliente**: equipe ausente no encaminhamento, destino de menu "Abrir protocolo", palavra PROTOCOLO e ação do bot. Na ausência da equipe, `absence_instructions` continua vindo antes. Quando o encaminhamento reaproveita o protocolo ativo da conversa, nenhum protocolo é aberto: o cliente recebe as instruções de ausência e a linha curta da 0.13 com o número, sem a confirmação.
- Texto em branco restaura o padrão. Linhas em branco que sobram depois de omitir uma linha são reduzidas a uma.
- Protocolo aberto por atendente pelo painel ou pelos aplicativos não envia confirmação automática.

### Saudação do menu principal

Configuração `menu_greeting` (texto, até 900 caracteres; vazio por padrão). Quando preenchida, substitui "Como podemos ajudar?" na abertura do **menu principal**, tanto na lista interativa quanto no menu numerado em texto. Submenus continuam usando o próprio título. O limite deixa espaço para a linha "Escolha uma opção abaixo." dentro dos 1024 caracteres do corpo de uma mensagem interativa do WhatsApp.

### Menu como porta de entrada sem bot (0.14.1)

Com um bot respondendo, o menu automático abre só quando o cliente envia uma saudação sozinha (`oi`, `olá`, `bom dia`, `boa tarde`, `boa noite`, `tudo bem`) ou `MENU`; o resto vai para o bot. Quando **nenhum bot vai responder**, a mensagem que abre o atendimento mostra o menu principal, seja qual for o texto, em vez de ir direto para a fila.

"Nenhum bot vai responder" significa: a linha está em atendimento humano, o número não permite bots, não há Bot Atendente, ou ele não está habilitado para a linha. Valem as demais condições do menu automático: atendimento ativo, conversa individual, menu da linha em `automatic` e pelo menos uma opção disponível.

- O menu não se repete enquanto um menu mostrado na mesma sessão estiver dentro de 24 horas. O texto livre seguinte segue o caminho normal: fila de atendimento (com a mensagem de encaminhamento ou de ausência e protocolo) ou, na linha em atendimento humano, a conversa que já está na fila.
- Na linha em atendimento humano, só a mensagem que coloca a conversa na fila mostra o menu. A conversa continua na fila enquanto o cliente escolhe.
- Pedido explícito de atendente (`atendente`, `humano`) continua indo direto para a fila, sem menu.
- A área pode ser ativada sem Bot Atendente e sem linha configurada quando existe ao menos uma opção habilitada e automática no menu principal.

## 5. Abrir protocolo pelo cliente

- Novo destino de menu `type: "ticket"` ("Abrir protocolo"), com `category_id` opcional e `content` opcional (pergunta de até 3500 caracteres; padrão "Descreva em uma mensagem o que você precisa. Se puder, diga o que tentou e o que aconteceu."). O sistema acrescenta "Para cancelar, envie MENU." Uma categoria desabilitada depois de salvar o destino é ignorada na abertura.
- Palavras do cliente que disparam o mesmo fluxo em conversa individual, fora de pesquisa pendente: `PROTOCOLO`, `ABRIR PROTOCOLO`, `NOVO PROTOCOLO` (sem diferenciar maiúsculas e acentos). `MEUS PROTOCOLOS` e `CONSULTAR PROTOCOLO` continuam sendo consulta.
- Fluxo: o sistema envia a pergunta e marca a conversa como aguardando a descrição por até 30 minutos. A próxima mensagem de texto do cliente vira o título do protocolo (até 300 caracteres; o texto completo entra como primeiro andamento público, com `actor: "customer"`). `MENU` ou `VOLTAR` cancelam. Depois o cliente recebe a confirmação da seção 4.
- Enquanto a pergunta está aberta: `MENU`/`VOLTAR` respondem "Abertura de protocolo cancelada." e reapresentam o menu quando a linha tem um (`VOLTAR` mostra o nível em que o cliente estava); `MEUS PROTOCOLOS`, `CONSULTAR PROTOCOLO`, um número de protocolo sozinho ou o toque em um botão deixam a pergunta e seguem o caminho normal; `PROTOCOLO` de novo repete a pergunta; uma mensagem sem texto recebe um lembrete e a pergunta continua aberta.
- "Fora de pesquisa pendente": uma resposta de nota (1 a 5) continua sendo da pesquisa. Ao fazer a pergunta do protocolo, a pesquisa pendente é cancelada, como já acontece com `MENU`, para que uma descrição iniciada por número não vire nota. Pedir uma avaliação depois, ou uma pessoa assumir a conversa, encerra a pergunta do protocolo.
- As palavras valem em qualquer estado da conversa (bot, fila ou atendimento humano), como a consulta de protocolos, desde que a automação da área esteja ativa. Uma pergunta já feita ainda é respondida se a automação for pausada em seguida.
- A conversa expõe `ticket_prompt_expires_at` (Unix em milissegundos ou `null`): enquanto for futuro, ela aguarda a descrição. `ticket_prompt_category`, `ticket_prompt_session` e `ticket_prompt_source` são internos.
- Repetir o processamento da mesma mensagem não cria um segundo protocolo: `tickets.source_key` guarda a origem (`inbox:…` aberto pelo cliente, `run:…` aberto pelo bot, `null` nos demais).
- Bot: a ação estruturada `ticket` (`text` com o pedido, `category_id` com uma categoria da lista `categories` recebida, ou `null`) abre o mesmo protocolo, sem responsável e sem mudar a conversa de estado, e envia a confirmação. O texto do bot entra como primeiro andamento público, com `actor: "bot:<id>"`. Com JEV ligado, a ação precisa ser aprovada como as demais.
- A conversa **não** vai para a fila humana e o responsável não muda: o protocolo é análise assíncrona. Ele aparece em Protocolos como Recebido, sem responsável.
- Como o cliente pediu explicitamente, um novo protocolo é sempre criado, mesmo que a conversa já tenha outro ativo. A regra de um protocolo ativo por conversa continua valendo só para a abertura automática (equipe ausente).
- O destino só aparece em linhas com permissão de serviço, como `protocols` e `survey`, e não existe em grupos. As palavras seguem a mesma regra e exigem menus ou bots habilitados na linha.

## 6. Prévia da última mensagem na lista de conversas

`GET /conversations` passa a devolver em cada linha `last_message`: `{ "text", "direction", "created", "delivery_status", "attachments" (quantidade), "kind" }` ou `null`. `kind` resume o conteúdo (`text`, `image`, `video`, `audio`, `document`, `location`, `contacts`, `sticker`, `interactive`). `text` vem limitado aos primeiros 300 caracteres; `direction` é `customer`, `outbound` ou `note`; `delivery_status` é vazio, `sent`, `delivered`, `read`, `played` ou `failed`. Notas internas só entram para quem pode ler notas (sessão de pessoa ou aplicação com `notes:read`); para os demais, a prévia é a mensagem anterior que não é nota. Painel e aplicativos usam esse campo como prévia; a contagem de não lidas continua local em cada cliente.

## 7. Modelos de central

Modelos prontos que preenchem menus, setores, categorias, prazo e textos de uma vez.

- `GET /api/v1/service-templates` (pessoa autenticada por cookie ou token `wabu_`; chave de aplicação recebe 403): devolve `{ "data": [modelo] }`. Cada modelo tem `id`, `name`, `description`, `summary` (uma frase), `settings` (o conteúdo completo para pré-visualização, com as mesmas chaves de `PUT /settings`: `departments`, `ticket_categories`, `menus`, `protocol_response_unit`, `protocol_response_days`, `business_hours`, `instructions`, `protocol_confirmation`, `menu_greeting`) e `manual_steps` (lista de textos com o que o modelo não configura). Nos menus, os destinos de bot vêm com `bot_id: null` e `fallback_content`, a mensagem usada quando a área não tem bot.
- `POST /api/v1/profiles/{p}/service-templates/{id}/apply` (administrador, com `Idempotency-Key`), corpo `{ "mode": "merge" | "replace", "bot_id": "..."? }`:
  - `merge` (padrão): acrescenta setores, categorias e ramos de menu que ainda não existem (comparação por `id`); não altera nem remove o que já existe; textos e prazos só são gravados se o campo ainda estiver no padrão.
  - `replace`: substitui menus, setores, categorias, prazo, horário e textos (`instructions`, `protocol_confirmation` e `menu_greeting`) pelos do modelo. Conversas e protocolos existentes não são tocados. As pessoas já colocadas em um setor do modelo e a lista de feriados são mantidas, porque não fazem parte do modelo.
  - Resposta: `{ template_id, mode, bot_id, created, kept, replaced, removed, skipped, pending }`. Os cinco grupos têm a forma `{ departments: [id], categories: [id], menus: [id], settings: [campo] }`; `replaced` e `removed` só são preenchidos no `replace`, e `skipped.menus` lista opções que o `merge` não criou porque o item pai, com o mesmo `id`, existe e não é um submenu. `pending` é a lista do que ainda precisa de ação do administrador: itens `{ code, message }`, alguns com `department_id` ou `bot_id` (por exemplo, `department_members`: "Adicione pessoas ao setor Suporte e protocolos…").
  - A aplicação passa pela mesma validação de `PUT /settings`; se ela recusar (por exemplo, mais de 200 itens de menu), nada é gravado. Modelo desconhecido retorna 404.
  - No `merge`, o prazo só é gravado quando unidade, horas, dias e horário ainda estão no padrão, e `instructions` e `menu_greeting` só quando estão vazios.
- Setores são criados sem membros. Destinos de bot usam `bot_id` informado, senão o atendente do perfil (`attendant_bot`), senão o primeiro bot habilitado; sem bot nenhum, viram mensagens informativas que orientam a descrever a dúvida ou abrir protocolo.
- Todos os `id` do modelo têm prefixo próprio, para conviver com itens criados à mão: `central-setor-…` nos setores, `central-cat-…` nas categorias e `central-menu-…` nos menus.
- Um bot informado em `bot_id` precisa pertencer à área; se estiver desabilitado, as opções são criadas e `pending` avisa para habilitá-lo.

### Modelo `central-aplicativos`

Central única para vários aplicativos, com quatro modalidades de atendimento: ajuda gratuita, suporte avulso, implantação e treinamento, plano mensal.

- **Setores:** Suporte e protocolos; Clientes com contrato; Comercial e serviços; Compras e licenças.
- **Categorias:** Pixel Goods; Quall Studio; NFS-e Leve; Printher; Wabotia; Fagoo ERP; Vinki; Servidor ou integração; Outro ou não sei.
- **Prazo:** 3 dias úteis, segunda a sexta, 09:00–18:00.
- **Saudação** (`menu_greeting`): apresenta o assistente virtual, lembra que a pessoa pode escrever o nome do aplicativo e o que precisa, e que PROTOCOLO registra uma solicitação para a equipe.
- **Menu principal:**
  1. **Ajuda gratuita** (submenu): um destino por aplicativo, mais "Servidor ou integração" e "Não sei qual aplicativo", todos encaminhando ao bot atendente; por último "Abrir protocolo".
     Os rótulos têm no máximo 20 caracteres, para caber com o número na linha de 24 caracteres das listas do WhatsApp. Por isso alguns são mais curtos que o nome do assunto: "Servidor/integração", "Não sei qual app", "Implantação e treino", "Ativar ou restaurar" e "Problema com compra". As categorias mantêm os nomes completos.
  2. **Meus protocolos** (consulta).
  3. **Já tenho contrato** (equipe humana, setor Clientes com contrato).
  4. **Contratar serviços** (submenu): Suporte avulso (atendimento agendado e o que é combinado antes de contratar), Implantação e treinamento (as cinco etapas e o acompanhamento posterior), Plano mensal (suporte mensal e suporte com administração) e "Falar com a equipe" (setor Comercial e serviços).
  5. **Compras e licenças** (submenu): Recursos pagos (Pixel Goods Maker e Printher, R$ 19,90 em pagamento único cada), Ativar ou restaurar compra (mensagens informativas) e "Problema com pagamento ou liberação" (abre protocolo gratuito).
  6. **Conhecer aplicativos** (submenu): uma mensagem por aplicativo, com os assuntos em que a central ajuda.
- **Orientações ao atendente virtual** (`instructions`): aproveitar o que a pessoa já disse; identificar aplicativo e objetivo; orientação curta com passos, um vídeo e um artigo no máximo; confirmar se resolveu; no máximo duas tentativas antes de oferecer protocolo; nunca exigir contratação para registrar um problema; compra não reconhecida vai direto para protocolo; relato de defeito é sempre gratuito; reconhecer falha conhecida sem repetir tutoriais; oferecer os próximos caminhos quando a pessoa pedir protocolo ou atendente; resumir o caso ao encaminhar; pedir que senhas e tokens sejam ocultados em imagens.

Os textos das mensagens informativas são um ponto de partida e devem ser revisados pelo administrador em **Menus e ações**.

### O que o modelo não configura

- Vínculo entre cliente e contrato ou plano: "Já tenho contrato" encaminha para uma fila humana; a identificação é feita pela equipe.
- Base de conhecimento, vídeos e artigos: cadastre em **Conhecimento**.
- Aviso fora da janela de 24 horas: depende de um modelo de mensagem aprovado no WhatsApp, enviado pela Integração Zernio. Sem ele, o andamento do protocolo fica na fila e chega quando o cliente escrever de novo.
- Preços, escopo e duração dos serviços pagos: edite os textos do submenu "Contratar serviços".

## 8. Compatibilidade e migração

- Migração aditiva `0016_service_center.sql`: `tickets.category`, `tickets.source_key`, estado de "aguardando descrição do protocolo" na conversa (`ticket_prompt_expires_at`, `ticket_prompt_category`, `ticket_prompt_session`, `ticket_prompt_source`) e índices necessários. Nenhum dado é alterado.
- OpenAPI, `docs/API.md` e `docs/MENUS-PROTOCOLOS.md` descrevem os campos novos.
- Aplicativos 0.13 continuam funcionando com o servidor 0.14; os aplicativos 0.14 mostram os seis estados e a categoria.
