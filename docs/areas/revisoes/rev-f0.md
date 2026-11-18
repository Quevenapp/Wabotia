1. **`src/modules/os/extension-runtime.ts:51` — gravidade: média.** Uma exceção em uma extensão interrompe as demais extensões de OS.

   **Cenário:** numa rodada com tarefas e documentos, a consulta inicial de tarefas falha → `await extension.runDue(...)` propaga a exceção, a limpeza de documentos não é chamada e o fluxo não chega ao `ctx.wake()`. O tratamento em `src/modules/schedule.ts:52` isola apenas módulos, não extensões. Há o mesmo problema entre o lembrete legado e o agregador em `src/modules/hooks.ts:146`.

   **Correção sugerida:** tratar falhas individualmente no agregador e entre o gancho legado e as extensões. Preservar o orçamento já consumido, continuar as extensões seguintes com o saldo disponível e garantir o reagendamento das pendências.

2. **`src/modules/os/extension-runtime.ts:61` — gravidade: média.** O reagendamento por `has_more` acorda o Coordinator antes do intervalo permitido e pode terminar sem executar outra rodada dos filhos.

   **Cenário:** existem 11 documentos pendentes expirados, sem outras pendências do núcleo. A limpeza processa dez e retorna `has_more: true` → `ctx.wake()` agenda um alarme para aproximadamente um segundo depois (`src/coordinator.ts:618`), mas esse alarme pula os módulos porque ainda não passou um minuto (`src/coordinator.ts:672`). A consulta final de pendências não inclui `os_documents` nem `os_tasks` (`src/coordinator.ts:722`), portanto não mantém a continuação. O documento restante aguarda outro estímulo ou o cron de cinco minutos.

   **Correção sugerida:** persistir a pendência de continuação e agendar uma rodada para quando `modules_tick + SCHEDULE_INTERVAL_MS` permitir sua execução. Um alarme antecipado deve conservar essa pendência e programar o próximo disparo.

## Partes sem achados

- **Planejador de configurações — nada encontrado.** Comparei integralmente o antigo ramo `settings` em `_antes/src/service.ts` com `planSettings` e `commitSettingsPlan`. Descontada a indentação, o bloco legado de validações e preservação de menus só difere na referência ampliada de menu. Permanecem as validações de JEV, avaliações, ausência, notificações, setores, categorias, prazos, horários, confirmação, saudação, fila, estabelecimento, configurações dos módulos, listas, identificadores, aplicativos, destinos, linhas, hierarquia e bots. As mesclagens parciais e a remoção das configurações do Telegram foram preservadas. `menus_revision` continua conferida; a confirmação relê configurações e módulos sem cache e grava configuração, módulos e procedência no mesmo lote.
- **Despacho HTTP — nada encontrado nas rotas existentes examinadas.** Li as alterações de `src/index.ts`, os bloqueios anteriores ao despacho, `mutate`, os registradores de `src/modules/api.ts` e o despachante de `hooks.ts`. Os parâmetros do caminho prevalecem sobre o corpo; `profile` é removido dos dados; autorização de área e bloqueio do módulo precedem os manipuladores.
- **Transporte binário — nada encontrado na camada F0.** Li `binary.ts`, os adaptadores binários e de anexos de `api.ts`, além dos consumidores de documentos. Há limite sobre bytes reais, hash calculado no servidor, autorização antes do callback de upload/download, preservação do tipo de conteúdo e resposta sem cache. A chave R2 é construída no servidor; o adaptador de saída recusa documentos sensíveis ou não compartilháveis.
- **Contratos, registro e referência embutida — nada encontrado.** Li `types.ts`, `registry.ts`, `runtime.ts`, `os/definition.ts`, `contracts.ts` e `extensions.ts`. Menu sem `type_id` e referência explícita a `service_order` aceitam o embutido virtual. A alteração de `coordinator.ts` em relação a `_antes/` é apenas comentário; não acrescenta classe de Durable Object.

A revisão foi estática, sem escrita, rede ou execução de testes. O orçamento D1 da invocação completa do alarme não foi medido.

## Afastamentos do contrato

- O achado 2 impede que o reagendamento solicitado por `has_more` produza a continuação prometida em `F0-ENTREGA.md` e na seção 10 de `CONTRATO-MOTOR.md`.
- O achado 1 descumpre o requisito desta revisão de isolamento de falhas entre extensões.

Arquivos lidos inteiros: `src/modules/binary.ts`, `src/modules/hooks.ts`, `src/modules/registry.ts`, `src/modules/runtime.ts`, `src/modules/types.ts`, `src/modules/schedule.ts`, `src/modules/os/definition.ts`, `src/modules/os/contracts.ts`, `src/modules/os/extensions.ts`, `src/modules/os/extension-runtime.ts`, `src/modules/os/tasks/extension.ts`, `src/modules/os/tasks/reminders.ts`, `src/modules/os/documents/access.ts`, `src/modules/os/documents/model.ts`, `src/modules/os/documents/transport.ts`, `src/modules/os/documents/cleanup.ts`, `src/modules/os/documents/extension.ts`, `src/modules/agenda/config.ts`, `tests/os-foundation.test.ts`, `tests/os-route-registration.test.ts`, `docs/areas/F0-ENTREGA.md`, `docs/areas/relatos/motor-a.md`, `docs/areas/relatos/motor-d.md`.