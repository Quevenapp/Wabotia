# Integração com a API v1

O contrato está em `/api/openapi.json` e o explorador de consultas em `/api-docs`. Use chaves somente no backend do seu sistema. O administrador cadastra a aplicação em **API e integrações**, seleciona perfis, permissões e bots, depois emite uma chave. Guarde-a imediatamente. Para rotacionar, emita outra chave, atualize o integrador e revogue a anterior.

## Identidade e autorização

`Authorization: Bearer SUA_CHAVE` autentica a aplicação. Ela não escolhe o autor por `actor`, `user_id` ou campos semelhantes: a identidade vem da chave. Cada cliente externo é vinculado à aplicação; telefones informados não unem cadastros. Aplicações não acessam conversas externas de outras aplicações. Canais compartilhados seguem as permissões de perfil. Notas internas precisam de `notes:read`; relatórios não contornam essa restrição. Somente contas humanas registram presença.

Permissões: `conversations:read/write`, `contacts:read/write`, `notes:read`, `tickets:read/write`, `knowledge:read/write`, `media:read/write`, `groups:manage`, `calls:read/write`, `routing:read/send/paid`, `reports:read`, `presence:read`, `bots:read/invoke`, `events:read`, `webhooks:manage`. O administrador também define requisições por minuto e execuções simultâneas. Cada chave possui expiração de até 365 dias.

Tokens com prefixo `wabu_` **não são chaves de aplicação**: são sessões humanas dos aplicativos Android e iOS, emitidas por `POST /api/auth/mobile/login` (fora de `/v1`) para uma pessoa cadastrada em **Pessoas**, com os mesmos perfis e papel do painel. Eles valem 30 dias, são renovados por `POST /v1/auth/mobile/refresh` e revogados por `POST /v1/logout`. As rotas de dispositivos (`/v1/devices`), de notificações (`/v1/system/push`, administrador) e o detalhe de protocolo `GET /profiles/{perfil}/tickets/{id}` com filtros `status` e `overdue` fazem parte do mesmo contrato; as de dispositivos e notificações aceitam somente sessão de usuário ou cookie do painel e respondem `403` a chaves de aplicação. Integrações servidor-servidor continuam usando chaves de aplicação; não use um token `wabu_` em um backend. Detalhes em [MOBILE.md](MOBILE.md).

## Roteador de números Meta

Cada número retorna `policy` com `purpose`, `service`, `templates`, `human`, `api`, `menu`, `bots` e `pool`. As opções do número prevalecem sobre permissões de grupo/aplicação. Somente administrador humano pode alterá-las por `PUT /profiles/{perfil}/router/numbers/{id}/policy`, corpo `{"policy":{...}}` completo e `Idempotency-Key`. `403 number_policy_denied` indica capacidade desabilitada. A conferência ocorre no pedido e antes da entrega; uma restrição nova cancela envios ainda pendentes. Mensagens já enviadas ou sem confirmação não são repetidas nem movidas para outro número. O histórico e os eventos recebidos continuam disponíveis.

Consulte `GET /profiles/{perfil}/router` para números/grupos autorizados e contadores. Envie por `POST /profiles/{perfil}/router/messages`, com `number_id` **ou** `pool_id`, `to`, `external_id` estável e texto/anexo. Retorna `202` com `delivery_id`; consulte `GET /profiles/{perfil}/router/messages/{id}`. Somente uma entrega `pending` pode ser cancelada, por `POST /profiles/{perfil}/router/messages/{id}/cancel`. Todas as escritas exigem idempotência.

Atendimento exige janela de 24 horas real no mesmo número. O remetente fica vinculado; esgotamento não troca de número nem inicia modelo pago. Modelos exigem `routing:paid`, origem/grupo autorizados, `allow_paid:true`, consentimento da mesma categoria e modelo aprovado na WABA. A chave não escolhe o autor. Consulte o [guia do roteador, limites e exemplos cURL/JavaScript/Python](ROTEADOR.md). Uma resposta `sent` é aceitação pelo canal; confira `provider_status`. Não repita um resultado `unknown` em outro número.

## Repetição e erros

Toda operação de escrita recebe `Idempotency-Key`, com até 200 caracteres ASCII visíveis. Gere uma chave para cada intenção e mantenha a mesma chave, método, caminho e corpo se precisar repetir por falha de rede. O resultado registrado é devolvido com `Idempotency-Replayed: true`. Outro conteúdo sob a mesma chave retorna `409 idempotency_conflict`. Nunca gere outra chave automaticamente após timeout: a operação pode já ter sido aceita.

Respostas de erro usam `{"error":{"code":"...","message":"...","request_id":"..."}}` e cabeçalho `X-Request-Id`. `401` indica chave expirada/revogada, `403` permissão, `404` recurso fora do acesso, `409` conflito e `429` limite. Respeite `Retry-After`. IDs são opacos; datas são Unix em milissegundos.

Listas de conversas e recursos de perfil usam `{data, next_cursor}`. Passe o cursor inalterado na consulta seguinte. Eventos usam `after` numérico e devolvem `cursor`, inclusive quando eventos não autorizados são omitidos. Perfis e presença são listas diretas. Relatórios permitem `section`, `start`, `end` (YYYY-MM-DD, São Paulo), `cursor` e `limit`; `format=jsonl` exporta por streaming.

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

Abra um protocolo com `POST /profiles/{perfil}/tickets`, corpo `{"conversation_id":"ID","title":"Solicitação"}`. Atualize com `PATCH /profiles/{perfil}/tickets/{id}` e `status`, `text`, `owner` ou `response_due_at`. O prazo só é alterável antes da primeira resposta e enquanto aberto.

O endpoint legado `/profiles/{perfil}/media` aceita multipart `file` de até 20 MiB. Para arquivos de até 100 MiB, use upload em partes abaixo. Use os IDs retornados em `attachments`. Baixe por `/media/{id}/content` com a chave autorizada; não há URLs públicas do bucket. Cadastre conhecimento em `/knowledge` com `kind: text`, `url`, `file` ou `youtube`; importações de arquivos/URLs são assíncronas e têm limites próprios.

## WhatsApp: mídias, grupos e ligações

Estas rotas partem de `/api/v1/profiles/{perfil}`. Consulte `GET /connections/{id}/capabilities` com `conversations:read` antes de oferecer uma função. A resposta da conversa também traz `capabilities`, `group` e metadados de mídias autorizadas. Ausência de capacidade gera `422 unsupported_capability`. [Matriz de modos e limites](WHATSAPP.md).

### Arquivos e mensagens nativas

1. `POST /media/uploads` com `{name,type,size}` e `media:write` retorna `{id,part_size,parts}`. Máximo 100 MiB por arquivo, cinco uploads abertos por identidade. Incompletos expiram após 24h.
2. Envie partes de `part_size` bytes (5 MiB; a última pode ser menor), em ordem, por `PUT /media/uploads/{id}/parts/{part}`, começando em 1. Corpo binário e `Content-Type: application/octet-stream`. Cada parte exige `Idempotency-Key`; a identidade durável é upload + número. Bytes diferentes para a mesma parte geram conflito. Um envio sem recibo retorna `upload_part_unknown`: cancele esse upload e crie outro; não tente substituir a parte.
3. `POST /media/uploads/{id}/complete` confirma o arquivo e retorna o ID para anexar. `POST /media/uploads/{id}/abort` cancela um upload incompleto. Ambas exigem idempotência. Se o R2 concluiu antes de uma interrupção, a conclusão pode ser recuperada.
4. Assuma a conversa e envie `action:reply`, `attachments:[id]` e `content`. Cada anexo resulta em uma entrega; `delivery_id`/`delivery_ids` são filas, não comprovantes do WhatsApp. Preserve todos os IDs para acompanhar Entregas.
5. `GET /media/{id}/content` requer `media:read`; aceita `Range: bytes=...` (206/416). `?inline=1` permite visualização segura de imagens/áudio/vídeo. Não abre HTML inline. Apps só obtêm arquivos próprios ou anexos de conversas autorizadas com `conversations:read`.

Tipos de `content.type`: `text` (detecta o tipo dos anexos), `image`, `video`, `audio`, `voice`, `document`, `sticker`, `location`, `contacts`. `voice` exige OGG/Opus; `sticker` exige WebP 512 × 512. `content.reply_to` é o ID Wabotia de uma mensagem da mesma conversa. `content.mentions` recebe IDs dos participantes conhecidos do grupo QR. Não forneça IDs/identidades de outro perfil.

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

Exemplos de corpos: `{action:"create",connection_id:"ID",subject:"Equipe",participants:["5511999990000"]}` (QR); `{action:"join",connection_id:"ID",invite:"https://chat.whatsapp.com/CODIGO"}`; `{action:"participants",operation:"add",participants:["5511999990000"]}`; `{action:"announcement",enabled:true}`. Meta cria grupos elegíveis e admite participantes por convite, não por `add`. A confirmação QR é assíncrona. `unknown` bloqueia novas operações de grupo naquela conexão até reconciliação. Resultados por participante podem indicar sucesso parcial.

### Ligações de voz

O administrador habilita Calling API em Conexões. Escritas exigem `calls:read` **e** `calls:write`; assumir entrada exige também `conversations:write`. Apps podem ver chamadas livres no perfil autorizado e assumir uma delas em sua própria identidade. Depois, apenas o responsável controla/obtém a sessão; outra aplicação não vê a chamada nem recebe seus novos eventos. Atendentes humanos mantêm a visibilidade de equipe, mas só o responsável recebe o SDP.

| Método e rota | Uso |
|---|---|
| `GET /calls` | Histórico por data, `limit` 1–100, `cursor`, `conversation_id` |
| `GET /calls/{id}` | Estado; `?session=1` só para o responsável com escrita |
| `GET /conversations/{id}/call-permission` | Permissão/limites atuais da Meta, `calls:read` |
| `POST /calls/permission` | `{conversation_id}`; exige ser responsável e janela de atendimento aberta |
| `POST /calls` | `{conversation_id,session:{sdp_type:"offer",sdp:"..."}}` de WebRTC áudio |
| `POST /calls/{id}/claim` | Assumir chamada recebida; também toma a conversa e invalida a IA |
| `POST /calls/{id}/pre_accept` e `/accept` | Mesma `session:{sdp_type:"answer",sdp:"..."}` nas duas ações |
| `POST /calls/{id}/keepalive` | Renovar presença; enviar a cada 20 s durante a chamada |
| `POST /calls/{id}/reject` ou `/terminate` | Recusar entrada ou encerrar; sem repetição automática em timeout |
| `POST /calls/{id}/reconcile` | `{confirmed_ended:true}` somente após confirmar que encerrou no WhatsApp |

O JSON é a sinalização, não o áudio. Um integrador precisa de um cliente WebRTC ou servidor de mídia próprio para produzir/consumir o SDP. Não basta enviar texto em `sdp`. Recolha os candidatos ICE antes de enviar a oferta/resposta; vídeo e data channels são recusados. Não exponha a chave Bearer nem credenciais Meta no navegador externo: seu backend deve autenticar a interface e repassar somente a sessão da chamada autorizada.

Uma resposta HTTP bem-sucedida não significa que alguém atendeu. Consulte os estados `dialing`, `connecting`, `ringing`, `preaccepted`, `active`, `completed`, `rejected`, `missed`, `failed` e `unknown`, ou assine `call.updated`. Receipts, SDP e credenciais dinâmicas são criptografados em repouso; SDP não é enviado nos webhooks da aplicação. Depois do fim, as sessões da tabela de chamadas são eliminadas. Ausência de keepalive por cerca de 90 s solicita encerramento uma vez, sem repetir uma ação ambígua. Não há gravação de chamadas.

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

Escritas exigem `Idempotency-Key`. Cada aplicação acessa apenas seu namespace, definido pelo servidor. Autor, perfil e namespace não podem ser forjados no corpo. Aplicações só vinculam contatos às suas próprias conversas externas; o telefone não une cadastros. Contatos de equipe e de outras integrações são inacessíveis à aplicação, mesmo se ela tentar filtrar outro namespace.

O CSV aceita cabeçalhos em português e inglês, vírgula ou ponto e vírgula, BOM UTF-8 e campos entre aspas. Colunas desconhecidas aparecem em `ignored_columns`. Linhas com todos os campos normalizados idênticos são ignoradas no mesmo arquivo e em reimportações no mesmo perfil/namespace. Uma reimportação não sobrescreve edições feitas depois. Nenhuma operação de agenda envia mensagens ou concede consentimento. Veja o [guia de CSV](CONTATOS.md).

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

## Webhooks

Cadastre `POST /profiles/{perfil}/webhook-subscriptions`, corpo `{"url":"https://seusistema.com/wabotia","events":["message.received","ticket.updated","bot.run.completed"]}`. Guarde `signing_secret` retornado. O corpo contém `id`, `type`, `created_at`, `profile_id` e `data`. Desde a 0.8.0, `conversation.updated` com `action: "transfer"` inclui `owner` (novo responsável) e `actor`; `ticket.updated` inclui `actor`, `number`, `previous_status`, `owner`, `previous_owner` e `text_added`. Campos novos são aditivos; trate campos desconhecidos com tolerância.

Valide `Wabotia-Signature: v1=<HMAC-SHA256>` sobre `Wabotia-Timestamp + "." + bytes_originais`. Recuse timestamps com diferença superior a cinco minutos, compare a assinatura em tempo constante e confira `Wabotia-Event-Id` contra `body.id`. A assinatura é recalculada a cada tentativa; o ID do evento permanece estável. Persista esse ID para deduplicar. Consulte entregas em `/webhook-deliveries`; use `/{id}/retry` para reenvio manual. Há dez tentativas automáticas, com espera progressiva limitada a uma hora entre tentativas.

Veja os clientes completos em [JavaScript](../examples/client.mjs), [Python](../examples/client.py) e [cURL](../examples/curl.sh), além dos verificadores [JavaScript](../examples/webhook.mjs) e [Python](../examples/webhook.py). Os exemplos criam somente conversas no namespace da aplicação; conectar um número real exige a configuração do canal e suas permissões.
