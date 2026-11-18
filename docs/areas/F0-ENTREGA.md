# Entrega F0 — contrato congelado

Leia junto com [CONTRATO-MOTOR.md](CONTRATO-MOTOR.md). F0 não implementa M/T/P/D/L/A. Os arquivos `model.ts`, `store.ts`, `os.ts` e `reminders.ts` estão intactos; nenhuma linha excepcional de registro, migração ou recurso Cloudflare foi acrescentado.

A entrega reúne os contratos/DTOs, acesso e projeções mínimos do embutido, descritores de extensões com agregação de agenda/turnos, despacho HTTP dos filhos, revisão e planejamento atômico de configuração, referências de menu, transporte binário e adaptadores de anexos. A fixture comum e os testes de fundação estão em `tests/os-motor-fixture.ts` e `tests/os-foundation.test.ts`; a regressão do registro HTTP está em `tests/os-route-registration.test.ts`.

## Assinaturas para as filhas

| Caminho | Exportações e uso |
|---|---|
| `src/modules/os/contracts.ts` | Tipos normativos das seções 3/7, `BUILTIN_WORK_TYPE`, `Order`, `WorkTypeView`, `MutationRef`, `Page<T>`, `Task`, `LinkedPerson`, `DocumentMetadata`, `Entry` e DTOs `Create*Request`/`Update*Request`. Sem execução de regras. |
| `src/modules/os/public.ts` | `authorizedOrder(ctx, actor, id, {write?, conversation_id?}) → Promise<AuthorizedOrder>`; retorna `{row, type}`. Confere área, escopo, módulo e, quando informado, titular pela conversa autenticada. Credencial limitada exige conversa. Nunca autoriza pelo cadastro de pessoas. |
| Mesmo arquivo | `resolveWorkType(ctx, typeId?, snapshot?) → Promise<WorkTypeView>`; ausência seleciona `service_order`. `WorkOrderRow` é interno: nunca serializar. |
| Mesmo arquivo | `commitChild(ctx, actor, order, mutation: ChildMutation) → Promise<MutationRef>`. M implementará a transação; F0 responde `501 not_implemented`, mencionando M, antes de qualquer escrita. |
| `src/modules/os/privacy.ts` | `projectOrderForStaff(ctx, actor, order)`, `projectOrderForCustomer(...)`, `projectOrderForBot(...) → Order`; `projectPrivateFields(...) → Promise<PrivateFields>`; `mayReadSensitive(ctx, actor) → Promise<boolean>`. |
| Mesmo arquivo | `projectChildForStaff(ctx, actor, dto) → Promise<T|null>`, `projectChildForCustomer(dto)` e `projectChildForBot(dto) → T|null`. Entregar DTO já montado, **nunca uma linha SQL**. `null` significa omitir o registro, inclusive de contagens. Autorizar o pai antes da projeção. |
| `src/modules/os/extensions.ts` | `OsExtension`, `DueRequest`, `DueResult`, `DueBudget`, `osExtensions` (vazia). Exportar um descritor do diretório da filha; só I acrescenta import/entrada no bloco reservado. |
| `src/modules/api.ts` | `ModuleContext`, `onSettingsSave(moduleId, key, validate)` e novo `onSettingsChange(moduleId, validate)`. O segundo recebe `(previous, next, {changed_keys, modules})`: configurações completas, inclusive menus ocultos, e estado final dos módulos. É puro, retorna `void`, recusa lançando erro. |
| `src/service.ts` | `settingsRevision(env, profile)`, `planSettings(env, actor, profile, changes, {modules?, expected_revision?}) → Promise<SettingsPlan>`, `commitSettingsPlan(env, actor, plan, provenance?)`. `provenance` é uma lista interna `[sql, bindings][]`, incluída no mesmo lote D1. |
| `src/modules/api.ts` | `AdminExtension`, `registerAdminExtension(descriptor)`: A exporta `id: "area-templates"`, `reads`, `writes`, `commands`. Caminhos começam por `area-templates`; operações por `area-template.`. I registra no fim de `runtime.ts`. Exige administrador e funciona com OS desligado. |
| `src/modules/api.ts` | `onBinaryRead(moduleId, path, handler)` e `onBinaryUpload(moduleId, path, {operations, authorize, upload})`; tipos `BinaryReadHandler`, `BinaryUploadHandler`, `BinaryUploadRequest`. D os declara em `OsExtension.binaryReads/binaryUploads`; não chama registradores diretamente. |
| `tests/os-motor-fixture.ts` | `motorFixture({enabled?})`, `motorOrder(f, overrides?)`, `motorWorkType()`, `MOTOR_WORK_TYPE`, `MOTOR_SENTINEL`. Fixture congelada; extensões de cenário ficam no teste da filha. |

## T: implementação sem consultar os arquivos legados

Crie `src/modules/os/tasks/extension.ts`, exportando `tasksExtension: OsExtension` com `id: "tasks"`. Use caminhos completos relativos à área, por exemplo `service-orders/:id/tasks/:task_id`; `id` é o pai. As rotas de conversa usam `:id` para a conversa e `:order_id` para o pai. O núcleo repassa **todos** os parâmetros, que vencem o corpo, e remove `profile` do corpo. Rotas estáticas precedem parâmetros.

O despacho de escritas, leituras JSON e binárias acompanha o registro mesmo depois de carregar a entrada HTTP ou atender uma requisição. `src/modules/hooks.ts:matchModuleRoute` mantém um índice Hono atualizado por revisão do registro; a prioridade estática também vale entre JSON e binário. Isso permite registros locais nos testes sem depender da ordem de importação. Em produção, as filhas continuam exportando descritores para registro exclusivo por I.

Os descritores usam estas formas:

```ts
reads: [{ path, handler: async (ctx, actor, {params, query}) => /* Page<Task> */ }]
writes: [{ method: "POST", path, op: "os.task.create" }]
commands: [{ op: "os.task.create", handler: async (ctx, actor, data, {requestId}) => /* MutationRef */ }]
runDue: async (ctx, {now, budget, limit}) => ({processed, has_more})
```

Em cada manipulador: autorize o pai com `authorizedOrder`, confira `order.type.features.tasks`, valide a entrada e filtre a saída. Consultas usam `all/one` de `src/db.ts` com `ctx.env`, incluindo `ctx.profile` e o ID do pai. `ctx.access(actor, "conversations:read"|"conversations:write")` confere o escopo. `ctx.conversation(id, actor)` confere o acesso à conversa; passe seu ID em `authorizedOrder` nas rotas de cliente. Não derive titular de telefone recebido no corpo.

Para escrever, prepare `ChildMutation` com `entity_kind: "task"`, `id`, `expected_version: null` na criação ou versão lida na edição, `mutation_key` derivada de `requestId`, `changed_fields` (só nomes), `statements: [sql, bindings][]` e `event` (código). A primeira instrução é a mutação principal do filho, condicionada por área/pai/versão; as seguintes pertencem ao mesmo efeito. M deve verificar versão, abortar o lote se a mutação não acontecer, acrescentar histórico sem valores, atualizar atividade do pai sem incrementar sua versão lógica e recuperar a publicação idempotente. O filho não grava esses efeitos separadamente. M/T devem conservar essa assinatura.

`runDue` recebe orçamento compartilhado de **200 instruções** e **10 itens**, reduzido pelo trabalho das extensões anteriores. Chame `budget.consume(n)` **antes** do SQL, contando cada instrução de lote e o custo dos serviços chamados. Pare quando não houver orçamento para um item completo; retorne `has_more: true`. O agregador acorda a próxima rodada. Não registre `onSchedule("os")`: o gancho legado roda primeiro, uma única vez. Não marque aviso antes da inclusão durável na fila.

Serviços disponíveis em `ctx`: `grantees("technician")`, `conversation`, `verifiedPhone`, `mayMessage`, `mayNotify`, `note(c, text, {key})`, `sendMessage(c, {text, attachments?}, {key, notification?})`, `publish(event, entityId, idsAndVersion, {key})`. Envie a I os eventos e operações privadas para os blocos reservados de `definition.ts`; eventos ainda não declarados são recusados. O embutido mantém recursos filhos desligados na F0; testar a funcionalidade personalizada exige M ou mocks locais explícitos, sem alterar a fixture comum.

## D e A: detalhes da integração

D: o download autoriza documento/classificação antes de abrir R2 e retorna `{body, headers?}`. O núcleo transporta bytes e força `Cache-Control: no-store`. Upload valida `Idempotency-Key` e `Upload-Version`, executa `authorize`, e só então entrega `upload` com `key`, `version`, `content()` e `command(op, data)`. `content()` limita bytes reais a 10 MiB e calcula SHA-256; retorna `{bytes, byte_length, sha256}`. Use `command` para reservar tentativa e registrar o transporte, com operações listadas em `operations` e implementadas em `commands`. O bridge usa o Coordinator existente e a mesma chave, isolada por operação/ator/área. `ctx.run` é proibido nesse contexto Worker. D implementa concessão, R2 privado, replay, confirmação de negócio e limpeza; não há bytes em recibos/auditoria.

D também dispõe de `ctx.inboundAttachments(c, messageId) → [{id,name,mime_type,byte_length,open()}]`, resolvendo apenas anexos da mensagem recebida naquela conversa/área. Declare `OsExtension.onConversationTurn(ctx,c,{text,replyId,rowId}) → Promise<boolean>` para receber essa mensagem: só roda se o gancho legado não a tratou. `OsExtension.tools` recebe descritores MCP no formato de `onMcpTool`, com nomes `os_*`. `ctx.outgoingAttachment(actor,c,{name,mime_type,byte_length,body,key,client_visible,sensitive}) → mediaId` cria cópia compartilhável na mídia comum, dentro do Coordinator, após verificar permissão de mensagem. Derive `key` do documento/versão e use o ID em `sendMessage`. Nunca encaminhe um documento sensível a esse adaptador.

A: planeje com o estado **final** em `options.modules`. O plano não escreve e inclui `base_revision`, `modules_revision`, `settings_revision`, `settings`, `view`, `modules` e `module_changes`. Inclua revisões e procedência no hash da prévia. No comando de aplicação, releia, recalcule o hash e confirme o plano com o SQL da procedência; não execute `module.set` separadamente. A confirmação relê sem cache, recusa plano antigo e publica eventos depois do lote. O retorno é a configuração visível acrescida de `settings_revision`; A monta seu `AreaTemplateApplyResult`. Reaplicação sem efeito deve ser reconhecida por A antes de confirmar.

## Especificações completadas e limites desta entrega

- Os blocos TypeScript normativos foram preservados. A seção 5 descrevia DTOs em tabelas: F0 fixou os nomes em `contracts.ts`. `WorkTypeView` é custom ou builtin com os mesmos campos resolvidos; `OrderList.facets = {types, stages?}`. Campos removíveis por privacidade são opcionais. `PageQuery` representa consulta já convertida; `OrderQuery` representa strings HTTP.
- Revisão de configuração é SHA-256 do JSON canônico **salvo**, incluindo menus ocultos, sem coluna/migração. É exposta no topo de `/status` e da resposta de `PUT /settings`; não é persistida. `settings_revision` é opcional para clientes legados e obrigatória ao alterar `os_work_types`/`os_vocabulary`. `menus_revision` mantém o contrato anterior. M implementa validação dos tipos e deve registrar os dois ganchos antes da integração.
- M completa `public.ts`/`privacy.ts` sem mudar assinaturas; tipos personalizados, snapshots, campos privados personalizados e `commitChild` retornam `501 not_implemented` com o nome de M. A resolução embutida reutiliza `model.ts`; as rotas antigas continuam usando suas projeções originais.
- O grant `os:sensitive` ficou **reservado para M/I**, para conservar o catálogo legado exigido por `tests/module-grants.test.ts`. A barreira já exige a concessão explícita no ator, pessoa humana e ausência de `via`; administrador não a substitui. I deve integrar a exposição do papel junto da funcionalidade, considerando a compatibilidade desse catálogo.
- O manifesto normativo usa menu `type: "message"`, mas o núcleo existente usa `"content"`: A deve converter ao compilar o manifesto. F0 não muda nenhum dos dois contratos.
- O registro central está reservado no fim de `extensions.ts`, `runtime.ts`, `registry.ts` e `definition.ts`. Nenhuma rota de modelo nem extensão filha fictícia foi publicada. O Coordinator continua com a fila/recibos atuais; a recuperação específica das mutações é responsabilidade de M/D/A.

## Verificação e correção do retorno externo

O log externo recebido em `.codex-verificacao.log` registrou **66/67 testes aprovados**, com nove arquivos aprovados e uma falha em `tests/os-foundation.test.ts:327`: a rota filha retornava 404. A entrada HTTP montava uma cópia das rotas ao carregar; registros posteriores ficavam fora dela. A correção substitui essa cópia por despacho sobre o índice atual, preservando autorização, parâmetros e resposta binária. O teste que falhou ficou intacto. Foram acrescentados dois testes de regressão para registro após requisição, prioridade estática, isolamento e módulo desligado.

Verificações locais desta entrega:

- `node node_modules/typescript/bin/tsc --noEmit` (compilador instalado, equivalente local sem download): aprovado.
- Reprodução com a entrada HTTP real, autenticação e SQLite em memória: **404 antes / 200 depois**. Conferidos IDs e perfil no comando, registros sucessivos, prioridade JSON/binário, bytes, `no-store`, upload, HEAD, continuidade das rotas do núcleo, autenticação, área e módulo desligado. D1 e Coordinator foram adaptados em memória; isso não substitui o runtime Cloudflare.
- Comparação de **158 rotas de produção** com a montagem Hono anterior: mesmo método, seleção de manipulador e parâmetros. Os **31 tipos/interfaces normativos** conferem por AST com o contrato.
- Sintaxe dos três arquivos de teste/fixture F0, marcadores de conflito e `git diff --check`: aprovados. Os **741 arquivos preexistentes em `tests/`**, incluindo a fixture e o teste que falhou, permanecem idênticos por SHA-256.
- `check-encoding.mjs` continua impedido de chamar `git` por `EPERM`. As mesmas regras, usando a lista fornecida pelo shell e incluindo arquivos novos, aprovaram **3.746 arquivos de texto**; sem alterar a guarda.

Sem commit, rede, Vitest ou Wrangler nesta execução. A aprovação completa da suíte após a correção ainda depende da verificação externa. Executar os dois arquivos F0 com `npx vitest run tests/os-foundation.test.ts tests/os-route-registration.test.ts` e repetir os nove arquivos legados do log: `os-orders`, `os-whatsapp`, `bot-tools-verticais`, `module-sensitive-data`, `modules-api`, `b9-conferencia`, `modules`, `module-query-limits` e `menu-module-types` (todos em `tests/`, com sufixo `.test.ts`).
