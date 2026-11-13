# Integração com a API v1

O contrato está em `/api/openapi.json` e o explorador de consultas em `/api-docs`. Use chaves somente no backend do seu sistema. O administrador cadastra a aplicação em **API e integrações**, define as permissões e os bots da área de atendimento, depois emite uma chave. Guarde-a imediatamente. Para rotacionar, emita outra chave, atualize o integrador e revogue a anterior.

## Área de atendimento da instalação

Uma instalação nova cria automaticamente sua área de atendimento, compartilhada pela equipe e com automação inicialmente desativada. Os nomes técnicos `profiles`, `profile_id` e os parâmetros das rotas permanecem no contrato por compatibilidade; eles identificam a **Área de atendimento** exibida no painel. Use `GET /api/v1/profiles` para consultar as áreas autorizadas.

`POST /api/v1/installation/area/bootstrap` prepara a área quando o banco ainda não tem nenhuma. Exige sessão humana de administrador, por cookie do painel ou Bearer `wabu_`; chaves de aplicação são recusadas. Não exige corpo nem `Idempotency-Key`. Retorna `200` com `{created:boolean,profile_id:string|null}`: quando cria, devolve `created:true` e o ID; quando já existe alguma área, devolve `created:false` e `profile_id:null`. Nesse caso, consulte novamente a lista autorizada.

Repetir a chamada, inclusive simultaneamente, não cria áreas adicionais. Instalações antigas preservam suas áreas, seus dados e suas permissões de acesso. A operação não une áreas nem escolhe uma área legada em nome do usuário.

## Identidade e autorização

`Authorization: Bearer SUA_CHAVE` autentica a aplicação. Ela não escolhe o autor por `actor`, `user_id` ou campos semelhantes: a identidade vem da chave. Cada cliente externo é vinculado à aplicação; telefones informados não unem cadastros. Aplicações não acessam conversas externas de outras aplicações. Canais compartilhados seguem as permissões da área de atendimento. Notas internas precisam de `notes:read`; relatórios não contornam essa restrição. Somente contas humanas registram presença.

Permissões: `conversations:read/write`, `contacts:read/write`, `notes:read`, `tickets:read/write`, `knowledge:read/write`, `media:read/write`, `groups:manage`, `calls:read/write`, `routing:read/send/paid`, `reports:read`, `presence:read`, `bots:read/invoke`, `events:read`, `webhooks:manage`. O administrador também define requisições por minuto e execuções simultâneas. Cada chave possui expiração de até 365 dias.

Tokens com prefixo `wabu_` **não são chaves de aplicação**: são sessões humanas dos aplicativos Android e iOS, emitidas por `POST /api/auth/mobile/login` (fora de `/v1`) para uma pessoa cadastrada em **Pessoas**, com os mesmos acessos e papel do painel. Eles valem 30 dias, são renovados por `POST /v1/auth/mobile/refresh` e revogados por `POST /v1/logout`. As rotas de dispositivos (`/v1/devices`), de notificações (`/v1/system/push`, administrador) e o detalhe de protocolo `GET /profiles/{perfil}/tickets/{id}` com filtros `status` e `overdue` fazem parte do mesmo contrato; as de dispositivos e notificações aceitam somente sessão de usuário ou cookie do painel e respondem `403` a chaves de aplicação. Integrações servidor-servidor continuam usando chaves de aplicação; não use um token `wabu_` em um backend. Detalhes em [MOBILE.md](MOBILE.md).

## Roteador de números WhatsApp pela Zernio

Cada número retorna `policy` com `purpose`, `service`, `templates`, `human`, `api`, `menu`, `bots` e `pool`. As opções do número prevalecem sobre permissões de grupo/aplicação. Somente administrador humano pode alterá-las por `PUT /profiles/{perfil}/router/numbers/{id}/policy`, corpo `{"policy":{...}}` completo e `Idempotency-Key`. `403 number_policy_denied` indica capacidade desabilitada. A conferência ocorre no pedido e antes da entrega; uma restrição nova cancela envios ainda pendentes. Mensagens já enviadas ou sem confirmação não são repetidas nem movidas para outro número. O histórico e os eventos recebidos continuam disponíveis.

Consulte `GET /profiles/{perfil}/router` para números/grupos autorizados e contadores. Envie por `POST /profiles/{perfil}/router/messages`, com `number_id` **ou** `pool_id`, `to`, `external_id` estável e texto/anexo. Retorna `202` com `delivery_id`; consulte `GET /profiles/{perfil}/router/messages/{id}`. Somente uma entrega `pending` pode ser cancelada, por `POST /profiles/{perfil}/router/messages/{id}/cancel`. Todas as escritas exigem idempotência.

Atendimento exige janela real de 24 horas desde a última mensagem recebida do cliente no mesmo telefone. O roteador alterna novas entradas sem cotas locais e mantém o remetente do atendimento. `usage` retorna `delivered`, `service_delivered`, `utility_delivered`, `marketing_delivered`, `authentication_delivered` e `unclassified_delivered`, além de mês, fuso e início do acompanhamento. Contam somente mensagens com recibo de entrega/leitura; os antigos campos de saldo, limite e reserva foram removidos. Consulte templates com `GET /profiles/{profile}/router/numbers/{id}/templates`. Enviar templates exige `routing:paid`, origem autorizada, `allow_paid:true`, consentimento na categoria correta e aprovação consultada pela Zernio. A chave não escolhe o autor. Consulte o [guia do roteador](ROTEADOR.md). `sent` significa aceitação; não repita um resultado `unknown` em outro telefone.

## Repetição e erros

Toda operação de escrita recebe `Idempotency-Key`, com até 200 caracteres ASCII visíveis. Gere uma chave para cada intenção e mantenha a mesma chave, método, caminho e corpo se precisar repetir por falha de rede. O resultado registrado é devolvido com `Idempotency-Replayed: true`. Outro conteúdo sob a mesma chave retorna `409 idempotency_conflict`. Nunca gere outra chave automaticamente após timeout: a operação pode já ter sido aceita.

Respostas de erro usam `{"error":{"code":"...","message":"...","request_id":"..."}}` e cabeçalho `X-Request-Id`. `401` indica chave expirada/revogada, `403` permissão, `404` recurso fora do acesso, `409` conflito e `429` limite. Respeite `Retry-After`. IDs são opacos; datas são Unix em milissegundos.

Listas de conversas e recursos da área de atendimento usam `{data, next_cursor}`. Passe o cursor inalterado na consulta seguinte. Eventos usam `after` numérico e devolvem `cursor`, inclusive quando eventos não autorizados são omitidos. Áreas de atendimento e presença são listas diretas. Relatórios permitem `section`, `start`, `end` (YYYY-MM-DD, São Paulo), `cursor` e `limit`; `format=jsonl` exporta por streaming.

## Exemplo cURL

Configure variáveis no servidor, sem colocá-las em código público. Substitua os IDs pelos retornados pela API:

```sh
curl "$WABOTIA_URL/api/v1/profiles" -H "Authorization: Bearer $WABOTIA_KEY"
curl "$WABOTIA_URL/api/v1/profiles/$WABOTIA_PROFILE/conversations" \
 -H "Authorization: Bearer $WABOTIA_KEY" -H 'Content-Type: application/json' \
 -H 'Idempotency-Key: pedido-2026-0001' \
 --data '{"external_id":"cliente-do-meu-sistema","message_id":"msg-1","text":"Preciso de ajuda"}'
```

Use `/inbound` para novas mensagens do cliente. Para operar o atendimento, faça `POST /profiles/{perfil}/conversations/{id}/actions` com `{"action":"claim"}` e depois `{"action":"reply","text":"Como posso ajudar?"}`. Outras ações: `note`, `transfer` (target é ID de usuário autorizado), `tags`, `resolve` e `resume`. Assumir invalida inferências antigas. Respostas externas obedecem às mesmas janelas, consentimentos e templates do painel.

Abra um protocolo com `POST /profiles/{perfil}/tickets`, corpo `{"conversation_id":"ID","title":"Solicitação","category":"printher"}` (`category` é opcional). Atualize com `PATCH /profiles/{perfil}/tickets/{id}` e `status`, `text`, `owner`, `category` ou `response_due_at`. O prazo só é alterável antes da primeira resposta e enquanto o protocolo está ativo. Protocolos abertos pela API ou pelo painel não enviam confirmação automática ao cliente.

## Protocolos, prévia e modelos (0.14.0)

Todos os campos abaixo são aditivos e opcionais; clientes escritos para a 0.13 continuam funcionando. O contrato completo, com as regras de negócio, está em [Central de atendimento por modelo](CENTRAL-ATENDIMENTO.md).

### Estados, categoria e filtros

`status` aceita seis valores: `open` (Recebido), `in_progress` (Em análise), `waiting_customer` (Aguardando cliente), `waiting_third` (Aguardando terceiro), `resolved` (Resolvido) e `closed` (Encerrado). **Ativo** é todo protocolo que não está `resolved` nem `closed`. `PATCH` aceita qualquer transição, com as permissões de sempre. Exiba um estado desconhecido como texto neutro: valores novos podem surgir.

Quando o cliente envia mensagem em uma conversa com protocolo em `waiting_customer`, o protocolo volta para `in_progress` e gera `ticket.updated` com `actor: "system"`, `reason: "customer_message"`, `conversation_id` e `message_id`, além dos campos habituais.

Cada protocolo traz `category` (o `id` de uma categoria de `ticket_categories`, ou `null`) e `source_key` (`inbox:…` quando aberto pelo cliente, `run:…` quando aberto pelo bot, `null` quando aberto pela equipe ou na ausência dela). `POST` e `PATCH` aceitam `category` como texto ou `null`; um valor que não é uma categoria habilitada retorna `400`. Reenviar no `PATCH` o valor já gravado é aceito mesmo depois de a categoria ter sido removida das configurações. `ticket.created` inclui `category` quando houver; `ticket.updated` inclui `category` e `previous_category` quando o pedido altera a categoria.

`GET /profiles/{perfil}/tickets` aceita, além de `q`, `cursor` e `limit`:

| Parâmetro | Efeito |
|---|---|
| `status` | Um dos seis estados, ou uma lista separada por vírgulas combinada com OU (`status=resolved,closed`); qualquer outro valor retorna `400`. |
| `active=1` | Somente protocolos ativos. |
| `category` | Somente protocolos com esse `id` de categoria. |
| `overdue=1` | Protocolos ativos com o prazo da primeira resposta vencido e sem resposta. |

Os filtros se combinam.

### Configurações

`PUT /profiles/{perfil}/settings` (administrador) aceita também:

| Campo | Tipo | Padrão |
|---|---|---|
| `protocol_response_unit` | `"hours"` ou `"business_days"` | `"hours"` |
| `protocol_response_days` | inteiro de 1 a 60 | `3` |
| `business_hours` | `{ "days": [1,2,3,4,5], "start": "09:00", "end": "18:00", "holidays": ["2026-12-25"] }` | segunda a sexta, 09:00–18:00, sem feriados |
| `ticket_categories` | até 50 `{ "id", "name", "enabled" }`, `id` no formato `[a-zA-Z0-9_-]{1,100}` | `[]` |
| `protocol_confirmation` | texto de até 1500 caracteres com `{numero}`, `{assunto}`, `{aplicativo}` e `{prazo}`; vazio restaura o padrão | texto padrão |

`business_hours` aceita envio parcial: as chaves omitidas mantêm o valor salvo. `days` tem de um a sete valores de 0 (domingo) a 6, `start` precisa ser anterior a `end` e `holidays` aceita até 100 datas `AAAA-MM-DD`. Os horários são sempre de Brasília (UTC−3). O menu aceita o destino `type: "ticket"`, descrito em [Menus e protocolos](MENUS-PROTOCOLOS.md#abrir-protocolo-pelo-cliente).

### Prévia da última mensagem

Cada linha de `GET /profiles/{perfil}/conversations` traz `last_message`, ou `null` quando a conversa não tem mensagens visíveis para quem consulta:

```json
{
  "text": "Segue o comprovante",
  "direction": "customer",
  "created": 1794000000000,
  "delivery_status": "",
  "attachments": 1,
  "kind": "image"
}
```

`text` vem limitado aos primeiros 300 caracteres. `direction` é `customer`, `outbound` ou `note`. `delivery_status` é vazio, `sent`, `delivered`, `read`, `played` ou `failed`. `attachments` é a quantidade de anexos. `kind` resume o conteúdo: `text`, `image`, `video`, `audio`, `document`, `location`, `contacts`, `sticker` ou `interactive`. Notas internas só entram para sessões de pessoa e aplicações com `notes:read`; para as demais, a prévia é a mensagem anterior que não é nota. A paginação por cursor não muda. A linha também traz `ticket_prompt_expires_at`: enquanto for uma data futura, a conversa aguarda a descrição de um protocolo pedido pelo cliente.

### Modelos de central

`GET /api/v1/service-templates` exige sessão de pessoa (cookie do painel ou Bearer `wabu_`); chaves de aplicação recebem `403`. Retorna `{ "data": [ modelo ] }`, e cada modelo tem:

| Campo | Conteúdo |
|---|---|
| `id`, `name`, `description` | Identificação e apresentação. |
| `summary` | Resumo em uma frase. |
| `settings` | O conteúdo completo, com as mesmas chaves de `PUT /settings`: `departments`, `ticket_categories`, `menus`, `protocol_response_unit`, `protocol_response_days`, `business_hours`, `instructions` e `protocol_confirmation`. Os destinos de bot vêm com `bot_id: null` e `fallback_content`, a mensagem usada quando a área não tem bot. |
| `manual_steps` | Lista de textos com o que o modelo não configura. |

`POST /api/v1/profiles/{perfil}/service-templates/{id}/apply` exige administrador e `Idempotency-Key`. Corpo: `{ "mode": "merge" | "replace", "bot_id": "ID" }`, ambos opcionais (`merge` é o padrão). A aplicação passa pela mesma validação de `PUT /settings`; se ela recusar, nada é gravado. Modelo desconhecido retorna `404`, modo inválido ou bot de outra área, `400`. Resposta:

```json
{
  "template_id": "central-aplicativos",
  "mode": "merge",
  "bot_id": null,
  "created": { "departments": ["central-setor-suporte"], "categories": [], "menus": [], "settings": ["instructions"] },
  "kept": { "departments": [], "categories": [], "menus": [], "settings": ["protocol_confirmation"] },
  "replaced": { "departments": [], "categories": [], "menus": [], "settings": [] },
  "removed": { "departments": [], "categories": [], "menus": [], "settings": [] },
  "skipped": { "departments": [], "categories": [], "menus": [], "settings": [] },
  "pending": [
    { "code": "department_members", "department_id": "central-setor-suporte", "message": "Adicione pessoas ao setor Suporte e protocolos em Menus e ações → Setores de atendimento." }
  ]
}
```

Os cinco grupos listam `id`s (e, em `settings`, nomes de campos). `replaced` e `removed` só são preenchidos no modo `replace`; `skipped.menus` lista opções que o `merge` deixou de criar porque o item pai, com o mesmo `id` do modelo, existe e não é um submenu. `pending` é o que ainda depende do administrador; cada item tem `code` e `message`, e alguns trazem `department_id` ou `bot_id`. Códigos atuais: `department_members`, `bot_missing`, `bot_disabled`, `attendant_bot`, `connect_whatsapp`, `activate`, `menu_conflict`, `review_texts`, `knowledge`, `notification_template` e `contract_identification`. Trate códigos desconhecidos mostrando a mensagem.

O endpoint legado `/profiles/{perfil}/media` aceita multipart `file` de até 20 MiB. Para arquivos de até 100 MiB, use upload em partes abaixo. Use os IDs retornados em `attachments`. Baixe por `/media/{id}/content` com a chave autorizada; não há URLs públicas do bucket. Cadastre conhecimento em `/knowledge` com `kind: text`, `url`, `file` ou `youtube`; importações de arquivos/URLs são assíncronas e têm limites próprios.

## WhatsApp: mídias, grupos e ligações

Estas rotas partem de `/api/v1/profiles/{perfil}`. Consulte `GET /connections/{id}/capabilities` com `conversations:read` antes de oferecer uma função. A resposta da conversa também traz `capabilities`, `group` e metadados de mídias autorizadas. Ausência de capacidade gera `422 unsupported_capability`. [Matriz de modos e limites](WHATSAPP.md).

### Arquivos e mensagens nativas

1. `POST /media/uploads` com `{name,type,size}` e `media:write` retorna `{id,part_size,parts}`. Máximo 100 MiB por arquivo, cinco uploads abertos por identidade. Incompletos expiram após 24h.
2. Envie partes de `part_size` bytes (5 MiB; a última pode ser menor), em ordem, por `PUT /media/uploads/{id}/parts/{part}`, começando em 1. Corpo binário e `Content-Type: application/octet-stream`. Cada parte exige `Idempotency-Key`; a identidade durável é upload + número. Bytes diferentes para a mesma parte geram conflito. Um envio sem recibo retorna `upload_part_unknown`: cancele esse upload e crie outro; não tente substituir a parte.
3. `POST /media/uploads/{id}/complete` confirma o arquivo e retorna o ID para anexar. `POST /media/uploads/{id}/abort` cancela um upload incompleto. Ambas exigem idempotência. Se o R2 concluiu antes de uma interrupção, a conclusão pode ser recuperada.
4. Assuma a conversa e envie `action:reply`, `attachments:[id]` e `content`. Cada anexo resulta em uma entrega; `delivery_id`/`delivery_ids` são filas, não comprovantes do WhatsApp. Preserve todos os IDs para acompanhar Entregas.
5. `GET /media/{id}/content` requer `media:read`; aceita `Range: bytes=...` (206/416). `?inline=1` permite visualização segura de imagens/áudio/vídeo. Não abre HTML inline. Apps só obtêm arquivos próprios ou anexos de conversas autorizadas com `conversations:read`.

Tipos de `content.type`: `text` (detecta o tipo dos anexos), `image`, `video`, `audio`, `voice`, `document`, `sticker`, `location`, `contacts`. `voice` exige OGG/Opus; `sticker` exige WebP 512 × 512. `content.reply_to` é o ID Wabotia de uma mensagem da mesma conversa. `content.mentions` recebe IDs dos participantes conhecidos do grupo QR. Não forneça IDs/identidades de outra área de atendimento.

```sh
curl "$WABOTIA_URL/api/v1/profiles/$WABOTIA_PROFILE/conversations/$WABOTIA_CONVERSATION/actions" \
 -H "Authorization: Bearer $WABOTIA_KEY" -H 'Content-Type: application/json' \
 -H 'Idempotency-Key: video-pedido-0001' \
 --data '{"action":"reply","text":"Vídeo do pedido","attachments":["ID_MIDIA"],"content":{"type":"video","reply_to":"ID_MENSAGEM"}}'
```

Localização: `content:{type:"location",location:{latitude:-23.5,longitude:-46.6,name:"Local de exemplo",address:"Endereço de exemplo"}}`. Contato: `content:{type:"contacts",contacts:[{name:"Pessoa de exemplo",phone:"5511999990000"}]}`. São dados explicitamente fornecidos; não há consulta de localização do celular.

`POST /conversations/{id}/message-actions` com `conversations:write`, responsabilidade da conversa e idempotência:

```json
{"action":"reaction","message_id":"ID_WABOTIA","emoji":"👍"}
```

Outras ações: `read`; `edit` com `text`; `delete`. `emoji:""` remove a própria reação. Editar/apagar só mensagens enviadas; edição tem limite local de 15 minutos. Ações são enviadas ao canal e sujeitas às capacidades/regras dele. Atualizações e recibos geram `message.updated`.

Os exemplos executáveis [JavaScript](../examples/whatsapp-media.mjs) e [Python](../examples/whatsapp-media.py) fazem upload por partes, assumem e respondem. Defina `WABOTIA_URL`, `WABOTIA_KEY`, `WABOTIA_PROFILE`, `WABOTIA_CONVERSATION` e `WABOTIA_REQUEST_ID` no servidor; a chave precisa de `media:write` e `conversations:write`. **Eles enviam uma mensagem; use uma conversa autorizada de teste.**

```sh
node examples/whatsapp-media.mjs ./arquivo.pdf application/pdf document "Seu documento"
python3 examples/whatsapp-media.py ./voz.ogg audio/ogg voice
```

Use um novo REQUEST_ID para uma nova intenção. Ao repetir após falha de rede, mantenha esse ID, arquivo e parâmetros exatamente iguais. Não execute os dois exemplos como se fossem um único pedido; cada exemplo é uma alternativa. Em `unknown`, confira e reconcilie antes de iniciar outra intenção.

### Grupos

| Método e rota | Uso |
|---|---|
| `GET /groups` | `conversations:read`, lista paginada por cursor |
| `POST /groups/actions` | `groups:manage`; `action:sync/create/join`, `connection_id` |
| `POST /groups/{conversation_id}/actions` | `refresh/invite/subject/description/participants/announcement/leave` |
| `PUT /groups/{conversation_id}/policy` | `bot_policy:off/mentions/all`; invalida inferência anterior |
| `GET /group-operations` | Últimas 30 operações acessíveis à identidade |
| `POST /group-operations/{id}/reconcile` | `{status:"sent" ou "failed",confirmed:true}` após conferência do grupo |

Exemplos de corpos: `{action:"create",connection_id:"ID",subject:"Equipe",participants:["5511999990000"]}` (QR); `{action:"join",connection_id:"ID",invite:"https://chat.whatsapp.com/CODIGO"}`; `{action:"participants",operation:"add",participants:["5511999990000"]}`; `{action:"announcement",enabled:true}`. Zernio permite criar grupos empresariais elegíveis, adicionar/remover até oito participantes por pedido e renovar convites; renovar revoga o link anterior. Entrar por convite, sair e alterar administradores ficam disponíveis somente no QR. A confirmação QR é assíncrona. `unknown` bloqueia novas operações de grupo naquela conexão até reconciliação. Resultados por participante podem indicar sucesso parcial.

### Histórico de ligações

Áudio pelo navegador não está disponível na integração Zernio. As rotas de iniciar, configurar, consultar permissão, aceitar, rejeitar ou encerrar áudio retornam `422 unsupported_capability`, sem contactar a Meta. A configuração de encaminhamento de chamadas é feita na Zernio.

O histórico anterior permanece em `GET /calls` e `GET /calls/{id}`, com escopo `calls:read` e as mesmas restrições da área de atendimento e identidade. Para uma ligação antiga sem confirmação, o responsável pode usar `POST /calls/{id}/reconcile` com `{confirmed_ended:true}` após confirmar o encerramento no WhatsApp. Essa operação atualiza apenas o registro local. Sessões privadas não aparecem nos eventos da aplicação.

### Importar e excluir telefones

`POST /connections` aceita `kind:"zernio"`, `config:{number,account_id,zernio_profile_id}` e `secrets:{api_key,webhook_secret}` para um telefone já cadastrado na Zernio. Teste com `POST /connections/{id}/test` antes de ativar. Para várias linhas, cadastre a integração em `POST /router/accounts`, encontre e confirme seu ID em `POST /router/accounts/{id}/resolve` e descubra os telefones em `POST /router/accounts/{id}/discover`. O Wabotia não inicia autorização ou cadastro do telefone no provedor. A antiga rota `POST /router/accounts/{id}/connect` retorna `410 zernio_connect_removed`, inclusive para solicitações com recibos antigos. O contrato completo está na [API interativa](https://wabotia.queven.app/api-docs) e no [guia Zernio](ZERNIO-WHATSAPP.md).

`DELETE /connections/{id}` exige administrador, acesso autorizado à área de atendimento e Idempotency-Key. Remove somente o telefone no Wabotia, cancela mensagens e operações de grupo ainda não enviadas e preserva conversas, mensagens e protocolos. Envios iniciados ou sem confirmação e chamadas abertas bloqueiam a exclusão. A conta e os serviços na Zernio permanecem ativos.

## Agenda de contatos

Todas as rotas abaixo partem de `/api/v1/profiles/{perfil}`:

| Método e rota                        | Permissão                               | Uso                                                                                                                                                                        |
| ------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /contacts`                      | `contacts:read`                         | Lista `{data,next_cursor}`; filtros `q`, `cursor`, `limit` (1–100, padrão 50) e `namespace` opcional.                                                                      |
| `POST /contacts`                     | `contacts:write`                        | Cadastra nome obrigatório e telefone, e-mail, empresa e observações opcionais.                                                                                             |
| `GET /contacts/{id}`                 | `contacts:read`                         | Retorna `{contact,conversations}`. A lista de até 50 conversas recentes exige também `conversations:read`.                                                                 |
| `PATCH /contacts/{id}`               | `contacts:write`                        | Atualiza campos enviados, exigindo `expected_version` da consulta. Versão antiga retorna 409.                                                                              |
| `POST /contacts/import/preview`      | `contacts:write`                        | Corpo `{csv: "conteúdo UTF-8"}`. Retorna prévia, contagens e erros por linha; não grava e não exige Idempotency-Key. Limite adicional de 20 prévias/minuto por identidade. |
| `POST /contacts/import`              | `contacts:write`                        | Mesmo corpo; até 500 contatos/1 MiB. Retorna `{imported,skipped,total}`. Arquivo com erro não importa nenhuma linha.                                                       |
| `PUT /conversations/{id}/contact`    | `contacts:write` e `conversations:read` | Cria com os campos do contato ou vincula explicitamente com `{contact_id}`.                                                                                                |
| `DELETE /conversations/{id}/contact` | `contacts:write` e `conversations:read` | Corpo `{expected_contact_id}`. Remove somente o vínculo; contato diferente do esperado retorna 409.                                                                        |

Escritas exigem `Idempotency-Key`. Cada aplicação acessa apenas seu namespace, definido pelo servidor. Autor, área de atendimento e namespace não podem ser forjados no corpo. Aplicações só vinculam contatos às suas próprias conversas externas; o telefone não une cadastros. Contatos de equipe e de outras integrações são inacessíveis à aplicação, mesmo se ela tentar filtrar outro namespace.

O CSV aceita cabeçalhos em português e inglês, vírgula ou ponto e vírgula, BOM UTF-8 e campos entre aspas. Colunas desconhecidas aparecem em `ignored_columns`. Linhas com todos os campos normalizados idênticos são ignoradas no mesmo arquivo e em reimportações na mesma área de atendimento e namespace. Uma reimportação não sobrescreve edições feitas depois. Nenhuma operação de agenda envia mensagens ou concede consentimento. Veja o [guia de CSV](CONTATOS.md).

```sh
curl "$WABOTIA_URL/api/v1/profiles/$WABOTIA_PROFILE/contacts" \
 -H "Authorization: Bearer $WABOTIA_KEY" -H 'Content-Type: application/json' \
 -H 'Idempotency-Key: contato-cliente-001' \
 --data '{"name":"Contato de exemplo","phone":"5511999990000","email":"contato@example.com","company":"Empresa","notes":"Cadastro pelo sistema integrador"}'
```

Para importar um arquivo no backend com JavaScript, leia-o como UTF-8 e envie `JSON.stringify({csv})` às rotas de prévia e importação. Confira `errors.length === 0` e `new_count > 0` antes de confirmar. Preserve a mesma Idempotency-Key e o mesmo corpo ao repetir uma importação após falha de rede.

## Executar bots

```sh
curl "$WABOTIA_URL/api/v1/bot-runs" \
 -H "Authorization: Bearer $WABOTIA_KEY" -H 'Content-Type: application/json' \
 -H 'Idempotency-Key: execucao-pedido-0001' \
 --data '{"profile_id":"PERFIL","bot_id":"BOT_AUTORIZADO","input":"Solicitação para o bot"}'
```

Retorna `202 {id,status:"queued"}`. Consulte `GET /api/v1/bot-runs/{id}` até `completed`, `failed`, `cancelled` ou `unknown`. Resultado é persistido no Wabotia. Cancele em `POST /profiles/{perfil}/bot-runs/{id}/cancel`. Cancelamento é uma solicitação e não desfaz efeitos já executados pelo Hermes. Aprovações de ferramentas continuam sob as políticas do Hermes.

## MCP para o Hermes Agent

Cada instalação publica um servidor [MCP](https://modelcontextprotocol.io) em `POST /api/mcp`, junto com o painel, a cada deploy na Cloudflare. Ele usa Streamable HTTP sem sessão (JSON-RPC por POST; `HEAD`, `GET` e `DELETE` retornam `405`) e aceita somente chaves de aplicação em `Authorization: Bearer`. Cada ferramenta é traduzida para a rota correspondente da API v1 com a mesma chave: permissões, namespaces, idempotência, limites por minuto e respostas são os desta documentação. Uma chamada de ferramenta conta como uma requisição no limite da aplicação.

No painel, **Integrações → Ferramentas do Wabotia no Hermes Agent (MCP)** cria a aplicação com as permissões recomendadas, emite a chave e mostra o trecho de configuração. No perfil Hermes, guarde `WABOTIA_MCP_KEY=…` no `.env` e acrescente ao `config.yaml`:

```yaml
mcp_servers:
  wabotia:
    url: "https://SUA_INSTALACAO.workers.dev/api/mcp"
    headers:
      Authorization: "Bearer ${WABOTIA_MCP_KEY}"
    timeout: 90
    keepalive_interval: 120
```

Confira com `hermes mcp test wabotia` ou `/reload-mcp`. O Hermes registra as ferramentas como `mcp__wabotia__<nome>` e permite `tools: include`/`exclude` no mesmo bloco. Ferramentas disponíveis: `list_profiles`, `list_conversations`, `get_conversation` (com `last_messages`), `start_conversation`, `receive_inbound_message`, `claim_conversation`, `reply_conversation`, `add_internal_note`, `transfer_conversation`, `resolve_conversation`, `resume_conversation`, `tag_conversation`, `send_menu`, `lookup_conversation_protocols`, `message_action`, `list_tickets`, `get_ticket`, `create_ticket`, `update_ticket`, `list_contacts`, `get_contact`, `create_contact`, `update_contact`, `link_conversation_contact`, `list_knowledge`, `add_knowledge`, `list_bots`, `run_bot`, `get_bot_run`, `list_bot_runs`, `cancel_bot_run`, `list_presence`, `list_events`, `get_report`, `list_consents`, `list_deliveries`, `list_groups`, `get_connection_capabilities`, `router_overview`, `send_router_message` (somente mensagens de atendimento, sem templates pagos), `get_router_message`, `cancel_router_message` e `list_router_templates`. A lista completa, com esquema de entrada, vem de `tools/list`.

Quando a chave acessa uma única área de atendimento, `profile` é opcional. Ferramentas de escrita aceitam `idempotency_key`; reutilize a mesma chave para repetir uma intenção após falha de rede. Erros da API voltam como resultado com `isError:true` e o texto `Erro HTTP <status> <code>: <mensagem> (request_id …)`; parâmetros inválidos ou ferramenta desconhecida retornam erro JSON-RPC `-32602`. Upload de arquivos, exclusões, administração de grupos, ligações e webhooks continuam exclusivos da API HTTP. Outros clientes MCP com Streamable HTTP e cabeçalho Bearer também funcionam.

## Webhooks

Cadastre `POST /profiles/{perfil}/webhook-subscriptions`, corpo `{"url":"https://seusistema.com/wabotia","events":["message.received","ticket.updated","bot.run.completed"]}`. Guarde `signing_secret` retornado. O corpo contém `id`, `type`, `created_at`, `profile_id` e `data`. Desde a 0.8.0, `conversation.updated` com `action: "transfer"` inclui `owner` (novo responsável) e `actor`; `ticket.updated` inclui `actor`, `number`, `previous_status`, `owner`, `previous_owner` e `text_added`. Desde a 0.14.0, `ticket.created` inclui `category` quando o protocolo tem categoria, e `ticket.updated` pode trazer `category`, `previous_category` e, no retorno automático de `waiting_customer`, `reason: "customer_message"` com `actor: "system"`. Campos novos são aditivos; trate campos desconhecidos com tolerância.

Valide `Wabotia-Signature: v1=<HMAC-SHA256>` sobre `Wabotia-Timestamp + "." + bytes_originais`. Recuse timestamps com diferença superior a cinco minutos, compare a assinatura em tempo constante e confira `Wabotia-Event-Id` contra `body.id`. A assinatura é recalculada a cada tentativa; o ID do evento permanece estável. Persista esse ID para deduplicar. Consulte entregas em `/webhook-deliveries`; use `/{id}/retry` para reenvio manual. Há dez tentativas automáticas, com espera progressiva limitada a uma hora entre tentativas.

Veja os clientes completos em [JavaScript](../examples/client.mjs), [Python](../examples/client.py) e [cURL](../examples/curl.sh), além dos verificadores [JavaScript](../examples/webhook.mjs) e [Python](../examples/webhook.py). Os exemplos criam somente conversas no namespace da aplicação; conectar um número real exige a configuração do canal e suas permissões.
