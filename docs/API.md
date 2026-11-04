# Integração com a API v1

O contrato está em `/api/openapi.json` e o explorador de consultas em `/api-docs`. Use chaves somente no backend do seu sistema. O administrador cadastra a aplicação em **API e integrações**, seleciona perfis, permissões e bots, depois emite uma chave. Guarde-a imediatamente. Para rotacionar, emita outra chave, atualize o integrador e revogue a anterior.

## Identidade e autorização

`Authorization: Bearer SUA_CHAVE` autentica a aplicação. Ela não escolhe o autor por `actor`, `user_id` ou campos semelhantes: a identidade vem da chave. Cada cliente externo é vinculado à aplicação; telefones informados não unem cadastros. Aplicações não acessam conversas externas de outras aplicações. Canais compartilhados seguem as permissões de perfil. Notas internas precisam de `notes:read`; relatórios não contornam essa restrição. Somente contas humanas registram presença.

Permissões: `conversations:read/write`, `notes:read`, `tickets:read/write`, `knowledge:read/write`, `media:read/write`, `reports:read`, `presence:read`, `bots:read/invoke`, `events:read`, `webhooks:manage`. O administrador também define requisições por minuto e execuções simultâneas. Cada chave possui expiração de até 365 dias.

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

Envie arquivos de até 20 MB com multipart `file` para `/profiles/{perfil}/media`. Use os IDs retornados em `attachments`. Baixe por `/media/{id}/content` com a chave autorizada; não há URLs públicas do bucket. Cadastre conhecimento em `/knowledge` com `kind: text`, `url`, `file` ou `youtube`; importações de arquivos/URLs são assíncronas.

## Executar bots

```sh
curl "$WABOTIA_URL/api/v1/bot-runs" \
 -H "Authorization: Bearer $WABOTIA_KEY" -H 'Content-Type: application/json' \
 -H 'Idempotency-Key: execucao-pedido-0001' \
 --data '{"profile_id":"PERFIL","bot_id":"BOT_AUTORIZADO","input":"Solicitação para o bot"}'
```

Retorna `202 {id,status:"queued"}`. Consulte `GET /api/v1/bot-runs/{id}` até `completed`, `failed`, `cancelled` ou `unknown`. Resultado é persistido no Wabotia. Cancele em `POST /profiles/{perfil}/bot-runs/{id}/cancel`. Cancelamento é uma solicitação e não desfaz efeitos já executados pelo Hermes. Aprovações de ferramentas continuam sob as políticas do Hermes.

## Webhooks

Cadastre `POST /profiles/{perfil}/webhook-subscriptions`, corpo `{"url":"https://seusistema.com/wabotia","events":["message.received","ticket.updated","bot.run.completed"]}`. Guarde `signing_secret` retornado. O corpo contém `id`, `type`, `created_at`, `profile_id` e `data`.

Valide `Wabotia-Signature: v1=<HMAC-SHA256>` sobre `Wabotia-Timestamp + "." + bytes_originais`. Recuse timestamps com diferença superior a cinco minutos, compare a assinatura em tempo constante e confira `Wabotia-Event-Id` contra `body.id`. A assinatura é recalculada a cada tentativa; o ID do evento permanece estável. Persista esse ID para deduplicar. Consulte entregas em `/webhook-deliveries`; use `/{id}/retry` para reenvio manual. Há dez tentativas automáticas, com espera progressiva limitada a uma hora entre tentativas.

Veja os clientes completos em [JavaScript](../examples/client.mjs), [Python](../examples/client.py) e [cURL](../examples/curl.sh), além dos verificadores [JavaScript](../examples/webhook.mjs) e [Python](../examples/webhook.py). Os exemplos criam somente conversas no namespace da aplicação; conectar um número real exige a configuração do canal e suas permissões.
