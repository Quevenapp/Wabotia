# Entrega W — painel do motor de trabalhos

## Arquivos

- `work-contracts.ts`: reexporta os DTOs de F0; declara somente a proposta isolada de consulta agregada `Deadline`/`DeadlineQuery`.
- `work-api.ts`: cliente tipado, idempotência, erros de implantação/conflito, escritas de filhos, orçamento, aprovação, modelos e transporte binário privado.
- `work-hooks.tsx`: recursos vinculados à área/endereço, descarte de respostas antigas, recarga, proteção de rascunho e horários de Brasília.
- `work-vocabulary.ts`, `work-navigation.ts`: nomes vindos do catálogo autorizado e resolvedor para Gestão/trilho/Mais.
- `components/ExtraFields.tsx`, `StagePill.tsx`, `AssigneeField.tsx`, `ChildCollection.tsx`: campos dinâmicos, validação ao salvar, proteção contra campos privados no DOM comum, etapas, responsáveis e paginação.
- `work/WorkListPage.tsx`: entrada compatível com a tela antiga; lista por tipo, busca, etapas, contagens, paginação e criação.
- `work/WorkFormDialog.tsx`: abertura/edição com campos do DTO, versão, rascunho preservado e recarga após conflito.
- `work/WorkDetailPage.tsx`, `work/QuoteEditor.tsx`, `work/PrivateFieldsDialog.tsx`: detalhe endereçável, seis abas montadas sob demanda, ações por ID de transição, aprovações separadas e orçamento.
- `tasks/WorkTasksTab.tsx`, `TaskDialog.tsx`, `MyDeadlinesPage.tsx`: lista, criação, edição, conclusão/reabertura/cancelamento e consulta agregada de prazos.
- `people/WorkPeopleTab.tsx`: vínculos, edição e arquivamento; vínculo não concede acesso.
- `documents/WorkDocumentsTab.tsx`: reserva, upload retomável com a mesma chave, confirmação, download privado, arquivamento e envio com destinatário confirmado.
- `entries/WorkEntriesTab.tsx`: lançamentos, quantidade exata em milésimos, retificação e consulta de arquivados.
- `history/WorkHistoryTab.tsx`: eventos autorizados e cursor próprio.
- `types/WorkTypesPage.tsx`, `FieldsEditor.tsx`, `StagesEditor.tsx`, `ResourcesEditor.tsx`, `type-draft.ts`: editor, duplicação, aposentadoria de IDs, revisões, recursos, mensagens com exemplo fictício, importação/exportação JSON e inclusão de menus por tipo.
- `ConversationWorkOrders.tsx`, `web/modules/conversation.tsx`: uma extensão OS; formulário comum e links diretos para tipos novos, componente antigo para área apenas com OS.
- `ServiceOrdersSettingsPage.tsx`, `web/menu-tree.ts`: distinguem `(type, type_id)` ao verificar/incluir destinos. Menus sem referência continuam equivalentes a `service_order`.
- `web/admin/area-templates/AreaTemplatesPage.tsx`, `template-import.ts`: catálogo, seleção, inspeção, prévia calculada pelo servidor, aplicação por hash, resultado e importação/exportação do manifesto.
- `web/lib/routes.ts`: slugs, tipo/registro/aba/filtros, comparação e guarda de navegação.
- `web/workspace-navigation.ts`, `web/admin/AdminArea.tsx`: páginas, acesso administrativo, montagem e vocabulário da Gestão. Modelos não dependem de OS ligado.
- `work.css`: estilos locais responsivos com os tokens existentes.
- `tests/os-web-work.test.ts`: testes novos de renderização de campos/etapas, privacidade no HTML, compatibilidade, menus, rotas, acesso, DTOs, cursores, idempotência, conflitos, importações e quantidades. Nenhum teste existente foi alterado.

## Linhas para o integrador (não aplicadas)

Em `src/modules/os/definition.ts`, acrescentar a `navigation`:

```ts
{ id: "work", label: "Trabalhos", place: "admin", admin: false },
{ id: "my-deadlines", label: "Meus prazos", place: "admin", admin: false },
{ id: "work-types", label: "Tipos de trabalho", place: "admin", admin: true },
```

Não registrar `area-templates` no módulo OS. A página administrativa já está registrada no web. Os registros de extensões/rotas de M/T/P/D/L/A pertencem aos respectivos relatos e a F0/I.

Após T/I confirmarem e implementarem a consulta agregada abaixo, incluir `"work-tasks"` em `osModule.routes`, preservando `"service-orders"`:

```ts
routes: ["service-orders", "work-tasks"],
```

`web/app/Shell.tsx` e `web/app/MoreArea.tsx` não pertencem à W. Para resolver os nomes também no trilho e em Mais:

1. Em ambos, acrescentar:

```ts
import { useWorkNavigation } from "../modules/os/work-navigation";
```

2. Dentro de `useItems()` em Shell e de `MoreArea()` em Mais, após `const app = useApp();`, acrescentar:

```ts
const workNavigation = useWorkNavigation();
```

3. No `map` de `railPages` em Shell, substituir `label: item.label,` por:

```ts
label: item.page === "service-orders" ? workNavigation.railLabel : item.label,
```

4. No mesmo conjunto de links em Mais, substituir `<span>{item.label}</span>` por:

```tsx
<span>{item.page === "service-orders" ? workNavigation.railLabel : item.label}</span>
```

O destino `service-orders` já seleciona a experiência nova quando existem tipos personalizados. Não criar um item de trilho por tipo.

## Diferenças, lacunas do contrato e pendências

1. **Meus prazos:** a seção 5/F0 não define rota nem DTO agregado. A tela usa a proposta de `painel.md`, isolada em `work-api.ts`/`work-contracts.ts`: `GET P/work-tasks?assignee=me&state=open&period=overdue&type_id=...&cursor=...`. `period`: `overdue`, `today`, `next7`, `range`, `undated`; intervalo usa `due_from`/`due_to` como datas civis em Brasília. Resposta: `Page<Deadline>` (Task + `type_id`, `type_label`, `display_number`, `stage_label`, `customer?: {name}`). T/I precisam congelar essa assinatura, validar o usuário autenticado e ordenar globalmente por vencimento crescente/ID, nulos depois. Não há varredura de ordens nem consultas por linha. Até a rota existir, mostra “Em implantação”.
2. **Snapshot/capacidades:** `Order` não expõe `features`, política de orçamento ou capacidades. Os campos/rótulos/ações da ordem sempre vêm do próprio DTO. A definição atual só controla recursos quando sua revisão é igual à da ordem. Havendo revisão diferente, mantém as abas consultáveis para o servidor autorizar, e não oferece edição de orçamento com política inferida. Escritas continuam sujeitas à autorização do servidor; não inventamos capacidades no contrato.
3. **Filtros adicionais/resumos:** `OrderQuery` não contém responsável, intervalo de prazo nem resumo da próxima tarefa. Foram implementados os filtros contratados (tipo, etapa, abertas, busca) e exibidos responsável/prazo/orçamento recebidos. Os demais filtros e resumo dependem da ampliação de DTO/rota por M/I; não há filtragem parcial no navegador.
4. **Privados:** campos extras sensíveis nunca entram na tela comum, mesmo que uma definição administrativa os contenha. Um formulário separado lê `/private-fields` antes de montar os controles e grava exclusivamente na rota privada, usando a versão autorizada. Os formulários de filhos permitem marcar dados restritos, recusam a combinação restrito/visível ao cliente e exigem autorização no servidor. A classificação sensível de filhos já carregados não pode ser reduzida pela tela; o servidor continua responsável pela projeção autorizada. O editor permite declarar campos sensíveis e valida sua incompatibilidade com obrigatório/cliente.
5. **Documentos:** o desenho propunha categoria e edição de metadados, mas esses campos/comando não existem no contrato congelado. Implementadas somente as operações da seção 5. O upload usa o caminho autenticado derivado dos IDs, sem seguir uma URL externa recebida na reserva.
6. **Histórico:** o contrato não aceita filtros adicionais nem rótulos históricos das etapas. A tela pagina o histórico completo autorizado e exibe os IDs históricos, sem reinterpretar eventos com o tipo atual.
7. **Prévia:** `AreaTemplatePreview` traz caminho/ação/motivo/conflitos, sem valores atuais/propostos. A tela mostra esses dados e o manifesto; não inventa uma comparação de valores ausentes.
8. **Divisão de componentes:** arquivos menores de diálogo/resumo/mensagens foram agrupados em suas telas quando só têm um consumidor. A propriedade da seção 8 foi preservada. Nenhum arquivo central de F0/M ou migração foi editado.
9. **Integração visual:** rótulo de trilho/Mais depende das quatro alterações acima. A demonstração (`web/lib/demo.ts`) ficou intacta por estar fora da propriedade de W. Rotas não implementadas degradam explicitamente; os fluxos reais dependem da junção das demais tarefas.
10. **Validação:** o editor faz validações locais de estrutura, IDs, grafo, sigilo, marcadores e limites principais. A validação normativa completa permanece no servidor e erros preservam o rascunho. No conflito da ordem/configuração há recarga mantendo rascunho; nos formulários filhos o rascunho permanece aberto, e fechar exige confirmar descarte antes de atualizar a coleção.
11. **Horários:** entradas novas usam data/hora em Brasília (UTC−03), explicitamente na tela. O formulário legado e sua conversão de prazo permanecem intactos. Não há cálculo de prazo forense.

## Verificação

- `npx tsc --noEmit`: passou após corrigir tipagem de menu, upload e recursos opcionais. Verificação final concluída sem erros.
- `node node_modules/typescript/bin/tsc --noEmit`: usado também durante o diagnóstico inicial; apontou os mesmos erros locais, corrigidos.
- `npm run build`: passou; avisos de chunks acima de 500 kB, nome do grupo de chunks e diretivas `use client` do React Router. Build final concluído sem erros.
- Prettier local nos arquivos novos e trechos de integração; `git diff --check` sem erros.
- Vitest/Wrangler não executados, conforme regra da máquina. Comando para o script externo: `npx vitest run tests/os-web-work.test.ts`.
- Nenhum commit, push, troca de branch, migração ou recurso Cloudflare. Sem consultas à rede. Não houve validação visual em navegador nem integração com servidores das outras tarefas.
