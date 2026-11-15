# Módulos do Wabotia

Contrato para escrever uma vertical (Agenda, Pedido, Ordem de Serviço,
Reserva, Mensalidade…) **sem ler o motor**. Um módulo roda no mesmo Worker e
no mesmo banco do atendimento, é ligado e desligado por área de atendimento em
**Gestão → Módulos** e fala com o núcleo só pela interface de
`src/modules/api.ts`. Os dois módulos de referência são a **Fila presencial**
(`src/modules/queue.ts`, código antigo em `src/queue.ts`) e os
**Formulários** (`src/modules/forms/`), escrito do jeito que a onda 2 deve
escrever.

## Regras que não mudam

- Sem Worker, banco, bucket ou classe de Durable Object novos. Tempo real
  reaproveita o `Coordinator` da área. `wrangler.jsonc` não muda.
- Migrações só na faixa reservada ao módulo (veja `PLANO-VERTICAIS.md`),
  aditivas, com tabelas de prefixo próprio (`agenda_`, `order_`…). Toda tabela
  tem `profile_id`.
- Textos de interface em português do Brasil. Datas em milissegundos Unix;
  dias de serviço no horário de Brasília (`src/business-time.ts`).
- O módulo nunca grava em tabelas do núcleo diretamente. Mensagem, passo web,
  evento e contato passam pela interface abaixo; protocolo, pela API pública
  ou pelo passo web.

## Arquivos de um módulo

| Onde | O quê |
|---|---|
| `src/modules/<id>/definition.ts` | Declaração (só dados), importada pelo registro |
| `src/modules/<id>/<id>.ts` | Código: rotas, comandos, ganchos |
| `src/modules/registry.ts` | Acrescente a declaração em `modules` |
| `src/modules/runtime.ts` | Acrescente `import "./<id>/<id>";` |
| `migrations/00NN_<id>_*.sql` | Tabelas na faixa reservada |
| `web/modules/<id>/` | Telas do painel |
| `tests/<id>-*.test.ts` | Testes |

## 1. Declaração (`ModuleDefinition`, `src/modules/types.ts`)

```ts
export const agendaModule: ModuleDefinition = {
  id: "agenda",                 // estável, minúsculo; vira module_id
  name: "Agenda",
  version: "1.0.0",             // versão do contrato do módulo (semver)
  description: "Serviços, profissionais, horários e lembretes.",
  builtin: true,
  default_enabled: false,       // áreas existentes não ganham nada sozinhas
  navigation: [
    { id: "agenda", label: "Agenda", place: "rail", admin: false },
    { id: "agenda-settings", label: "Serviços e horários", place: "admin", admin: true },
  ],
  menu_item_types: [
    {
      type: "agenda",
      label: "Agendar horário",
      description: "Mostra os horários livres e confirma pelo WhatsApp.",
      // opcional: o núcleo recusa salvar item apontando para registro inexistente
      reference: { field: "service_id", setting: "agenda", label: "Serviço" },
    },
  ],
  events: ["agenda.booked", "agenda.cancelled"],
  settings: [{ key: "agenda", description: "Antecedência, lembretes…" }],
  routes: ["agenda"],           // /api/v1/profiles/:profile/agenda/…
  operations: ["agenda."],      // comandos agenda.*
  scopes: [],                   // permissões novas exigem combinar com a sessão A
};
```

O que o núcleo faz com cada campo:

| Campo | Efeito |
|---|---|
| `default_enabled` | Estado de uma área sem registro em `profile_modules` |
| `navigation` | Tela Módulos e `GET /modules`; o painel esconde as páginas listadas em `pageModules` (`web/workspace-navigation.ts`) com o módulo desligado |
| `menu_item_types` | Tipos aceitos em `PUT /settings` (`menus`); desligado, os itens somem do WhatsApp e do editor, ficam guardados e voltam ao religar |
| `events` | Únicos tipos que `ctx.publish` aceita; entram nos webhooks com a permissão `conversations:read` |
| `settings` | Chaves das configurações da área que o módulo valida (`onSettingsSave`) |
| `routes` | Com o módulo desligado, `/profiles/:profile/<rota>/…` responde `409 module_disabled` |
| `operations` | Com o módulo desligado, os comandos com esses prefixos respondem `409 module_disabled` |

## 2. Interface interna (`src/modules/api.ts`)

`modulesApi(env, profile, moduleId)` devolve um `ModuleContext`:

| Método | Para quê |
|---|---|
| `enabled()` / `requireEnabled()` | Estado do módulo na área (`409 module_disabled`) |
| `access(actor, scope)` | Mesma regra das rotas: área do ator e permissão da chave de aplicação |
| `settings()` | Configurações da área (já mescladas com os padrões) |
| `conversation(id, actor?)` | Conversa da área, respeitando a visibilidade do ator |
| `contact(c)` | Contato vinculado à conversa (`id, name, phone, email, company, notes`) ou `null` |
| `sendMessage(c, {text, content?, attachments?}, {key, actor?, notification?})` | Mensagem ao cliente pela fila de entrega; `key` torna idempotente; `notification: true` usa o modelo de notificação com a janela de 24 h fechada |
| `openWebStep(c, request)` | Abre um passo web do módulo (seção 4) |
| `publish(kind, id, payload)` | Evento declarado em `events`; o núcleo acrescenta `module_id` |

Ganchos registrados no carregamento do arquivo do módulo:

| Gancho | Quando roda |
|---|---|
| `onSettingsSave(module, key, validate)` | `PUT /settings` com a chave; devolva o valor normalizado ou lance `ApiError` |
| `onMenuChoice(type, handler)` | Cliente escolhe um item do tipo no menu do WhatsApp (só com o módulo ligado e fora de grupos) |
| `onConversationAction(module, action, handler)` | `POST /conversations/:id/actions` com `{"action":"<nome>"}`; o núcleo já conferiu `conversations:write` e a visibilidade; quem pode agir é regra do módulo |
| `onWebStepCompleted(module, hook)` | Cliente concluiu um passo web aberto pelo módulo |
| `onCommand(module, op, handler)` | Comando de escrita do módulo, executado no `Coordinator` da área com idempotência e auditoria |
| `onRoute(module, {method, path, op})` | Liga `POST/PUT/PATCH/DELETE /profiles/:profile/<path>` ao comando `op` (corpo + `:id` viram `data`; exige `Idempotency-Key`) |
| `onRead(module, path, handler)` | `GET /profiles/:profile/<path>` sem passar pelo `Coordinator` |
| `onSchedule(module, handler)` | Tarefa periódica (lembrete, vencimento): `handler(ctx, {now})` em cada área com o módulo ligado, no máximo uma vez por minuto e ao menos a cada 5 minutos; veja abaixo |
| `onInboundContent(module, type, handler)` | Cliente mandou conteúdo estruturado: `"order"` (carrinho do catálogo, `content.order`) ou `"flow_reply"` sem passo web correspondente (`content.flow_reply`). Roda antes do menu e do bot; devolva `true` quando tratou |

Exemplo mínimo (do módulo Formulários):

```ts
import { onCommand, onMenuChoice, onRead, onRoute, onSettingsSave, onWebStepCompleted } from "../api";

onSettingsSave("forms", "forms", validateForms);

onMenuChoice("form", async (ctx, c, item, { rowId }) => {
  await sendForm(ctx, c, item.form_id, { trigger: "menu", actor: "system", sourceKey: `menu:${rowId}` });
});

// GET /api/v1/profiles/:profile/forms
onRead("forms", "forms", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  return { data: /* … */ [] };
});

// POST /api/v1/profiles/:profile/forms/:id/send  {conversation_id}
onRoute("forms", { method: "POST", path: "forms/:id/send", op: "form.send" });
onCommand("forms", "form.send", async (ctx, actor, data, { requestId }) => {
  ctx.access(actor, "conversations:write");
  const c = await ctx.conversation(data.conversation_id, actor);
  // … regra de quem pode agir, depois:
  return (await sendForm(ctx, c, data.id, { trigger: "agent", actor: actor.id, sourceKey: `command:${actor.id}:${requestId}` })).step;
});

onWebStepCompleted("forms", async (ctx, step, answers) => {
  await ctx.publish("form.submitted", step.id, { form_id: step.ref_id, answers });
});
```

Escritas: prefira `onRoute` + `onCommand`. O comando roda serializado no
`Coordinator` da área (como `queue.*`), com recibo de idempotência, auditoria e
alarme agendado ao final, então mensagens enfileiradas saem sozinhas. O
núcleo confere a área do ator e o estado do módulo; **a permissão
(`ctx.access`) e a regra de quem pode agir ficam com o comando**. Leia o ator
recebido; não confie em `actor`/`user_id` vindos do corpo. A resposta do
comando é gravada no recibo e devolvida igual ao repetir a mesma
`Idempotency-Key`.

Documente as rotas novas em `src/modules/openapi.ts` (lista
`moduleOperations` e `describeModuleOperation`) e em `docs/API.md`.

### Tarefas periódicas (`onSchedule`)

```ts
import { onSchedule } from "../api";
import { runDue } from "./reminders";   // função pura, testável com qualquer `now`

onSchedule("agenda", async (ctx, { now }) => {
  await runDue(ctx, now);
});
```

- Quem chama: o alarme do `Coordinator` de cada área, serializado com o
  resto do atendimento da área. O cron do Worker (`*/5 * * * *`) acorda todas
  as áreas, então a rodada acontece **ao menos a cada 5 minutos**; quando há
  movimento, **no máximo uma vez por minuto** (`SCHEDULE_INTERVAL_MS`).
- Só roda em áreas com o módulo ligado. `now` é o instante da rodada (ms
  Unix); use-o em vez de `Date.now()` para testar e para calcular janelas.
- O horário não é exato: escolha "o que venceu até `now` e ainda não foi
  feito" (por exemplo `lembrete_enviado_em IS NULL AND horario-24h <= now`) e
  marque o registro na mesma rodada. Envie com chave de idempotência derivada
  do registro (`ctx.sendMessage(c, …, { key: "lembrete:" + id })`): uma rodada
  repetida não repete a mensagem.
- Uma exceção é registrada no log (`component: "module-schedule"`) e não
  impede os outros módulos; a próxima rodada tenta de novo.
- Nos testes, chame `runModuleSchedules(env, profile, now)`
  (`src/modules/schedule.ts`) ou a sua função `runDue` diretamente.
- Mensagens fora da janela de 24 horas em linha oficial só saem como
  notificação (`notification: true`), pelo modelo configurado.

Chaves de idempotência: use sempre algo derivado do pedido (`rowId` do menu,
`requestId` do comando, id do registro). Repetir a mesma chave não repete
mensagem, passo web nem protocolo.

## 3. Rotas, permissões e erros

- Rotas do módulo moram sob `/api/v1/profiles/:profile/<rota>`, com `<rota>`
  declarada em `routes`. O núcleo já autenticou o ator (cookie, `wabu_` ou chave
  de aplicação) e responde `409 module_disabled` com o módulo desligado.
- Leituras públicas (sem login) não existem para módulos nesta versão: use o
  passo web.
- Erros: lance `ApiError(status, code, mensagem)` (`src/types.ts`) com
  mensagem em português para quem usa. `requireValue(valor, mensagem)` gera
  `400 invalid_request`.
- Permissões de aplicação: reutilize as existentes (`conversations:*`,
  `contacts:*`, `tickets:*`). Uma permissão nova entra na lista de
  `src/service.ts` e no OpenAPI; combine antes.

## 4. Passo web

Link curto de uso único, amarrado à conversa, que leva o cliente a uma página
leve e o devolve ao WhatsApp. Hoje a página é um **formulário** gerado pelo
núcleo a partir de campos; o módulo não escreve HTML.

```ts
const { step, url, created } = await ctx.openWebStep(c, {
  kind: "checkin",                 // tipo dentro do módulo
  ref: reservation.id,             // registro do módulo (vira ref_id)
  trigger: "module",               // menu | agent | bot | module
  actor: "system",
  sourceKey: `checkin:${reservation.id}`,
  ttlMinutes: 48 * 60,             // 5 min a 7 dias; padrão 24 h
  text: "Faça o check-in antes de chegar:",
  button: "Fazer check-in",        // botão com URL nas linhas oficiais (até 20)
  spec: {
    title: "Check-in",
    intro: "Leva um minuto.",
    fields: [
      { id: "doc", type: "text", label: "Documento", required: true },
      { id: "chegada", type: "date", label: "Data de chegada", required: true },
      { id: "quarto", type: "choice", label: "Cama", required: true, options: ["Casal", "Solteiro"] },
      { id: "regras", type: "accept", label: "Li as regras da casa", required: true },
    ],
    done_text: "Check-in feito!",
    return_text: "Check-in recebido. Até breve!",
    ticket: "none",                // attach | open | none
  },
});
```

- Campos: `text` (opcional `multiline`), `choice` (2 a 20 `options`), `date`
  (AAAA-MM-DD) e `accept` (caixa que precisa ser marcada quando `required`).
  Até 30 campos. As respostas chegam como `{ [id]: string | boolean }`.
- Estados: `sent` → `opened` → `completed`, ou `expired` (venceu) e
  `cancelled` (equipe cancelou). Cada mudança publica `web_step.<estado>`
  com `conversation_id`, `module_id`, `kind` e `ref_id`.
- Uso único: a conclusão é um `UPDATE` condicionado ao estado; o segundo
  envio vê "Este link já foi usado". O código tem ~93 bits, só o hash é
  guardado e a página usa `Referrer-Policy: no-referrer`.
- Ao concluir, o núcleo: grava as respostas; anexa ao protocolo ativo (ou abre
  um, com `ticket: "open"`); registra nota interna na conversa; envia o
  retorno no WhatsApp (modelo de notificação se a janela de 24 h estiver
  fechada); publica `web_step.completed`; chama `onWebStepCompleted` do
  módulo. A página mostra **Voltar ao WhatsApp** com o `wa.me` da linha.
- Fora da janela de 24 h numa linha oficial, só o gatilho `menu` envia o link
  (o cliente acabou de escrever); os demais recebem `400` pedindo que o
  cliente escreva antes.
- O endereço do link é a origem pública vista nas requisições ao painel e
  aos apps de pessoas (`instance_settings.public_origin`). Sem ela,
  `409 origin_unknown`.
- **Entrega.** Numa linha oficial com `flow: {flow_id, flow_cta?, screen?}`
  (Flow publicado na conta, `src/whatsapp-flows.ts`), o passo sai como Flow
  nativo com `flow_token = "<flow_id>:<id do passo>"`, guardado em
  `web_steps.flow_token`; sem Flow, botão com URL (`cta_url`); em linha QR, o
  texto com o link. As três formas saem por `sendInteractive`
  (`src/line-service.ts`) e o texto guardado sempre leva o link da página.
  Os nomes dos campos do Flow precisam ser os `id` dos campos de `spec`.
  O módulo Formulários usa `flow_id`, `flow_cta` e `flow_screen` do formulário.
- **Resposta por Flow.** O recebimento normaliza a resposta em
  `content.type: "flow_reply"` (`src/whatsapp-inbound.ts`). O `processInbox`
  trata isso antes do menu e do bot (`src/structured-inbound.ts`): o
  `flow_token` de um passo desta conversa conclui o passo com as mesmas regras
  da página (validade, uso único, protocolo, nota e retorno no WhatsApp). Um
  Flow incompleto pede reenvio; repetido, avisa que já recebeu. Booleanos
  valem para `accept`; data em milissegundos vira AAAA-MM-DD.
- **Carrinho e Flow sem dono.** `"order"` e `"flow_reply"` sem passo web vão
  primeiro aos módulos (`onInboundContent`); sem dono, a conversa com o bot
  vai para a equipe com o resumo como pedido, e uma conversa com atendente só
  guarda a mensagem. O resumo em texto nunca abre o menu.
- Flows com endpoint próprio (`data_exchange`) não são hospedados pelo
  Wabotia; use Flows de navegação.
- Links já enviados guardam uma cópia dos campos: editar o formulário depois
  não muda o que o cliente vê nesse link.

## 5. Painel web

- Telas do módulo em `web/modules/<id>/`. Para uma página de Gestão: inclua
  o id em `sections`, num grupo de `workspaceGroups`, em `adminPages` (se for
  só de administrador) e em `pageModules` (`web/workspace-navigation.ts`); o
  endereço em `pageSlugs` (`web/lib/routes.ts`); e o `case` em
  `web/admin/AdminArea.tsx`. Siga `web/DESIGN.md` e as páginas de
  `web/admin/` (ex.: `FormsPage.tsx`).
- `useApp().moduleOn("<id>")` diz se o módulo está ligado na área (vem de
  `GET /status`, campo `modules`).
- A demonstração (`web/lib/demo.ts`) responde `GET /modules`; acrescente o
  módulo para as telas de referência.

## 6. Aplicativos e integrações

- `GET /api/v1/capabilities` lista, por área alcançada pela credencial
  (pessoa ou aparelho pareado), os módulos **ligados** com versão, e os
  recursos do núcleo em `features` (`modules`, `web_steps`). O app só mostra a
  tela de um módulo presente na lista; um 409 `module_disabled` numa rota do
  módulo deve esconder a tela até a próxima consulta.
- Caminhos aceitos, todos com a mesma resposta:
  `GET /api/v1/profiles/{p}/capabilities` (também traz `modules` no topo, com
  os módulos ligados daquela área), `GET /api/v1/capabilities?profile={p}` e
  `GET /api/v1/capabilities?profile_id={p}`. A área fora do alcance da
  credencial responde `404`.

  ```json
  {
    "capabilities_version": 1,
    "server": { "service": "wabotia", "version": "0.19.3", "commit": "…" },
    "features": ["modules", "web_steps"],
    "actor": { "id": "app:…", "kind": "app", "role": "service" },
    "profiles": [{ "id": "…", "name": "…", "enabled": true,
                   "modules": [{ "id": "queue", "name": "Fila presencial", "version": "1.0.0" }] }],
    "modules": [{ "id": "queue", "name": "Fila presencial", "version": "1.0.0" }]
  }
  ```

  (`modules` no topo só existe no caminho por área.) O id da fila é `queue`;
  o dos formulários, `forms`.
- O evento `module.changed` (`{module_id, enabled, version}`) avisa quando um
  administrador liga ou desliga; aplicações da área o recebem em
  `GET /events` independentemente das permissões.
- Ferramentas MCP do núcleo para bots: `list_forms`, `send_form` e
  `list_web_steps`. Um módulo que quiser ferramentas próprias combina com a
  sessão A (o MCP mora em `src/mcp.ts`).

## 7. Testes

Use `tests/service-center-fixture.ts` (`fixture`, `receive`, `drain`,
`configure`, `bearer`, `application`, `api`). Para o passo web, grave a origem
pública antes (`INSERT INTO instance_settings … 'public_origin'`) e abra o
link com `SELF.fetch("https://test/api/w/<código>")`, como em
`tests/web-steps.test.ts`. Cubra pelo menos: módulo desligado (rotas `409`,
menu sem o item), o comando com repetição da mesma `Idempotency-Key` e o
ciclo do passo web do módulo.

## Fila presencial (módulo `queue`)

Primeiro módulo da lista, registrado sem mover código: as regras continuam
em `docs/FILA-SENHAS.md`. Desligada, as rotas `/queue`, os comandos
`queue.*`/`counter.*`, o painel de TV (`/api/public/queue-display/*`) e o
acompanhamento público (`/api/public/queue/*`) respondem `409 module_disabled`;
SENHA, SAIR, o cupom do totem e a porta de entrada deixam de responder no
WhatsApp; o item "Entrar na fila de espera" some do menu. Instalações
anteriores aos módulos continuam com a fila ligada (migração `0020`).
