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

Toda operação de escrita recebe `Idempotency-Key`, com até 200 caracteres ASCII visíveis. Gere uma chave para cada intenção e mantenha a mesma chave, método, caminho e corpo se precisar repetir por falha de rede. O resultado registrado é devolvido com `Idempotency-Replayed: true`. Outro conteúdo sob a mesma chave retorna `409 idempotency_conflict`. A chave vale por credencial, área de atendimento e operação: outra credencial ou outra área com a mesma chave é outra operação, e a chave nunca vira id de registro. Nunca gere outra chave automaticamente após timeout: a operação pode já ter sido aceita.

Respostas de erro usam `{"error":{"code":"...","message":"...","request_id":"..."}}` e cabeçalho `X-Request-Id`. `401` indica chave expirada/revogada, `403` permissão, `404` recurso fora do acesso, `409` conflito e `429` limite. Respeite `Retry-After`. IDs são opacos; datas são Unix em milissegundos.

Listas de conversas e recursos da área de atendimento usam `{data, next_cursor}`. Passe o cursor inalterado na consulta seguinte. Eventos usam `after` numérico e devolvem `cursor`, inclusive quando eventos não autorizados são omitidos. Áreas de atendimento e presença são listas diretas. Relatórios permitem `section`, `start`, `end` (YYYY-MM-DD, São Paulo), `cursor` e `limit`; `format=jsonl` exporta por streaming.

## Módulos e capacidades

Funções como a fila presencial são **módulos** que o administrador liga e desliga por área de atendimento (contrato em [MODULOS.md](MODULOS.md)). Antes de mostrar a tela de um módulo, consulte `GET /api/v1/capabilities`. A rota aceita qualquer credencial válida: cookie do painel, token `wabu_` de pessoa ou chave de aplicação, inclusive a de um aparelho pareado; não exige permissão específica. A resposta traz `capabilities_version` (hoje `1`), `server.version` (versão do servidor), `features` (recursos do núcleo, como `modules`), o `actor` autenticado e `profiles`: só as áreas que a credencial alcança, cada uma com `modules`, a lista dos módulos **ligados** com `id`, `name` e `version`. `?profile=ID` restringe a uma área e responde `404` se a credencial não a alcançar. Um módulo ausente da lista está desligado ou não existe nesta versão do servidor: esconda a tela.

```json
{
  "capabilities_version": 1,
  "server": { "service": "wabotia", "version": "0.20.0", "commit": "..." },
  "features": ["modules", "web_steps", "establishment"],
  "actor": { "id": "app:...", "kind": "app", "role": "service" },
  "profiles": [
    {
      "id": "...",
      "name": "Atendimento",
      "enabled": true,
      "modules": [
        { "id": "queue", "name": "Fila presencial", "version": "1.0.0" },
        { "id": "forms", "name": "Formulários", "version": "1.0.0" }
      ]
    }
  ]
}
```

`GET /profiles/{perfil}/modules` lista todos os módulos da versão instalada com `enabled`, `default_enabled`, a navegação do painel, os tipos de item de menu, os eventos e as chaves de configuração. `PUT /profiles/{perfil}/modules/{id}` com `{"enabled":false}` e `Idempotency-Key` liga ou desliga (somente administrador) e publica o evento `module.changed`. Com o módulo desligado, suas rotas e operações respondem `409 module_disabled` e seus itens de menu somem do WhatsApp e do editor de menus, sem serem apagados: voltam ao religar. Um módulo pode depender de outro (`requires` em `GET /modules`): ligar sem o requerido responde `409 module_requires`; desligar um requerido com dependentes ligados responde `409 module_required`, e com `{"enabled":false,"cascade":true}` desliga todos juntos (resposta com `also_disabled`; `module.changed` dos dependentes com `because`).

### Dados do estabelecimento

Cada área guarda nome fantasia, CPF ou CNPJ, endereço, telefone e um texto de rodapé (Gestão → Estabelecimento), para cupom do totem, comanda, recibo da ordem de serviço e cabeçalho e rodapé das páginas do passo web. Leia em `GET /profiles/{perfil}/establishment`: aceita a pessoa da área e chave de aplicação dela, inclusive aparelho pareado, sem escopo próprio (`404` se a credencial não alcançar a área). O recurso `establishment` em `features` de `/capabilities` indica que a rota existe.

```json
{
  "name": "Assistência Exemplo",
  "document": "11222333000181",
  "document_type": "cnpj",
  "document_display": "11.222.333/0001-81",
  "address": "Rua das Flores, 120 — Centro, Campinas/SP",
  "phone": "(19) 3333-4444",
  "footer": "Garantia de 90 dias nos serviços.",
  "configured": true
}
```

Sem cadastro, `name` é o nome da área, os outros textos vêm vazios, `document_type` é `null` e `configured` é `false`. `footer` e `address` podem ter quebras de linha. O administrador grava com `PUT /profiles/{perfil}/settings` e `{"establishment":{"name","document","address","phone","footer"}}` (substitui o bloco inteiro; o documento vai com ou sem pontuação, e CPF e CNPJ, inclusive o alfanumérico, têm os dígitos verificadores conferidos).

### Pessoas da área

Para escolher o responsável de uma ordem de serviço (ou de outro registro de módulo), liste as pessoas em `GET /profiles/{perfil}/people`: `{"data":[{"id":"…","name":"Ana","role":"operator"}]}`, só contas ativas com acesso à área (administradores incluídos, `role` `admin` ou `operator`), em ordem de nome, sem bots e sem e-mail. Aceita a pessoa da área e chave de aplicação com `conversations:read`. O `id` é o valor de `assignee`. `GET /profiles/{perfil}/team` continua sendo o diretório da conversa interna (pessoas e bots com disponibilidade, só para sessão de pessoa).

### Consentimento de notificação por finalidade

`GET /profiles/{perfil}/consents` traz em cada registro `purpose`: `protocol` (pergunta AUTORIZO / NÃO AUTORIZO do protocolo), `billing` (cobrança), `scheduling` (agendamento), `order` (pedido), `booking` (reserva) ou `*` (o REVOGAR do cliente, que vale para todas), além de `source` (`whatsapp`, `panel`, `contract`…) e `module_id`. Fora da janela de 24 horas da linha oficial, uma notificação de módulo marcada com finalidade só sai com o consentimento dela; as de protocolo seguem com o de protocolo. As cobranças do núcleo são `billing`. Cada registro feito por módulo publica `consent.updated` com `conversation_id`, `purpose`, `status`, `source` e `module_id`.

### Passagem feita por módulo

Quando um módulo passa a conversa para a equipe (ex.: Suporte pago depois de conferir a assinatura), o detalhe `GET /profiles/{perfil}/conversations/{id}` traz `handoff`: `{"module":"suporte","summary":"…","flags":["telefone não vinculado"],"at":…}`, ou `null`. Mostre os `flags` como avisos ao atendente. Vem só para quem lê notas internas (pessoa, ou chave com `notes:read`) e some na próxima passagem sem módulo e ao encerrar a conversa. O mesmo resumo fica como nota interna.

### Passo web e formulários

O que não cabe no chat sai por um **passo web**: um link curto e de uso único (`/api/w/{código}`, 16 caracteres) amarrado à conversa, que abre uma página leve no celular. O código vale até a validade definida (padrão 24 horas) e só o hash fica guardado; a API nunca devolve o código. Ao concluir, o Wabotia publica `web_step.completed` com as respostas, registra uma nota interna na conversa, anexa as respostas ao protocolo ativo (ou abre um, conforme o formulário) e envia a mensagem de retorno no WhatsApp. Se a janela de 24 horas da linha oficial estiver fechada, o retorno sai pelo modelo de notificação configurado em `notifications`, como as chamadas da fila. A página mostra **Voltar ao WhatsApp** (`wa.me` da linha). Abrir de novo um link concluído, expirado ou cancelado mostra o aviso correspondente e não aceita outra resposta.

O primeiro uso é o módulo **Formulários**: o administrador cadastra `forms` em `PUT /profiles/{perfil}/settings` (campos `text`, `choice`, `date` e `accept`) e o cliente recebe o link por um item de menu `{"type":"form","form_id":"..."}`, pela equipe ou por uma integração (`POST /profiles/{perfil}/conversations/{id}/actions` com `{"action":"form","form_id":"..."}`, ou `POST /profiles/{perfil}/forms/{id}/send` com `{"conversation_id":"..."}`; conversa assumida) ou por um bot (ferramenta MCP `send_form`). Consulte `GET /profiles/{perfil}/forms`, `GET /profiles/{perfil}/conversations/{id}/web-steps` e `GET /profiles/{perfil}/web-steps/{id}`; cancele um link aberto com `POST /profiles/{perfil}/web-steps/{id}/cancel`. O detalhe da conversa traz `web_steps` e o detalhe do contato traz as respostas das conversas vinculadas. Eventos: `web_step.sent`, `web_step.opened`, `web_step.completed`, `web_step.expired`, `web_step.cancelled` e `form.submitted` (com `form_id` e `answers`). O contrato para módulos está em [MODULOS.md](MODULOS.md).

### Agenda

Módulo `agenda` (desligado por padrão; guia de uso em [AGENDA.md](AGENDA.md)). Horários em ms Unix; dias e horas de trabalho no horário de Brasília. Com o módulo desligado, tudo abaixo responde `409 module_disabled`.

- Leitura (`conversations:read`): `GET /profiles/{perfil}/agenda` (configuração já com os padrões, `services`, `professionals`), `/agenda/services`, `/agenda/professionals` (com `service_ids` e `hours` `[{weekday,start,end}]`), `/agenda/blocks?from=&to=`, `/agenda/availability?service_id=&professional_id=&date=` (ou `from_date`/`to_date`, até 31 dias; `staff=1` ignora a antecedência, mas não oferece horário que já passou: passado só com `force`) e `/agenda/appointments?from=&to=&professional_id=&status=&conversation_id=` (até 62 dias), `/agenda/appointments/{id}`.
- Cadastros (somente administrador, `Idempotency-Key`): `POST`/`PUT /agenda/services[/{id}]` `{name, duration_minutes, price_cents?, description?, active?}`; `POST`/`PUT /agenda/professionals[/{id}]` `{name, user_id?, service_ids?, hours?, active?}`; `POST /agenda/blocks` `{professional_id?, date, until?}` (dias inteiros), `{professional_id?, date, start, end}` ou `{starts, ends}`; `DELETE` em `/agenda/services/{id}`, `/agenda/professionals/{id}` (arquivam) e `/agenda/blocks/{id}`. A configuração é a chave `agenda` de `PUT /profiles/{perfil}/settings`.
- Agendamentos (`conversations:write`, `Idempotency-Key`): `POST /agenda/appointments` `{service_id, starts, professional_id?, conversation_id? | customer_name, customer_phone?, notes?, force?, notify?}`; `POST /agenda/appointments/{id}/move` `{starts, professional_id?}`, `/cancel` `{reason?}`, `/confirm` e `/no-show` (só depois do início). A reserva é atômica: dois pedidos para o mesmo horário do mesmo profissional nunca ficam os dois; o segundo recebe `409 slot_taken` ou `409 slot_unavailable`. `professional_id` nulo escolhe quem estiver livre. Agendamento ligado a uma conversa avisa o cliente (agendado, remarcado, cancelado), pelo modelo de notificação se a janela de 24 horas estiver fechada; `notify:false` não avisa.
- Pela conversa: `POST /profiles/{perfil}/conversations/{id}/actions` com `{"action":"agenda","service_id":"...","starts":...}` (Agendar para este cliente) ou `{"action":"agenda_link"}` (o cliente recebe o link para escolher sozinho). Exigem a conversa assumida pela credencial ou administrador.
- WhatsApp: itens de menu `{"type":"agenda","service_id":"opcional"}` (Agendar horário) e `{"type":"agenda_mine"}` (Meus agendamentos). O cliente escolhe na própria conversa (lista e botões nas linhas oficiais, com ids `agenda:…`; opções numeradas no QR); com `web_page: true` na chave `agenda`, numa página aberta pelo link. O lembrete traz Confirmar, Remarcar e Cancelar (ids `agenda:remind:{id}:confirm|move|cancel`).
- Eventos (permissão `conversations:read` nos webhooks): `agenda.booked`, `agenda.rescheduled` (com `previous`), `agenda.cancelled` (com `reason`), `agenda.confirmed` e `agenda.no_show`. Todos trazem `appointment` (o agendamento completo), `conversation_id`, `actor` (`customer` quando foi o cliente) e `module_id: "agenda"`.

### Ordem de serviço (módulo `os`)

Desligado por padrão; uso em [ORDEM-DE-SERVICO.md](ORDEM-DE-SERVICO.md). Rotas em `/profiles/{perfil}/service-orders`; leitura com `conversations:read`, escrita com `conversations:write` e `Idempotency-Key` (repetir a chave devolve a mesma resposta, sem abrir outra ordem nem reenviar mensagem). Com o módulo desligado, todas respondem `409 module_disabled`.

| Método e caminho | O quê |
|---|---|
| `GET /service-orders` | Lista por número decrescente. Filtros: `status=a,b`, `open=1` (sem entregues e canceladas), `q` (item, cliente, problema; número da ordem; telefone a partir de 4 dígitos), `phone`, `conversation_id`, `limit` (até 200) e `cursor` (o `next_cursor` anterior). Traz `counts`: `{"received":3,"in_progress":4,…}`, chaves iguais aos códigos de `status`, só estados com ordens (ausente = 0), contando a área inteira sem os filtros ([detalhes](ORDEM-DE-SERVICO.md#integrações-e-aplicativos)) |
| `GET /service-orders/{id}` | Ordem com `history` (quem mudou e quando) |
| `POST /service-orders` | Abre: `item`, `problem` e `conversation_id` ou `phone`; opcionais `customer_name`, `notes`, `assignee` (pessoa da área, de `GET /people`), `due_at` (ms), `notify` |
| `PATCH /service-orders/{id}` | Dados da ordem; encerrada, só `notes` |
| `POST /service-orders/{id}/status` | `{"status":"…","note":"…"}`; transição inválida: `409 invalid_transition` |
| `PUT /service-orders/{id}/quote` | `{"items":[{"description","quantity","unit_cents"}],"valid_days","note"}`; orçamento já enviado volta para `analyzing` |
| `POST /service-orders/{id}/quote/send` | Envia ao cliente e passa a `quoted`; `{"notify":false}` só registra (sem conversa: `409 no_conversation`) |
| `POST /service-orders/{id}/decision` | `{"decision":"approve"\|"decline"}` em nome do cliente; vencido: `409 quote_expired`; fora de `quoted`: `409 quote_not_pending` |

Também pela conversa: `POST /profiles/{perfil}/conversations/{id}/actions` com `{"action":"service_order","item":"…","problem":"…"}` abre ligada à conversa, e `{"action":"service_order","send_form":true}` manda ao cliente o link para ele preencher (conversa assumida). Estados: `received`, `analyzing`, `quoted`, `approved`, `declined`, `in_progress`, `ready`, `delivered`, `cancelled`; cada ordem traz `next_statuses`. Valores em centavos e datas em milissegundos. Eventos: `os.opened`, `os.quoted`, `os.approved`, `os.declined` (com `by` e `via`), `os.status_changed` (`from`, `to`, `actor`), `os.delivered` (`warranty_until`) e `os.stale` (ordem parada), entregues aos webhooks com `conversations:read`.

### Cobrança

Pix e link de pagamento pelo Mercado Pago (módulo `payments`, passo a passo em [COBRANCA.md](COBRANCA.md)). O administrador configura a conta em `PUT /profiles/{perfil}/payments/account` (`access_token`, `webhook_secret`, `payer_email`, `enabled`); `GET /profiles/{perfil}/payments/account` nunca devolve os segredos, só `access_token_set`, `webhook_secret_set` e o `webhook_url` a cadastrar no Mercado Pago; `GET …/payments/account/check` confere as credenciais. Cobre com `POST /profiles/{perfil}/conversations/{id}/actions` e `{"action":"charge","method":"pix","amount_cents":4990,"description":"Consulta"}` (conversa assumida). Consulte `GET /profiles/{perfil}/payments?conversation_id=…` e `GET /profiles/{perfil}/payments/{id}`; cancele com `POST /profiles/{perfil}/payments/{id}/cancel`. O detalhe da conversa traz `payments`. Estados: `created`, `paid`, `expired`, `cancelled`, `refunded`; `paid` e `refunded` vêm só do webhook assinado do provedor seguido da consulta do pagamento. Eventos `payment.created`, `payment.paid`, `payment.expired`, `payment.cancelled` e `payment.refunded`.

### Mensalidade (módulo `mensalidade`)

Desligado por padrão; uso em [MENSALIDADE.md](MENSALIDADE.md). Rotas em `/profiles/{perfil}/mensalidade`; leitura com `conversations:read`, escrita com `conversations:write` e `Idempotency-Key` (repetir a chave devolve a mesma resposta sem repetir cobrança nem mensagem). Planos, importação, pausar/retomar/encerrar, baixa, isenção e gerar exigem administrador (pessoas) ou aplicação com `conversations:write`; o mesmo vale para valor, desconto e plano de uma assinatura (no cadastro ou no `PATCH`), para autorizar telefone num pagador (`/phones`, ou assinatura com o `document` de um pagador existente e um telefone que ele ainda não autorizou) e para trocar o documento do pagador (`403 admin_required`). Com o módulo desligado, todas respondem `409 module_disabled`. Valores em centavos inteiros; vencimentos `AAAA-MM-DD` no horário de Brasília; competência `AAAA-MM`.

| Método e caminho | O quê |
|---|---|
| `GET /mensalidade/plans` · `POST` · `PATCH /plans/{id}` · `DELETE /plans/{id}` | Planos: `name`, `amount_cents`, `period` (`monthly`, `quarterly`, `yearly`), `due_day` (1 a 31; no mês curto, o último dia), `active`. Excluir com assinaturas: `409 plan_in_use` |
| `GET /mensalidade/subscriptions` | Filtros `status=active,paused,ended`, `plan_id`, `q`, `phone`, `conversation_id`, `limit`, `cursor`; traz `counts` e, por assinatura, `open_count`, `overdue_count`, `overdue_cents` |
| `POST /mensalidade/subscriptions` | `plan_id` e `conversation_id` ou `phone` + `customer_name`; opcionais `amount_cents`, `discount_cents`, `due_day`, `start_date`, `end_date`, `notes`, `payer_id`, `document`, `payer_name`. Outros campos são ignorados. `billing_consent: true` (aceite de cobrança declarado pela equipe) só por administrador e com `billing_consent_evidence` (onde o cliente aceitou; sem ela, `400 consent_evidence_required`); vale também na importação |
| `POST /mensalidade/subscriptions/import` | `{"rows":[{"customer_name","phone","plan"\|"plan_id","discount_cents","due_day","start_date"}]}` (até 300); devolve `created`, `skipped` (já assinante do plano) e `errors` por linha |
| `GET /mensalidade/subscriptions/{id}` · `PATCH` | Detalhe com `installments`; alteração vale para as próximas parcelas |
| `POST /mensalidade/subscriptions/{id}/pause` · `/resume` · `/end` | Pausar e encerrar cancelam as parcelas abertas ainda não vencidas; retomar não cobra a pausa |
| `GET /mensalidade/installments` | `month=AAAA-MM` (padrão: mês atual), `status=open,overdue,paid,waived,cancelled`, `subscription_id`, `q`; traz `counts` do mês |
| `GET /mensalidade/installments/{id}` | Parcela com `payment` (`pix_code`, `url`, `expires_at`), `notices` e baixa (`paid_via` `pix`\|`link`\|`manual`, `paid_by`, `paid_note`) |
| `POST /mensalidade/installments/{id}/charge` | Reenvia o Pix/link que vale ou cria outra cobrança; `409 no_conversation`, `409 payments_not_configured`, `409 installment_not_payable` |
| `POST /mensalidade/installments/{id}/pay` | Baixa manual `{"note","paid_at":"AAAA-MM-DD","notify":true}`; registra quem deu baixa e envia o comprovante |
| `POST /mensalidade/installments/{id}/waive` | Isenta `{"note"}` |
| `GET /mensalidade/summary?month=AAAA-MM` | `expected_cents`, `received_cents`, `overdue_cents`, `open_cents`, `waived_cents`, `counts`, `received_in_month`, `overdue_total`, `payments_ready` |
| `GET /mensalidade/delinquents` | Assinaturas com parcelas vencidas: `overdue_count`, `overdue_cents`, `oldest_due_date`, `notices_sent` |
| `POST /mensalidade/generate` | Gera agora as parcelas do gancho periódico (sem avisos) |
| `GET /mensalidade/payers` · `POST` · `GET /payers/{id}` · `PATCH` | Pagadores: `name`, `document` (CPF ou CNPJ, inclusive o alfanumérico, com dígitos conferidos; repetido: `409 payer_exists`), `email`, `notes`, `phones`. Busca `q` (nome, documento, telefone), `document`, `phone`. O detalhe traz `subscriptions` e `situation` |
| `POST /mensalidade/payers/{id}/phones` · `/phones/remove` | Autoriza ou retira um telefone `{"phone","label"}` |
| `GET /mensalidade/situation?phone=…` ou `?document=…` | `status` `em_dia`, `em_atraso` (com `open_installment`) ou `sem_assinatura`, com a carência (`grace_days`) das regras; `phone_linked` diz se o telefone é autorizado. Sem pagador: `404 payer_not_found` |

Assinaturas aceitam `payer_id` ou `document` (+ `payer_name`) para ligar ao pagador; sem eles, cada assinatura cria um pagador com o próprio telefone. Planos têm `sellable` (contratação pelo WhatsApp) e `description`; as regras têm `grace_days`. A contratação pelo WhatsApp é um contrato pendente (`mensalidade.contract_created`): pagador, assinatura e primeira parcela (já paga) só nascem com o pagamento confirmado.

A parcela vira `paid` só pelo webhook assinado do provedor (cobrança do módulo `payments`) ou pela baixa manual; nunca por mensagem do cliente. Eventos (webhooks com `conversations:read`): `mensalidade.subscription_created`, `mensalidade.subscription_changed` (`change`: `updated`, `paused`, `resumed`, `ended`), `mensalidade.installment_created`, `mensalidade.charged`, `mensalidade.notice_sent` (`kind`: `before`, `due`, `overdue`), `mensalidade.overdue`, `mensalidade.paid` (`via`, `by`; `duplicate: true` quando entra um segundo pagamento), `mensalidade.waived`, `mensalidade.refunded`, `mensalidade.notice_failed` (`reason`: `no_conversation`…), `mensalidade.setup_needed` (Cobrança não configurada, no máximo uma vez por dia), `mensalidade.payer_created` e `mensalidade.payer_changed` (`change`: `updated`, `phone_added`, `phone_removed`).

### Reserva e check-in

Módulo `reserva` (desligado por padrão; guia de uso em [RESERVA.md](RESERVA.md)) para pousada, aluguel por temporada, quadra e salão. Datas em ms Unix; `start_date`, `end_date`, `arrival_time` e `departure_time` já vêm no horário de Brasília. Com o módulo desligado, tudo abaixo responde `409 module_disabled`.

- Leitura (`conversations:read`): `GET /profiles/{perfil}/reserva` (regras com os padrões, `units` e `deposit` `{available, reason, message}`: se a Cobrança está pronta para o sinal), `/reserva/units[/{id}]`, `/reserva/blocks?from_date=&to_date=`, `/reserva/availability` (diárias: `start_date` e `end_date` ou `nights`, opcional `guests`, `unit_id`; por hora: `date` e `duration_minutes`; `staff=1` como a equipe), `/reserva/calendar?from_date=&to_date=&unit_id=` (até 93 dias, `units[].cells[]` com `state` `free|pending_payment|confirmed|completed|partial|blocked`), `/reserva/bookings?status=&from_date=&to_date=&unit_id=&conversation_id=&q=&limit=` e `/reserva/bookings/{id}`.
- Cadastros (somente administrador, `Idempotency-Key`): `POST`/`PUT /reserva/units[/{id}]` `{name, mode: daily|hourly, price_cents, kind?, capacity?, description?, photos?: [https…], active?}`; `DELETE /reserva/units/{id}` (arquiva; recusa com reservas futuras); `POST /reserva/blocks` `{unit_id?, from_date, to_date?}` (dias inteiros) ou `{unit_id?, starts, ends}`; `DELETE /reserva/blocks/{id}`. As regras são a chave `reserva` de `PUT /profiles/{perfil}/settings` (antecedência, estadia mínima e máxima, entrada e saída, funcionamento por hora, sinal `deposit_type` `none|percent|fixed` com `deposit_percent`/`deposit_cents`, `deposit_method`, `deposit_deadline_minutes`, `cancellation_policy`, `customer_cancel_hours`, check-in, lembrete, saída e textos).
- Reservas (`conversations:write`, `Idempotency-Key`): `POST /reserva/bookings` `{unit_id, start_date, end_date | nights}` (diária) ou `{unit_id, starts, duration_minutes}` (por hora), com `guests?`, `conversation_id? | customer_name`, `customer_phone?`, `notes?`, `deposit?` (cobrar o sinal pela conversa), `force?` (sobre bloqueio), `notify?`; `PATCH /reserva/bookings/{id}` (unidade, datas, horário, pessoas, cliente); `POST /reserva/bookings/{id}/cancel` `{reason?}`, `/confirm` (sem sinal, pela equipe), `/deposit` (cobrar o sinal de novo) e `/checkin` (enviar o link do check-in). A gravação é atômica: dois pedidos para a mesma unidade no mesmo período nunca ficam os dois; o segundo recebe `409 unit_unavailable` (`unit_blocked` para bloqueio, `outside_rules` para as regras).
- Estados: `pending_payment` (aguardando o sinal; segura a unidade até `payment_due_at`), `confirmed`, `cancelled`, `expired` (sinal não pago no prazo; unidade liberada) e `completed` (depois da saída). O sinal sai pela Cobrança (`payment_id`, `payment_status`); só o webhook do provedor confirma. Pagamento depois de liberada: volta a `confirmed` se a unidade ainda estiver livre; senão, `reserva.payment_late` com `needs_refund`. Check-in: `checkin_status` `none|invited|sent|completed` e `checkin_answers`.
- Pela conversa: `POST /profiles/{perfil}/conversations/{id}/actions` com `{"action":"reserva_checkin","booking_id":"opcional"}` (conversa assumida ou administrador).
- WhatsApp: itens de menu `{"type":"reserva"}` (Fazer reserva) e `{"type":"reserva_mine"}` (Minhas reservas). Lista e botões nas linhas oficiais (ids `reserva:…`), opções numeradas no QR; o cliente responde CHECKIN para receber o link do check-in.
- Eventos (permissão `conversations:read` nos webhooks): `reserva.created`, `reserva.confirmed` (`by: payment|staff`, `late`), `reserva.changed` (com `previous`), `reserva.cancelled` (`reason`), `reserva.expired` (`reason`), `reserva.completed`, `reserva.payment_late`, `reserva.checkin_sent` e `reserva.checkin_completed` (`answers`). Todos trazem `booking` (a reserva completa), `conversation_id`, `actor` (`customer` quando foi o cliente) e `module_id: "reserva"`.

### Suporte pago (módulo `suporte`)

Desligado por padrão; `requires: ["mensalidade"]` (só liga com a Mensalidade ligada e sai junto quando ela é desligada com `cascade`); uso em [SUPORTE.md](SUPORTE.md). Ligado, segura (`onHandoffRequest`) toda passagem automática para humano sem liberação ativa ou assinatura em dia e conduz o cliente pelo fluxo de pagamento. Rotas em `/profiles/{perfil}/suporte`; leitura com `conversations:read`, escrita com `conversations:write` e `Idempotency-Key`. Desligado: `409 module_disabled`. A liberação vem só do pagamento confirmado pelo provedor, da situação em dia na Mensalidade ou de uma pessoa da equipe; nunca de mensagem do cliente.

| Método e caminho | O quê |
|---|---|
| `GET /suporte/releases` | Liberações: `kind` (`subscription`, `installment`, `package`, `courtesy`, `team`), `status`, `conversation_id`, `payer_id`, `from`/`to` (ms), `q`, `cursor`; traz `counts` por forma |
| `GET /suporte/purchases` | Compras de suporte avulso: `status` (`pending`, `paid`, `expired`, `cancelled`, `refunded`), `conversation_id`, `q`; traz `counts` e `paid_cents`; `attention` (`duplicate_payment`, `paid_after_cancel`, `refunded`) marca o que a equipe precisa conferir |
| `GET /suporte/offers` | Pacotes avulsos ativos, planos vendáveis oferecidos, `methods`, `payments_ready` e `mensalidade` |
| `GET /suporte/pending` | Aguardando confirmação (últimos 7 dias): quem digitou o CPF/CNPJ de um cadastro por um telefone não autorizado, e pedidos de humano em grupo (`group: true`, liberados com cortesia) |
| `GET /suporte/conversations/{id}` | Situação da conversa: `allowed` e `reason`, `release` (com `ticket_id` e `expires_at`), `session`, `awaiting_team`, `unlinked_phone` e compras |
| `POST /suporte/conversations/{id}/courtesy` | Cortesia `{"reason","hours"?}` (conversa assumida ou administrador) |
| `POST /suporte/conversations/{id}/link-phone` | Vincula o telefone da conversa ao pagador identificado pelo CPF/CNPJ (conversa assumida ou administrador) |
| `POST /suporte/conversations/{id}/confirm` | A equipe confirma a identidade de quem aguarda confirmação `{"link":true}` e libera se o pagador estiver em dia (`409 payment_required` se não) |
| `POST /suporte/releases/{id}/end` | Encerra uma liberação (administrador) |

A liberação fica presa ao protocolo e à sessão da conversa: protocolo fechado, conversa resolvida, prazo máximo (7 dias até o protocolo, 30 dias as demais, 4 horas com telefone não vinculado), assinatura fora do dia ou estorno a encerram (`suporte.release_ended` com `reason`). CPF/CNPJ de um cadastro vindo de telefone que ele não autorizou não libera nem mostra nada: a sessão fica aguardando confirmação.

Regras na chave `suporte` de `PUT /profiles/{perfil}/settings`: `department_id`, `identify` (só `linked_only`; o antigo `any` é aceito e vale como `linked_only`), `max_attempts`, `packages` (`[{id,name,price_cents,mode:"ticket"|"hours",hours?,active}]`), `offer_plans`, `plan_ids`, `methods` (`pix`, `link`) e `texts` (`offer`, `released`). Item de menu `{"type":"suporte_humano"}`. Eventos: `suporte.identified`, `suporte.identification_failed`, `suporte.released`, `suporte.awaiting_team`, `suporte.group_held` (pedido de humano num grupo, segurado), `suporte.purchase_created`, `suporte.purchase_paid`, `suporte.purchase_expired`, `suporte.purchase_attention` (`reason`: `duplicate_payment`, `paid_after_cancel`, `refunded`), `suporte.plan_contracted`, `suporte.phone_linked` e `suporte.release_ended`.

### Pedido (módulo `pedido`)

Cardápio, carrinho por link, pagamento e acompanhamento (desligado por padrão; uso em [PEDIDO.md](PEDIDO.md)). Rotas em `/profiles/{perfil}/pedido…`; leitura com `conversations:read`, escrita com `conversations:write` e `Idempotency-Key` (a mesma chave devolve a mesma resposta, sem criar outro pedido nem repetir mensagem). Valores em centavos inteiros; datas em ms; horário da loja em Brasília. Desligado: `409 module_disabled`.

| Método e caminho | O quê |
|---|---|
| `GET /pedido` | Regras da loja já com os padrões (`config`), situação (`store.open`, `reason` `open\|paused\|closed`, `opens_at`, `message`), `payments.offered` e contagem do cardápio |
| `POST /pedido/store/pause` | `{"paused":true,"message":"…"}`: loja fechada agora (qualquer pessoa da equipe). Pausar cancela os links de carrinho abertos (`web_step.cancelled`; a página responde "Link indisponível", 410) |
| `GET /pedido/menu` | Categorias com itens, grupos de adicionais e imagens do cardápio |
| `POST`/`PUT`/`DELETE /pedido/categories[/{id}]`, `/pedido/items[/{id}]`, `/pedido/groups[/{id}]`; `PUT /pedido/menu-images` | Cadastro do cardápio (só administrador). Item: `category_id`, `name`, `price_cents`, `description`, `photo_media_id` (de `POST /media`), `image_url` (HTTPS, para o carrinho), `available`, `max_quantity`, `retailer_id` (catálogo da Meta, único: `409 retailer_id_taken`), `group_ids`. Grupo: `name`, `min`, `max`, `options [{id?, name, price_cents, available}]` |
| `POST /pedido/items/{id}/availability`, `/pedido/groups/{id}/availability` | `{"available":false}` (com `option_id` no grupo): esgotado pela equipe |
| `GET /pedido/board` | Quadro da cozinha: `columns` por estado em andamento com `minutes_in_status` e `late`, `store` e `today` |
| `GET /pedido/orders` | `status=a,b`, `open=1`, `q` (cliente, número, telefone), `phone`, `conversation_id`, `from`, `to`, `limit`, `cursor`; traz `counts` por estado |
| `POST /pedido/orders` | Pedido de balcão ou integração: `items [{item_id, quantity, options {"<group_id>":["<option_id>"]}, note}]` (repetir `item_id` = outra montagem), `fulfillment`, `address`, `customer_name`, `phone`, `conversation_id`, `payment_method`, `note`, `notes`, `whatsapp_notices`. Só com `phone`, o pedido usa a conversa desse telefone; com `whatsapp_notices: true` (o cliente aceitou no balcão), abre uma na linha oficial e registra o consentimento de avisos do pedido |
| `GET /pedido/orders/{id}` | Pedido com `history` |
| `PATCH /pedido/orders/{id}` | `notes` (internas), `customer_name`, `eta_minutes` |
| `POST /pedido/orders/{id}/status` | `{"status":"…","note":"…","reason":"…","notify":true}`; transição inválida: `409 invalid_transition` |
| `POST /pedido/orders/{id}/paid` | Baixa do pagamento feito na hora; cobrança online aberta: `409 payment_online` |
| `POST /pedido/orders/{id}/payment` | `{"method":"cash"}`: forma escolhida pela equipe; já definida: `409 payment_chosen` |
| `GET /pedido/orders/{id}/ticket?columns=32\|42\|48` | Comanda: `establishment`, `order` e `text` em colunas fixas |

Estados: `awaiting_payment`, `received`, `preparing`, `ready` (retirada), `out_for_delivery` (entrega), `delivered`, `cancelled`; cada pedido traz `next_statuses`. Pagamento (`payment.status`): `choosing`, `pending` (na hora), `awaiting` (cobrança online aberta), `paid`, `expired`, `failed`, `refunded`, `cancelled`; `paid` online só pelo webhook do provedor (Cobrança). Linhas (`lines`) podem repetir o `item_id` com `slot` diferente (montagens). Regras da loja: chave `pedido` de `PUT /profiles/{perfil}/settings`. Pela conversa: `POST /profiles/{perfil}/conversations/{id}/actions` com `{"action":"pedido_link"}` envia o link do carrinho (conversa assumida). WhatsApp: itens de menu `{"type":"pedido_cardapio"}` e `{"type":"pedido_acompanhar"}`; botões com ids `pedido:pay:{pedido}:{forma}` e `pedido:receber:pickup|delivery`. MCP: `pedido_cardapio`, `pedido_consultar` e `pedido_enviar_carrinho`. Eventos (webhooks com `conversations:read`): `pedido.created`, `pedido.rejected` (carrinho recusado ao concluir: loja fechada pelo horário ou item esgotado; `via: "page"` quando a própria página recusou), `pedido.status_changed` (`from`, `to`, `actor`), `pedido.paid`, `pedido.payment_failed`, `pedido.payment_expired`, `pedido.payment_late` (pago depois de cancelado: estornar), `pedido.refunded`, `pedido.stale` (parado além do alerta), `pedido.menu_changed` e `pedido.store_changed`; todos com `module_id: "pedido"` e, quando houver, `order_id`, `number` e `conversation_id`.

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
