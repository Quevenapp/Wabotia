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
| `requires` | Opcional: ids dos módulos dos quais este depende (veja abaixo) |

### Dependência entre módulos (`requires`)

```ts
export const suporteModule: ModuleDefinition = { id: "suporte", requires: ["mensalidade"], … };
```

- **Ligar**: o dependente só liga com todos os requeridos ligados; senão
  `PUT /modules/suporte` responde `409 module_requires` ("Suporte pago depende
  de Mensalidade. Ligue esse módulo antes."). A tela Módulos mostra "Depende
  de" e trava o botão até o requerido ligar.
- **Desligar o requerido** com dependentes ligados responde
  `409 module_required` listando os dependentes. Com `{"enabled":false,
  "cascade":true}` (a tela Módulos pede confirmação e envia), o requerido e os
  dependentes desligam juntos; cada um publica `module.changed`, os
  dependentes com `because`. A resposta traz `also_disabled`. Religar o
  requerido não religa os dependentes.
- **Estado efetivo**: com um requerido desligado, o dependente conta como
  desligado em todo lugar (`GET /modules`, capacidades, rotas, menus,
  ganchos), mesmo que a linha salva diga ligado.
- **Só `public.ts`**: um módulo usa do outro apenas `src/modules/<id>/public.ts`,
  que o requerido mantém como contrato estável (funções que recebem
  `ModuleContext`, tipos de leitura). Nunca importe outros arquivos do
  requerido nem leia ou grave as tabelas dele (`mensalidade_`…). Mudança que
  quebre `public.ts` exige subir a `version` do requerido e ajustar os
  dependentes na mesma entrega.
- Declare em `requires` todo módulo cujo `public.ts` você importa: é assim
  que o núcleo garante que ele está ligado quando o seu código roda.
- Exemplo em uso: o Suporte pago tem `requires: ["mensalidade"]`. Desligar a
  Mensalidade desliga o Suporte. Para vender só o atendimento avulso, deixe a
  Mensalidade ligada e desmarque "Oferecer planos mensais" nas regras do
  Suporte.

## 2. Interface interna (`src/modules/api.ts`)

`modulesApi(env, profile, moduleId)` devolve um `ModuleContext`:

| Método | Para quê |
|---|---|
| `enabled()` / `requireEnabled()` | Estado do módulo na área (`409 module_disabled`) |
| `access(actor, scope)` | Mesma regra das rotas: área do ator e permissão da chave de aplicação |
| `mayRead(actor, "contacts"\|"notes")` | Dado sensível nas leituras, como no núcleo: pessoas da equipe sempre; aplicação só com `contacts:read` (dados pessoais) ou `notes:read` (notas internas). Veja "Dados pessoais, notas e cobrança" na seção 3 |
| `redact(actor, row, {contacts?, notes?})` | Cópia do registro sem os campos que o ator não pode ver; os campos somem da resposta |
| `verifiedPhone(c)` | Telefone autenticado pelo canal (só dígitos) ou null: grupo ou conversa de integração (`app:<id>`), cujo `external_id` é escolhido por quem chama. Compare ou vincule registros por telefone só com ele; nunca use `c.phone \|\| c.external_id` como identidade |
| `note(c, text)` | Nota interna na conversa (só a equipe vê), por exemplo uma pendência depois de estorno |
| `settings()` | Configurações da área (já mescladas com os padrões) |
| `activeTicket(c)` | Protocolo ativo da conversa (não resolvido nem fechado, o mais recente) ou null: `{id, number, status, title, created}`. Para regras como "vale até o protocolo fechar", sem ler a tabela `tickets` |
| `conversationByPhone(phone, {open?, connection_id?})` | Conversa individual da área com o telefone (aceita com e sem o 9 do celular; sem DDI, no formato brasileiro, recebe 55), ou null. Com `open: true`, abre uma na linha oficial (Zernio) para o cliente que nunca escreveu: nasce sem janela de 24 h, então só sai notificação por modelo (`notification: true`, com o consentimento da finalidade) até ele responder, e a resposta cai na mesma conversa mesmo que o WhatsApp mande outro identificador. Publica `conversation.created` com `opened_by: "module:<id>"` |
| `handoff(c, {target?, summary?, flags?, reason?, key?})` | Passa a conversa para atendimento humano: `target: {department_id}` (setor), `{user_id}` (pessoa, como a transferência da equipe) ou nada (fila geral). `summary` (até 3000) e `flags` (até 10, de até 60 caracteres, ex. "telefone não vinculado") viram nota interna e o campo `handoff` `{module, summary, flags, at}` do detalhe da conversa, mostrado no painel; somem na próxima passagem sem módulo e ao encerrar. Com `key`, repetir não passa de novo. Não passa pelos ganchos `onHandoffRequest` (é como o módulo libera a conversa que segurou). Devolve a conversa atualizada |
| `establishment()` | Dados do estabelecimento para cupom, comanda, recibo e mensagens: `{name, document, document_type: "cpf"\|"cnpj"\|null, document_display, address, phone, footer, configured}`. Sem cadastro, `name` é o nome da área e `configured` é falso. Os aplicativos leem o mesmo em `GET /profiles/{p}/establishment`; as páginas do passo web já mostram nome no cabeçalho e o resto no rodapé |
| `conversation(id, actor?)` | Conversa da área, respeitando a visibilidade do ator |
| `contact(c)` | Contato vinculado à conversa (`id, name, phone, email, company, notes`) ou `null` |
| `sendMessage(c, {text, content?, attachments?}, {key, actor?, notification?})` | Mensagem ao cliente pela fila de entrega; `key` torna idempotente; `notification: true` usa o modelo de notificação com a janela de 24 h fechada |
| `sendMessage`/`sendInteractive`: `purpose` | Notificação fora da janela de 24 h: com `purpose` (`billing`, `scheduling`, `order`, `booking`), só sai com o consentimento dessa finalidade (`recordConsent`); sem `purpose`, vale o consentimento de protocolo, como antes. As cobranças do núcleo saem como `billing` |
| `cancelWebStep(id)` / `cancelWebSteps({kind?, ref?})` | Cancela um link aberto do próprio módulo, ou todos os abertos com o `kind` (e o `ref`) dados, por exemplo os carrinhos quando a loja pausa. Quem abrir vê "Link indisponível"; publica `web_step.cancelled` com `actor: "module:<id>"`. Link já fechado fica como está; de outro módulo, 404 |
| `openWebStep(c, request)` | Abre um passo web do módulo (seção 4). Linha oficial com a janela de 24 h fechada: `409 window_closed` (fora do menu); troque por um convite com `sendMessage(…, {notification: true})` |
| `publish(kind, id, payload, {key?})` | Evento declarado em `events`; o núcleo acrescenta `module_id`. Com `key`, publicar de novo a mesma chave não duplica (use algo como `${id}:${updated}`) |
| `sendInteractive(c, spec, {key, actor?, notification?})` | Botões, lista, Flow, produto… (`spec` de `src/whatsapp-interactive.ts`): nativo na linha oficial, texto numerado com links no QR; `notification: true` fora da janela manda o texto pelo modelo de notificação |
| `charge(c, {method, amount_cents, description, ref?, sourceKey, expiresMinutes?, notification?, receipt?})` | Cobrança Pix ou link pela conta da área (seção "Cobrar"). `receipt: false`: o núcleo não manda o "Pagamento recebido" (o módulo manda o próprio comprovante no `onPaymentUpdated`) |
| `recordConsent(c, {purpose, source, status?, evidence?, key?})` | Consentimento de notificação por finalidade (`billing`, `scheduling`, `order`, `booking`), registrado quando o cliente contrata, agenda, pede ou reserva pelo WhatsApp (`source: "whatsapp"`) ou a equipe registra o aceite (`"panel"`, `"contract"`), com data, módulo e evidência. Publica `consent.updated`. REVOGAR do cliente revoga todas as finalidades; um novo aceite depois vale de novo |
| `consent(c, purpose)` | Último registro que vale para a finalidade (o dela ou o REVOGAR geral), ou null |
| `cancelCharge(payment \| id)` | Cancela uma cobrança aberta pelo próprio módulo (reserva cancelada antes do sinal), no provedor também. Já cancelada ou expirada: devolve como está; paga ou estornada: `409 payment_closed`; de outro módulo: 404 |
| `paymentsReady()` | Se a área pode cobrar agora, sem ler tabelas do núcleo: `{ready, reason: "payments_disabled"\|"payments_not_configured"\|null, message, methods}` |

Ganchos registrados no carregamento do arquivo do módulo:

| Gancho | Quando roda |
|---|---|
| `onSettingsSave(module, key, validate)` | `PUT /settings` com a chave; devolva o valor normalizado ou lance `ApiError`. Objeto parcial chega já mesclado com o salvo (os campos que não vieram ficam como estavam); lista ou valor simples substitui |
| `onMenuChoice(type, handler)` | Cliente escolhe um item do tipo no menu do WhatsApp (só com o módulo ligado e fora de grupos) |
| `onConversationAction(module, action, handler)` | `POST /conversations/:id/actions` com `{"action":"<nome>"}`; o núcleo já conferiu `conversations:write` e a visibilidade; quem pode agir é regra do módulo |
| `onWebStepValidate(module, validator)` | Última conferência antes de concluir um passo web do módulo (depois da validação dos campos e do recálculo do carrinho): devolva um texto para recusar (loja fechou, item esgotou). A página mostra o motivo no lugar de "Pedido enviado!", com o que o cliente preencheu, e o link continua aberto. Erro no gancho recusa com aviso genérico. Resposta por Flow recusada recebe o motivo na conversa |
| `onWebStepCompleted(module, hook)` | Cliente concluiu um passo web aberto pelo módulo. Aberto com `spec.return_message: "module"`, o núcleo não manda o retorno padrão e a string devolvida pelo gancho vira o retorno. O passo já está concluído: erro no gancho vai para o log e não muda a página |
| `onMcpTool(module, tool)` | Ferramenta para bots (MCP), traduzida para uma rota da API v1; veja "Ferramentas para bots" |
| `onCommand(module, op, handler)` | Comando de escrita do módulo, executado no `Coordinator` da área com idempotência e auditoria. O `requestId` (também em `onConversationAction`) é opaco: 32 hexadecimais únicos por credencial, área, operação e Idempotency-Key, iguais nas repetições. Use-o em `sourceKey` e ids derivados; nunca use a chave do cliente diretamente |
| `onRoute(module, {method, path, op})` | Liga `POST/PUT/PATCH/DELETE /profiles/:profile/<path>` ao comando `op` (corpo + `:id` viram `data`; exige `Idempotency-Key`) |
| `onRead(module, path, handler)` | `GET /profiles/:profile/<path>` sem passar pelo `Coordinator` |
| `onConversationTurn(module, handler)` (apelido `onInboundReply`) | Próxima mensagem do cliente numa conversa individual: `handler(ctx, c, {text, replyId, rowId})`; devolva `true` quando é do módulo. Veja "Conversa no chat" abaixo |
| `onPaymentUpdated(module, hook)` | Cobrança aberta pelo módulo mudou: `paid`, `expired`, `cancelled` ou `refunded`. Entrega durável: se o gancho lançar, a mudança fica pendente e o núcleo repete (reenvio do webhook e alarme, com intervalo de 1 min dobrando até 1 h) até concluir, em ordem e com o `status` daquela mudança. O gancho deve ser idempotente (use chaves de origem) |
| `onSchedule(module, handler)` | Tarefa periódica (lembrete, vencimento): `handler(ctx, {now})` em cada área com o módulo ligado, no máximo uma vez por minuto e ao menos a cada 5 minutos; veja abaixo |
| `onInboundContent(module, type, handler)` | Cliente mandou conteúdo estruturado: `"order"` (carrinho do catálogo, `content.order`) ou `"flow_reply"` sem passo web correspondente (`content.flow_reply`). Roda antes do menu e do bot; devolva `true` quando tratou |
| `onHandoffRequest(module, handler)` | Toda passagem automática para humano passa por aqui antes de acontecer: `handler(ctx, c, {source, reason, department_id, summary, menu_item_id})` devolve `"hold"` para segurar ou `"allow"`. Veja "Passagem para humano" abaixo |

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

### Conversa no chat (`onConversationTurn` + `ctx.sendInteractive`)

Para fluxos que seguem no WhatsApp (serviço → profissional → horário;
orçamento com Aprovar/Recusar; botões do lembrete):

```ts
import { onConversationTurn } from "../api";

await ctx.sendInteractive(c, {
  type: "list",
  body: "Orçamento #12: R$ 150,00",
  button: "Responder",
  sections: [{ rows: [
    { id: "os:aprovar:12", title: "Aprovar" },
    { id: "os:recusar:12", title: "Recusar" },
  ] }],
}, { key: `orcamento:12` });

onConversationTurn("os", async (ctx, c, { text, replyId, rowId }) => {
  if (replyId?.startsWith("os:")) return handleQuoteReply(ctx, c, replyId, rowId);
  if (!(await temOrcamentoPendente(ctx, c))) return false;  // texto alheio segue
  return handleQuoteText(ctx, c, text, rowId);              // "1" / "2" no QR
});
```

- Ordem no `processInbox`: consentimento, avaliação, Flow/carrinho, fila de
  senhas, **módulos (na ordem de `runtime.ts`)**, porta de entrada,
  protocolos, menu e bot. As regras de automação, número e sessão do resto
  valem aqui também (área pausada ou mensagem de sessão antiga não chegam).
- Só conversas individuais, só com o módulo ligado. `replyId` só vem quando
  o toque chegou pelo próprio canal da conversa; caso contrário é `null`.
- Devolva `true` só para o que é seu: replyId com o prefixo do módulo
  (`agenda:`, `os:`) ou texto quando há estado aberto **na sua tabela**, com
  validade. Um replyId com o seu prefixo nunca chega ao menu, então não
  aparece "Esta opção não está mais disponível".
- MENU/VOLTAR: limpe o estado e devolva `false`, para o menu responder.
- **Conversa com atendente** (`c.state === "human"`): a mensagem também chega
  ao gancho (coberto por teste). Se o módulo tratar, nada muda na conversa:
  ela continua com o atendente. Decida pelo seu estado: uma pergunta aberta
  pelo módulo pode ser respondida; texto solto numa conversa com atendente
  normalmente é para ele (devolva `false`). Com a área pausada (automação
  desligada) o gancho não roda.
- Botões de resposta: `{type: "button", body, buttons: [{id, title, description?}]}`
  (1 a 3, título até 20). `description` só aparece no texto numerado do QR.
- Use `rowId` nas chaves de envio (`key: "turno:" + rowId`): um reprocessamento
  da mesma mensagem não repete a resposta.
- Os ids de opção: até 200 caracteres; títulos de lista até 24. A validação é
  a mesma em todas as linhas (`src/whatsapp-interactive.ts`).

### Passagem para humano (`onHandoffRequest` + `ctx.handoff`)

Para condicionar o atendimento humano (Suporte pago: só com assinatura em
dia ou depois de pagar), o módulo segura a passagem automática e libera
depois:

```ts
onHandoffRequest("suporte", async (ctx, c, request) => {
  if (request.source === "menu" && request.menu_item_id !== "humano-pago")
    return "allow";
  if (await assinaturaEmDia(ctx, c)) return "allow";
  await oferecerPagamento(ctx, c, request); // ctx.sendInteractive / ctx.charge
  return "hold";
});
onPaymentUpdated("suporte", async (ctx, payment) => {
  if (payment.status !== "paid") return;
  const c = await ctx.conversation(payment.conversation_id!);
  await ctx.handoff(c, {
    summary: "Atendimento avulso pago.",
    flags: ["telefone não vinculado"],
    key: payment.id,
  });
});
```

- **Passam pelo gancho** (`source`): item de menu de atendimento humano
  (`"menu"`, com `menu_item_id`), palavra-chave como "atendente" (`"keyword"`),
  bot de IA ou especialista que transfere (`"bot"`), falha do bot
  (`"bot_error"`), anexo que o bot não lê (`"attachment"`), carrinho ou Flow
  sem dono (`"structured"`) e linha em atendimento por pessoa
  (`service.mode: "human"`, `"line"`). Nesta última, com um módulo de gancho
  ligado na área, a primeira mensagem da sessão não vai direto para a fila:
  passa pelo menu e pelos fluxos dos módulos e, se for para a equipe, pelo
  gancho. Sem módulo de gancho ligado, a linha põe na fila como antes.
- **Não passam**: a transferência feita pela equipe, o atendente que assume a
  conversa e o próprio `ctx.handoff`.
- **`request.row_id`**: a mensagem da caixa de entrada (ou a execução do bot)
  que pediu a passagem. É a mesma quando a mensagem é reprocessada; use nas
  chaves (`gate:${row_id}`) no lugar do relógio, para não abrir outra sessão.
- **Erro no gancho**: por padrão libera a passagem (o cliente nunca fica
  preso). Módulo que vende acesso à equipe declara
  `onHandoffRequest(module, handler, {failClosed: true})`: o erro segura a
  conversa e deixa uma nota interna para a equipe conferir.
- **Segurar** (`"hold"`): o núcleo não muda a conversa nem avisa o cliente;
  publica `conversation.updated` com `handoff_held: {module, source, reason}`.
  O módulo conduz pelo `onConversationTurn` e chama `ctx.handoff` quando
  liberar. Guarde `department_id` se quiser respeitar o setor pedido.
- **Ordem com mais de um módulo**: a de `modules` em
  `src/modules/registry.ts`; só módulos ligados; o primeiro `"hold"` encerra
  a consulta e os seguintes não são chamados. Quem segura assume a conversa
  inteira.
- **Erro no gancho** libera a passagem e vai para o log: o cliente nunca fica
  preso por falha do módulo.

### Ferramentas para bots (`onMcpTool`)

```ts
onMcpTool("agenda", {
  name: "agenda_horarios_livres",          // prefixo obrigatório: id do módulo + "_"
  description: "Horários livres de um serviço… Requer conversations:read.",
  input: { service_id: { type: "string" }, date: { type: "string" } },
  required: ["service_id"],
  call: (a, profile) => ({
    path: `/profiles/${profile}/agenda/availability`,
    query: { service_id: a.service_id, date: a.date },
  }),
});
```

- A ferramenta vira uma chamada interna à API v1 com a chave do bot: mesma
  autenticação, permissões, idempotência e `409 module_disabled` das rotas.
- `profile` entra sozinho nos parâmetros; com `write: true`, também
  `idempotency_key`. Escritas usam `method` e `body`.
- Aparecem em `tools/list` só quando o módulo está ligado em alguma área que
  a chave alcança (desligado, a ferramenta some; chamada pelo nome recebe o
  409 da rota). A descrição deve dizer a permissão necessária.
- **Só o cliente da conversa.** Ferramenta que lê ou mexe em dados de um
  cliente recebe apenas `conversation_id`: o servidor identifica o cliente
  pela conversa (a própria conversa ou o mesmo telefone). Nunca aceite
  telefone, CPF/CNPJ, nome ou número de registro como critério de busca: o
  bot não pode consultar outro cliente citado no texto. Ids de registro
  (agendamento, mensalidade) só valem se forem do cliente da conversa; de
  outro cliente, 404. Escritas passam por ações de conversa
  (`onConversationAction`), com a mesma idempotência e a regra de conversa
  assumida.
- Ferramentas de hoje:
  - Agenda: `agenda_servicos`, `agenda_horarios_livres`, `agenda_agendar`,
    `agenda_meus_agendamentos`, `agenda_remarcar`, `agenda_cancelar`.
  - Reserva: `reserva_disponibilidade`, `reserva_reservar`, `reserva_minhas`.
  - Ordem de Serviço: `os_situacao`.
  - Mensalidade: `mensalidade_situacao`, `mensalidade_segunda_via`.
  - Pedido: `pedido_cardapio`, `pedido_consultar`, `pedido_enviar_carrinho`.
- Chave presa à conversa: com `conversations:bound` (padrão da chave criada em
  Integrações → Hermes), a aplicação só alcança as conversas que um dos bots
  dela está atendendo agora (execução na fila ou em andamento, ou encerrada há
  menos de 2 minutos) e as do próprio namespace. Listas de conversas,
  contatos, protocolos, eventos e relatórios da área respondem
  `403 bound_key`, e `tools/list` mostra só as ferramentas de atendimento. Um
  cliente que injeta instruções no bot não chega à conversa de outro cliente.
  Rotas de módulo liberadas para essa chave: as `…/conversations/:id` da
  ferramenta e os catálogos sem dado pessoal (`agenda`,
  `agenda/availability`, `reserva/availability`, `pedido/menu`); uma rota de
  ferramenta nova entra na lista `BOUND_ROUTES` de `src/index.ts`.

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
  `contacts:*`, `tickets:*`, `billing:write`). Uma permissão nova entra na
  lista de `src/service.ts` e no OpenAPI; combine antes.

### Dados pessoais, notas e cobrança

- **Dados pessoais** (telefone, e-mail, documento, endereço, respostas de
  check-in): nas leituras do módulo, aplicação só vê com `contacts:read`.
  Pessoas da equipe veem. Use `ctx.redact(actor, row, {contacts: [...]})` na
  visão devolvida (listas, detalhe e as leituras das ferramentas de bot).
- **Notas internas** (observações da equipe, histórico com notas): aplicação
  só vê com `notes:read`; `ctx.redact(actor, row, {notes: [...]})`.
- Para nenhuma rota ficar de fora, use `filteredHandlers(filtro)` no lugar de
  `onRead`, `onCommand` e `onConversationAction`: toda resposta passa por
  `filtro(ctx, actor, valor)`. A Agenda e a Reserva fazem assim:
  `const { onRead, onCommand, onConversationAction } = filteredHandlers(visibleBookings);`
- **Operações financeiras** (baixa manual, isenção, criar ou mudar plano,
  valor ou desconto, importar assinaturas): aplicação precisa de
  `billing:write` (`ctx.access(actor, "billing:write")`), além do papel que a
  pessoa precisaria. `billing:write` não pode ser concedida a aparelhos
  pareados do Vinki nem do Fagoo (`409 scope_not_allowed`); uma chave de
  mensagens nunca vira chave financeira.
- **Identidade por telefone**: compare, vincule ou revincule registros por
  telefone só com `ctx.verifiedPhone(c)`. Em conversa de integração ele é
  null, e o módulo não procura nem puxa registros de outro cliente.

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
- O endereço do link é o endereço público da instalação
  (`instance_settings.public_origin`): a primeira origem vista nas
  requisições de pessoas ao painel e aos apps vira o padrão e fica fixa
  (abrir o painel por outro nome não muda os links). O administrador troca em
  `POST /api/v1/system/origin/configure` `{public_origin}` e vê em
  `GET /api/v1/system`. Sem endereço, `409 origin_unknown`.
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

### Página de carrinho (`spec.page: "cart"`)

Segundo tipo de página do passo web, para pedidos (lanchonete, loja): o
módulo entrega o catálogo ao abrir o passo; o cliente monta o carrinho,
revisa e confirma; o módulo recebe o pedido validado.

```ts
const { url } = await ctx.openWebStep(c, {
  kind: "cart",
  ref: menuVersion,                 // o que o módulo quiser ligar ao passo
  trigger: "menu",
  actor: "system",
  sourceKey: `cardapio:${rowId}`,
  ttlMinutes: 120,
  text: "Monte o seu pedido pelo link:",
  button: "Fazer pedido",
  spec: {
    page: "cart",
    title: "Lanchonete da Ana",
    intro: "Peça até as 22h.",
    fields: [],
    return_message: "module",       // o módulo responde com o número do pedido
    cart: {
      categories: [
        {
          id: "lanches",
          name: "Lanches",
          items: [
            {
              id: "xburger",
              name: "X-Burger",
              description: "Pão, carne 150 g e queijo",
              price_cents: 2500,
              image_url: "https://…/x.jpg",          // opcional, HTTPS
              available: true,                        // false: aparece, sem quantidade
              max_quantity: 10,                       // padrão 20
              option_groups: [
                { id: "ponto", name: "Ponto da carne", min: 1, max: 1,
                  options: [{ id: "mal", name: "Mal passada" }, { id: "bem", name: "Bem passada" }] },
                { id: "adicionais", name: "Adicionais", min: 0, max: 2,
                  options: [{ id: "bacon", name: "Bacon", price_cents: 500 },
                            { id: "cheddar", name: "Cheddar", price_cents: 400, available: false }] },
              ],
            },
          ],
        },
      ],
      fulfillment: {
        pickup: true, delivery: true,
        delivery_fee_cents: 700, minimum_cents: 2000,
        eta: "Pronto em 30 min", pickup_address: "Rua X, 100",
      },
      allow_note: true,
    },
  },
});

onWebStepCompleted("pedido", async (ctx, step, order) => {
  if (step.page !== "cart") return;
  // order: CartOrder (src/web-cart.ts), já validado e recalculado:
  // { lines: [{item_id, slot, name, quantity, unit_cents, options:[{group_id, group, id, name, price_cents}], note, total_cents}],
  //   item_count, subtotal_cents, delivery_fee_cents, total_cents, currency: "BRL",
  //   fulfillment: "pickup" | "delivery", customer_name, address: {street, district, complement, reference} | null, note,
  //   payment: {method, label, change_for_cents} | null }
  const c = await ctx.conversation(step.conversation_id);
  const pedido = await criarPedido(ctx, step, order);
  await ctx.charge(c, { method: "pix", amount_cents: order.total_cents, description: `Pedido ${pedido.numero}`, ref: pedido.id, sourceKey: `pedido:${pedido.id}` });
  return `Pedido nº ${pedido.numero} recebido! Total ${valor(order.total_cents)}.`;
});
```

- **Valores só do servidor.** A página não manda preço, subtotal nem total: o
  núcleo recalcula tudo a partir do catálogo guardado no passo ao revisar e de
  novo ao confirmar. Campos extras enviados pela página são ignorados.
- **Regras conferidas:** item disponível, quantidade de 0 a `max_quantity`,
  adicionais existentes e disponíveis, entre `min` e `max` por grupo (grupo
  com `min: 1, max: 1` vira escolha única), pedido mínimo sobre o subtotal,
  nome do cliente, endereço (rua e bairro) na entrega.
- **Fluxo da página, sem script:** carrinho → "Revisar pedido" (mostra linhas,
  subtotal, entrega e total; nada muda) → "Confirmar pedido" (conclui, uso
  único). "Voltar e alterar" volta ao carrinho com as escolhas.
- Mesmas regras do passo web: link de uso único, validade, expiração,
  `web_step.*`, nota interna com o pedido em texto, retorno no WhatsApp
  (padrão "Recebemos seu pedido. Total: R$ …"; com `return_message: "module"`,
  o texto devolvido pelo gancho). Carrinho não vai a protocolo por padrão
  (`ticket: "none"`).
- Limites: até 30 categorias, 100 itens por categoria e 300 no total; 10 grupos
  por item, 30 opções por grupo; ids com letras, números, `-` e `_`;
  preços em centavos inteiros. O catálogo é uma cópia: mudar o cardápio
  depois não altera links já enviados.
- **Foto do item.** `image_url` (HTTPS externo) ou `image_media_id`: uma
  imagem enviada para a área (`POST /media`). A página a serve pelo próprio
  link (`/api/w/<código>/img/<id>`), só as citadas no catálogo daquele link;
  `openWebStep` recusa mídia de outra área ou que não seja imagem.
- **Forma de pagamento e troco na página.** Com `cart.payment: {methods:
  [{id, label, change?}], required?}`, a página pergunta "Como você quer
  pagar?" (antes do nome) e, para as formas com `change: true` (dinheiro),
  "Troco para quanto?". O pedido traz `payment: {method, label,
  change_for_cents}`; o troco precisa ser ao menos o total e só vale para a
  forma com `change`. `required: false` deixa em branco (`payment: null`) e o
  módulo pergunta depois. Sem `cart.payment`, nada muda (`payment: null`).
- **Várias montagens do mesmo item.** Cada item tem o botão "+ Outra montagem
  deste item" (até 10 por item): dois X-Burger, um sem cebola e outro com
  bacon, viram **duas linhas** em `lines`, com o mesmo `item_id` e `slot` 0 e
  1, cada uma com quantidade, adicionais, observação e total próprios. Quem lê
  o pedido não deve supor um `item_id` por linha nem agrupar linhas pelo
  `item_id`. `max_quantity` vale para a soma das montagens. Formato do pedido:
  igual ao anterior, mais o campo `slot` em cada linha (aditivo).
- Campos da página (só interessam a quem testa com POST direto): a primeira
  montagem usa `q_<item>`, `o_<item>_<grupo>` e `n_<item>`; a montagem `k`
  usa `q_<item>.<k>`, `o_<item>.<k>_<grupo>` e `n_<item>.<k>`; `slots_<item>`
  diz quantas montagens o formulário traz. Erros vêm em `item:<item>` ou
  `item:<item>.<k>`.

## 4b. Cobrar (Pix e link de pagamento)

A Cobrança é do núcleo (módulo `payments`, `src/payments.ts`, contrato em
[COBRANCA.md](COBRANCA.md)). Uma vertical cobra assim:

```ts
import { onPaymentUpdated } from "../api";

// Ao fechar o pedido:
const payment = await ctx.charge(c, {
  method: "pix",                    // ou "link" (Checkout Pro: cartão, Pix…)
  amount_cents: order.total_cents,  // inteiro, em centavos
  description: `Pedido ${order.number}`,  // até 120 caracteres
  ref: order.id,                    // vira ref_id na cobrança e no gancho
  sourceKey: `order:${order.id}`,   // repetir não cobra de novo
  expiresMinutes: 60,               // 30 min a 30 dias; padrão 24 h
});
// Guarde payment.id no registro do módulo, se quiser mostrar o estado.

onPaymentUpdated("pedido", async (ctx, payment, { previous }) => {
  if (payment.status === "paid") await marcarPago(ctx, payment.ref_id!);
  if (payment.status === "refunded") await marcarEstornado(ctx, payment.ref_id!);
  // expired e cancelled: liberar estoque, horário, quarto…
});
```

- Pré-requisitos: módulo **Cobrança** ligado e conta configurada em
  **Gestão → Cobrança**. Sem conta: `409 payments_not_configured`; módulo
  desligado: `409 module_disabled`. Trate esses erros mostrando ao cliente
  outra forma de pagar.
- O núcleo entrega ao cliente (botão com URL na linha oficial, link no texto
  no QR, e o código Pix numa mensagem separada), registra nota na conversa,
  publica `payment.*` e envia "Pagamento recebido" quando paga. O módulo não
  envia essas mensagens.
- **Janela de 24 horas:** na linha oficial com a janela fechada, `charge`
  recusa (`409 window_closed`), a menos que você passe `notification: true`
  (lembrete de mensalidade, por exemplo): aí a cobrança sai em texto pelo
  modelo de notificação configurado.
- `paid` só chega pelo webhook do provedor, depois de consultar o pagamento.
  Nunca marque um registro como pago por mensagem do cliente. O gancho roda no
  `Coordinator` da área, uma vez por mudança, mesmo com webhooks repetidos.
- Um pagamento aprovado depois de `expired` ou `cancelled` vira `paid` (o
  dinheiro entrou): o gancho recebe `previous: "expired"`; decida no módulo
  se ainda dá para atender ou se é preciso estornar pelo painel do provedor.
- Sinal ou parcial: crie uma cobrança por parcela, cada uma com a sua
  `sourceKey`.
- Nos testes, simule o Mercado Pago com `vi.stubGlobal("fetch", …)` e o
  webhook assinado como em `tests/payments.test.ts` (`mpManifest` + `hmac`).

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
- **Trilho principal:** uma linha em `railPages`
  (`web/workspace-navigation.ts`) põe a página do módulo no trilho do
  computador e em Mais no celular, além de Gestão (`{ page, label, icon }`).
  Some com o módulo desligado ou sem permissão, como a própria página.
- **Painel da conversa:** uma linha em `conversationExtensions`
  (`web/modules/conversation.tsx`) mostra o seu componente em Dados da
  conversa, com o módulo ligado e fora de grupos. Recebe
  `{ conversation, name }`. Exemplos: `ConversationAgenda` e
  `ConversationServiceOrders`.
- **Editor de menus:** os tipos de item vêm de `menu_item_types` em
  `GET /modules` (só módulos ligados), com o rótulo declarado. Um item de
  módulo desligado mantém o seu tipo ao ser editado. Campos extras do item
  (`service_id`, …) não têm editor genérico: ofereça-os na tela do módulo.

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
