# Fila de espera com senha (contrato v1)

A fila de senhas mora no Wabotia. O cliente entra pelo WhatsApp ou pelo totem do
**Senhapp**; a equipe chama pelos guichês no painel (`/app/fila`); os painéis de
TV (web do Wabotia ou Senhapp) anunciam as chamadas. Este documento é o contrato
entre o Wabotia e o Senhapp. Mudança aqui vem antes de mudança de código.

> Nome: no Wabotia `tickets` são **protocolos**. A senha de fila é
> `queue_tickets` e as rotas ficam sob `/queue`.

## Conceitos

| Conceito | Tabela | Notas |
|---|---|---|
| Fila | `queues` | Prefixos `N`/`P`, proporção preferencial, modo do tempo de espera, canais. |
| Guichê | `counters` | Nome ("Guichê 2"), filas que atende, estado `open`/`paused`/`closed`, pessoa atual. |
| Senha | `queue_tickets` | Código `N023`, numeração diária por fila e tipo (fuso de Brasília). |
| Lista negra | `queue_blocklist` | Telefones impedidos de retirar senha pelo WhatsApp. |
| Painel | `queue_displays` | Link de TV com token próprio, só leitura. |

### Estados da senha

```
waiting ──call──▶ called ──start──▶ serving ──finish──▶ done
   │                 │  ▲ recall        │
   │                 │  └───────────────┘ (rechamar mantém "called")
   │                 ├──no_show──▶ no_show
   └──cancel─────────┴──cancel───▶ cancelled
transfer: called/serving ─▶ waiting (outra fila ou guichê), mantém a ordem de emissão.
```

Virada do dia: senhas `waiting`/`called`/`serving` de dias anteriores viram
`cancelled` (motivo `day_closed`) no cron de 5 minutos.

### Ordem de chamada (porta de `Vinki_v4/core/vinki-core/src/fila.rs`)

Entre as senhas `waiting` das filas do guichê (ou transferidas para ele):

1. Senha transferida diretamente para este guichê primeiro.
2. Enquanto a fila deve normais (`normals_per_preferential` − normais chamadas
   desde a última preferencial) e há normal aguardando, a normal passa à frente.
3. Preferencial antes de normal (`normals_per_preferential = 0` = sempre).
4. Fila de maior `priority`.
5. Ordem de emissão (`created_at`), número e id.

### Tempo de espera estimado

Por fila, `wait_mode`:

- `fixed`: `service_minutes` por atendimento.
- `average`: média de `finished_at − started_at` dos últimos 20 atendimentos
  concluídos do dia; sem histórico usa `service_minutes`.

`pessoas à frente`: preferencial = preferenciais aguardando; normal = normais +
preferenciais aguardando. Espera = `ceil(à frente × minutos ÷ max(1, guichês
abertos que atendem a fila))`.

## Autenticação

| Quem | Como | Escopos |
|---|---|---|
| Equipe (painel, app) | cookie `wabotia` ou `Bearer wabu_…` | pessoa com acesso à área |
| Senhapp (totem, painel, guichê) | `Bearer wab_…` do pareamento `client=senhapp` | `queue:read`, `queue:issue`, `queue:operate`, `events:read` |
| TV pelo navegador | token do painel (`queue_displays`) | só leitura |

Pareamento: igual a `docs/PAREAMENTO.md` com `client: "senhapp"`.

Toda escrita exige `Idempotency-Key` (até 200 ASCII). Repetir a mesma chave com o
mesmo corpo devolve a mesma resposta (`Idempotency-Replayed: true`).

## Rotas (base `/api/v1/profiles/{p}`)

### Leitura

| Rota | Escopo | Resposta |
|---|---|---|
| `GET /queue` | `queue:read` | `QueueOverview` |
| `GET /queue/tickets?queue_id=&status=&day=` | `queue:operate` | `{data: Ticket[]}` (dia de hoje por padrão) |
| `GET /queue/tickets/{id}` | `queue:operate` | `Ticket` |
| `GET /queue/blocklist` | pessoa | `{data: Block[]}` |
| `GET /queue/displays` | admin | `{data: Display[]}` |

`QueueOverview`:

```json
{
  "day": "2026-11-14",
  "settings": { "front_door": true, "notify_ahead": 2 },
  "queues": [{
    "id": "…", "name": "Geral", "prefix_normal": "N", "prefix_preferential": "P",
    "normals_per_preferential": 2, "priority": 0, "wait_mode": "average",
    "service_minutes": 8, "channels": ["whatsapp", "kiosk"], "enabled": true,
    "preferential_notice": "Idosos (60+), gestantes, lactantes, PcD…",
    "waiting": { "normal": 4, "preferential": 2 },
    "wait_minutes": { "normal": 35, "preferential": 10 },
    "open_counters": 2
  }],
  "counters": [{
    "id": "…", "name": "Guichê 2", "queue_ids": ["…"], "status": "open",
    "user_id": "…", "user_name": "Ana", "current": Ticket | null
  }],
  "recent_calls": [ CallFrame ]   // até 10, mais recente primeiro
}
```

`Ticket`:

```json
{
  "id": "…", "queue_id": "…", "queue_name": "Geral", "code": "N023",
  "preferential": false, "source": "whatsapp|kiosk|staff",
  "status": "waiting|called|serving|done|no_show|cancelled",
  "counter_id": null, "counter_name": null, "call_count": 0,
  "ahead": 3, "wait_minutes": 25,
  "phone": "5511…" (só para a equipe), "conversation_id": "…" | null,
  "window_open": true,   // cliente pode receber texto livre agora
  "created_at": 0, "called_at": null, "started_at": null, "finished_at": null,
  "service_day": "2026-11-14", "public_token": "…",
  "whatsapp_link": "https://wa.me/55…?text=SENHA%20N023%20AB12CD" | null
}
```

### Escrita

| Rota | Operação | Escopo / papel | Corpo |
|---|---|---|---|
| `POST /queue/queues` | `queue.save` | admin | `Queue` sem `id` |
| `PUT /queue/queues/{id}` | `queue.save` | admin | campos de `Queue` |
| `POST /queue/counters` | `counter.save` | admin | `{name, queue_ids}` |
| `PUT /queue/counters/{id}` | `counter.save` | admin | `{name?, queue_ids?, enabled?}` |
| `POST /queue/counters/{id}/state` | `counter.state` | `queue:operate` | `{status: "open"\|"paused"\|"closed"}` |
| `POST /queue/tickets` | `queue.issue` | `queue:issue` | `{queue_id, preferential, source?: "kiosk"\|"staff"}` |
| `POST /queue/counters/{id}/call-next` | `queue.call_next` | `queue:operate` | `{}` → `Ticket` ou `404 queue_empty` |
| `POST /queue/tickets/{id}/recall` | `queue.recall` | `queue:operate` | `{}` |
| `POST /queue/tickets/{id}/start` | `queue.start` | `queue:operate` | `{}` |
| `POST /queue/tickets/{id}/finish` | `queue.finish` | `queue:operate` | `{}` |
| `POST /queue/tickets/{id}/no-show` | `queue.no_show` | `queue:operate` | `{}` |
| `POST /queue/tickets/{id}/cancel` | `queue.cancel` | `queue:operate` | `{reason?}` |
| `POST /queue/tickets/{id}/transfer` | `queue.transfer` | `queue:operate` | `{queue_id}` ou `{counter_id}` |
| `POST /queue/blocklist` | `queue.block` | pessoa (operador se permitido) | `{phone \| ticket_id \| conversation_id, days?: number\|null, note?}` |
| `DELETE /queue/blocklist/{id}` | `queue.unblock` | admin | — |
| `POST /queue/displays` | `queue.display.create` | admin | `{name, queue_ids?}` → `{id, token, url}` (token só aparece aqui) |
| `DELETE /queue/displays/{id}` | `queue.display.revoke` | admin | — |

`POST /queue/tickets` responde `Ticket` (com `ahead`, `wait_minutes`,
`whatsapp_link`). O totem imprime o cupom com esses campos.

Configuração geral fica em `PUT /settings` na chave `queue`:

```json
{
  "queue": {
    "front_door": false,          // qualquer 1ª mensagem da sessão recebe o menu
    "notify_ahead": 2,            // avisa quando faltar N senhas (0 = não avisa)
    "max_daily_per_contact": 3,   // senhas por telefone por dia
    "kiosk_per_minute": 6,        // emissões por minuto por aparelho do totem
    "block_no_shows": 3,          // ausências…
    "block_window_days": 30,      // …nesta janela…
    "block_days": 7,              // …bloqueiam por estes dias (dobra na reincidência)
    "block_too_many": true,       // tentar passar do limite diário 3× no dia bloqueia
    "operators_can_block": true,
    "blocked_can_talk": true      // bloqueado ainda vê "Falar com atendente"
  }
}
```

### Erros

| Código | HTTP | Quando |
|---|---|---|
| `queue_not_found` / `counter_not_found` / `ticket_not_found` | 404 | id inexistente na área |
| `queue_closed` | 409 | fila desativada ou sem o canal pedido |
| `queue_empty` | 404 | nada para chamar neste guichê |
| `counter_closed` | 409 | guichê fechado/pausado ao chamar |
| `invalid_transition` | 409 | ação não permitida no estado atual |
| `contact_blocked` | 403 | telefone na lista negra |
| `daily_limit` | 429 | limite diário por telefone |
| `kiosk_rate` | 429 | totem emitindo rápido demais |

## Tempo real

### WebSocket

- Senhapp/equipe: `GET /api/v1/profiles/{p}/queue/ws` com `Authorization: Bearer …`
  (escopo `queue:read`).
- TV no navegador: `GET /api/public/queue-display/ws` com
  `Sec-WebSocket-Protocol: wabotia-display, <token>`.

Frames do servidor (JSON):

```json
{ "type": "snapshot", "data": QueueOverview }
{ "type": "call", "data": CallFrame }
{ "type": "pong" }
```

`CallFrame`:

```json
{
  "ticket_id": "…", "code": "N023", "preferential": false,
  "queue_id": "…", "queue_name": "Geral",
  "counter_id": "…", "counter_name": "Guichê 2",
  "call_count": 1, "recall": false, "at": 0,
  "speech": "Senha N 23, Guichê 2"
}
```

O cliente pode mandar `{"type":"ping"}`; recebe `pong`. Depois de qualquer
mudança na fila o servidor manda `call` (se houve chamada) e um `snapshot` novo.
Sem WebSocket, use `GET /queue` a cada 3–5 s ou `GET /events?after=` (eventos
`queue.*`).

### Eventos (`events`, webhooks, push)

`queue.issued`, `queue.called`, `queue.recalled`, `queue.started`,
`queue.finished`, `queue.no_show`, `queue.cancelled`, `queue.transferred`,
`queue.counter`, `queue.blocked`, `queue.unblocked`, `queue.changed` (config).

## WhatsApp

1. Mensagem do cliente abre a janela de 24 h. Com `queue.front_door` ligado, a
   primeira mensagem de cada sessão (qualquer texto, mídia ou áudio) recebe o
   menu principal, mesmo com Bot Atendente.
2. Menu tipo `queue` ("Entrar na fila de espera"): mostra aguardando e espera
   por tipo e pergunta "Deseja entrar na fila?" — **Sim / Não / Voltar ao menu**.
3. Sim → "Qual tipo de senha?" — **Normal / Preferencial / Voltar**.
4. Emite e confirma com código, pessoas à frente e espera. `SENHA` mostra a
   posição; `SAIR` desiste.
5. Avisos: faltam N, chamada ("Senha N023 — dirija-se ao Guichê 2"),
   rechamada, transferência. Dentro da janela: texto. Fora: modelo
   (`notifications.template_name`, variáveis `{{1}}` = "Senha N023", `{{2}}` =
   texto do aviso). Sem modelo, o guichê vê "fora da janela".
6. Cupom do totem: QR `wa.me/<linha>?text=SENHA N023 <código>` vincula a senha
   ao telefone e abre a janela.

Botões só nas linhas Zernio/Meta; nas linhas QR o mesmo conteúdo vai como texto
numerado e as respostas digitadas (sim, não, normal, preferencial, 1, 2, 3)
funcionam em todas.

## Lista negra

- 1 senha ativa por telefone por fila; `max_daily_per_contact` por dia.
- `block_no_shows` ausências em `block_window_days` → bloqueio automático por
  `block_days` (dobra a cada reincidência). `SAIR` antes da chamada não conta.
- Bloqueado recebe: "Você está impedido de retirar senha pelo WhatsApp até
  DD/MM por ausências seguidas. Procure o atendimento presencial."
- Senha do totem vinculada a número bloqueado continua válida no balcão, mas o
  vínculo e os avisos não são feitos.
