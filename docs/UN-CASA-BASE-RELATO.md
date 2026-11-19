# Casa única de gestão — relato completo da Base

Atualizado em 18/11/2026. Referência: tarefa /home/bruno/wabotia/tarefas/un-casa-base.md; base Git d017b957.

## Entrega e estado da verificação

A Base contém o contrato compartilhado, 21 contribuições nativas de 13 módulos, 43 destinos portados sob a chave erp, a projeção de compatibilidade do menu antigo, recursos por papel e exposição de management em moduleView. As 14 declarações de módulos referenciam suas contribuições. Os campos navigation existentes continuam iguais.

A entrega ainda não está integralmente validada: o build ultrapassa o orçamento do pacote inicial e Vitest não foi executado, conforme a restrição desta sessão. Há uma correção candidata em memória, dependente de autorização para editar um arquivo expressamente excluído do escopo.

## Causa da falha e investigação desta rodada

O log fornecido (.codex-verificacao.log) contém somente as últimas 200 linhas: 2.204 testes, 2.203 aprovados, uma falha; não contém o teste que falhou.

A reprodução local identificou web/erp/build.test.mjs, teste “o pacote inicial do painel cabe no orçamento”: 1.326,6 KiB de caracteres, contra teto de 1.208 KiB. A execução direta do arquivo aprovou os outros cinco testes. A suíte completa npm run test:erp:painel terminou com 371 arquivos aprovados e um reprovado; neste ambiente o runner registra os arquivos, sem propagar os subtestes ao log do processo pai.

A comparação de builds em memória, substituindo os dois adaptadores pelos conteúdos originais de HEAD, reproduziu o mesmo excesso: o chunk principal original tinha 1.357.536 caracteres, e o atual 1.357.571. A extração acrescenta apenas 35 caracteres ao chunk inicial, associados à lista de dependências da importação dinâmica. O catálogo permanece fora da carga inicial. Portanto, a falha de orçamento já existe sem a extração dos menus; não foi causada pelo conteúdo do catálogo.

A carga inicial inclui estaticamente as páginas de Gestão, além das páginas públicas. Uma candidata que carrega apenas AdminArea sob demanda, usando React.lazy e Suspense com Spinner já existente, reduziu o conjunto inicial para 785.555 caracteres (767,1 KiB) e 242.033 bytes gzip (236,4 KiB), abaixo dos limites inalterados de 1.208 e 352 KiB. A candidata foi avaliada por um plugin temporário de build em memória e aprovou as seis verificações existentes de web/erp/build.test.mjs, sem alterar suas asserções. Não foi aplicada. A alteração necessária fica em web/app/App.tsx, proibido pela tarefa-base; autorização solicitada ao usuário.

A candidata troca o import estático de AdminArea por uma constante lazy no escopo do módulo e envolve somente seu ponto de montagem em Suspense com o Spinner existente. As demais áreas continuam com o carregamento atual. O arquivo completo para revisão está em /tmp/un-casa-base-app-candidate.tsx; o resultado das seis verificações está em /tmp/un-casa-base-candidate-build.log. Falhas de carregamento do novo chunk e a integração com as guardas de navegação ainda precisam ser consideradas antes de aplicar a correção definitiva.

## Arquivos e responsabilidades entregues

- src/modules/panel-contract.ts: contrato puro, sem implementação dos resolvedores.
- src/modules/panel-navigation.ts: dados nativos indexados por módulo.
- src/modules/erp/panel-menu.ts: catálogo portado, grupos explícitos, partes lógicas e ORIGIN_MENU compatível; não importa preferências.
- web/erp/app/lib/origin-menu.ts: importa/reexporta o catálogo; mantém os resolvedores, preferências e filtros existentes.
- web/erp/app/lib/fagoo-menu.ts: consulta a classificação explícita por destino; mantém ordem dos grupos, foco por papel, deduplicação e rótulos apresentados.
- web/erp/ORIGEM.json: registra os dois adaptadores como alterações locais, acrescentando o motivo ao registro preexistente de origin-menu.ts.
- src/erp/role-resources.ts: tabela pura compartilhada e função que retorna cópia dos recursos. src/erp/domains/access/public.ts reexporta ambas.
- src/modules/types.ts: amplia ModuleNavItem.place e acrescenta ModuleDefinition.management opcional.
- src/modules/registry.ts: moduleView acrescenta management, com [] quando não há contribuição; preserva os campos anteriores.
- src/modules/<id>/definition.ts, para erp, os, agenda, mensalidade, pedido, mesas, reserva, suporte, condominio, juridico, saude, ensino, forms e payments: vinculação das contribuições sem alterar navigation.
- tests/management-catalog.test.ts: sete testes Vitest para unicidade e ordenação, páginas/módulos/rótulos/permissões, cobertura portada, classificação independente de tradução, primary/vinculação, recursos por papel e GET /modules (incluindo módulos desligados e negativa a pessoa externa).

## Exportações para as próximas tarefas

Em src/modules/panel-contract.ts:

- PanelErpRole = "admin" | "consulta" | "financeiro" | "vendas" | "estoque" | "fiscal".
- ManagementItem: id, module, group, groupLabel, groupOrder, label, labelKey?, icon, order, primary?, target e permission. target é native/page ou ported/to; permission é page/page ou erp/roles?/resource?. labelKey aceita workCollection ou customers.
- ManagementContext: statusLoaded, modules, role, access, erpRole e vocabulary? (collection_label? e customer_plural?).
- ResolvedManagementItem extends ManagementItem: href e resolvedLabel.

```ts
export type CanEnterManagement = (c: ManagementContext) => boolean;
export type ResolveManagement = (
  items: readonly ManagementItem[],
  c: ManagementContext,
) => readonly ResolvedManagementItem[];
export type ManagementLanding = (
  items: readonly ResolvedManagementItem[],
) => string | null;
export type CanonicalManagementUrl = (url: URL) => URL | null;
export interface ManagementRouterBridge {
  navigate(to: string, options?: { replace?: boolean }): Promise<void>;
  dispose(): void;
}
```

Os quatro nomes em PascalCase são tipos de função; não há funções de runtime nem declarações sem corpo. As implementações canEnterManagement, resolveManagement, managementLanding e canonicalManagementUrl ficam para as tarefas seguintes.

Outras exportações:

| Arquivo | Nomes |
|---|---|
| src/modules/panel-navigation.ts | NATIVE_MANAGEMENT_ITEMS |
| src/modules/erp/panel-menu.ts — dados | ERP_MENU_GROUPS, ERP_MANAGEMENT_ITEMS, ORIGIN_MENU |
| src/modules/erp/panel-menu.ts — tipos | MenuGroupName, CompanyRole (= PanelErpRole), RealTarget, MenuItemDefinition, MenuColumnDefinition, MenuGroupDefinition, ErpPart, ErpManagementItem |
| src/erp/role-resources.ts | ROLE_RESOURCES, resourcesForRole(role: string | null): string[] |
| src/erp/domains/access/public.ts | Reexporta ROLE_RESOURCES e resourcesForRole; conserva as demais exportações |
| src/modules/types.ts | ModuleNavItem.place: "rail" | "admin" | "erp"; ModuleDefinition.management?: readonly ManagementItem[] |
| src/modules/registry.ts | moduleView(m: ModuleDefinition, enabled: boolean), agora com management |

origin-menu.ts mantém as exportações existentes: ORIGIN_MENU; MenuGroupName, CompanyRole, RealTarget, MenuItemDefinition, MenuColumnDefinition, MenuGroupDefinition; COMPANY_PREFERENCES, PreferenceEntry, PreferenceSection, PreferenceCategory, CompanyAccess, ResolvedItem, ResolvedColumn, ResolvedGroup, ResolvedPreferenceCategory, LinkedPreferenceEntry; realTargetAllowed, resolveMenu, resolvePreferences, matchesLocation e activeGroupFor. fagoo-menu.ts mantém WorkspaceModule, focusModule e workspaceMenu.

ErpPart aceita cadastro, catalogo, vendas, compras, estoque, financeiro, fiscal, cobranca, pdv, servicos, resultados e sistema. ErpManagementItem acrescenta part e restringe target/permission às variantes portadas/ERP.

## Contribuições nativas

Cada módulo tem exatamente um primary (marcado abaixo). O grupo é a chave do módulo; groupOrder vai de 100 a 220 em passos de 10, na ordem desta tabela. Dentro do módulo, order começa em 10 e cresce em passos de 10. A permissão repete o page de destino. Os rótulos correspondem a sections de web/workspace-navigation.ts.

| Módulo | id | page | primary |
|---|---|---|---|
| `os` | `os.work` | `work` | sim |
| `os` | `os.deadlines` | `my-deadlines` |  |
| `os` | `os.types` | `work-types` |  |
| `os` | `os.settings` | `service-orders-settings` |  |
| `agenda` | `agenda.calendar` | `agenda` | sim |
| `agenda` | `agenda.settings` | `agenda-settings` |  |
| `mensalidade` | `mensalidade.subscriptions` | `mensalidades` | sim |
| `mensalidade` | `mensalidade.settings` | `mensalidade-settings` |  |
| `pedido` | `pedido.orders` | `pedidos` | sim |
| `pedido` | `pedido.catalog` | `pedidos-cardapio` |  |
| `mesas` | `mesas.tables` | `mesas` | sim |
| `reserva` | `reserva.reservations` | `reserva` | sim |
| `reserva` | `reserva.settings` | `reserva-settings` |  |
| `suporte` | `suporte.support` | `suporte` | sim |
| `suporte` | `suporte.settings` | `suporte-settings` |  |
| `condominio` | `condominio.overview` | `condominio` | sim |
| `juridico` | `juridico.deadlines` | `juridico` | sim |
| `saude` | `saude.records` | `saude` | sim |
| `ensino` | `ensino.overview` | `ensino` | sim |
| `forms` | `forms.forms` | `forms` | sim |
| `payments` | `payments.billing` | `payments` | sim |

os.work tem labelKey workCollection. service-orders é o alias existente de work, sem contribuição duplicada. As páginas de configuração mantêm a mesma permissão por page, para que o resolvedor posterior reutilize canOpenPage e suas restrições administrativas.

## Catálogo portado completo

Todos os itens têm module erp. A tabela segue a ordem original, com order de 10 a 430 em passos de 10. Somente erp.overview é primary. erp.customers tem labelKey customers. Destinos completos (incluindo consultas), rótulos, papéis e recursos estão em src/modules/erp/panel-menu.ts.

Os grupos mantêm esta ordem: resultados/Resultados (10), comercial/Comercial (20), compras/Compras (30), catalogo/Catálogo (40), estoque/Estoque (50), financeiro/Financeiro (60), fiscal/Fiscal (70), pessoas/Pessoas (80).

| id | grupo | part |
|---|---|---|
| `erp.overview` | `resultados` | `resultados` |
| `erp.sales-dashboard` | `resultados` | `resultados` |
| `erp.order-margin` | `resultados` | `resultados` |
| `erp.products-dashboard` | `resultados` | `resultados` |
| `erp.customers-dashboard` | `resultados` | `resultados` |
| `erp.abc-curve` | `resultados` | `resultados` |
| `erp.goals` | `resultados` | `resultados` |
| `erp.products` | `catalogo` | `catalogo` |
| `erp.customers` | `pessoas` | `cadastro` |
| `erp.sellers` | `pessoas` | `cadastro` |
| `erp.employees` | `pessoas` | `cadastro` |
| `erp.financial-accounts` | `financeiro` | `financeiro` |
| `erp.financial-categories` | `financeiro` | `financeiro` |
| `erp.payment-methods` | `financeiro` | `financeiro` |
| `erp.product-categories` | `catalogo` | `catalogo` |
| `erp.price-lists` | `catalogo` | `catalogo` |
| `erp.sales-orders` | `comercial` | `vendas` |
| `erp.outgoing-invoices` | `fiscal` | `fiscal` |
| `erp.consumer-invoices` | `fiscal` | `fiscal` |
| `erp.pos` | `comercial` | `pdv` |
| `erp.sales-proposals` | `comercial` | `vendas` |
| `erp.service-orders` | `comercial` | `servicos` |
| `erp.service-reports` | `comercial` | `servicos` |
| `erp.order-checkout` | `comercial` | `vendas` |
| `erp.sales-reports` | `comercial` | `vendas` |
| `erp.purchase-orders` | `compras` | `compras` |
| `erp.incoming-invoices` | `fiscal` | `fiscal` |
| `erp.suppliers` | `pessoas` | `cadastro` |
| `erp.purchase-suggestions` | `compras` | `compras` |
| `erp.receiving-checkin` | `compras` | `compras` |
| `erp.stock-movements` | `estoque` | `estoque` |
| `erp.stock-count` | `estoque` | `estoque` |
| `erp.warehouses` | `estoque` | `estoque` |
| `erp.stock-reports` | `estoque` | `estoque` |
| `erp.cash-and-banks` | `financeiro` | `financeiro` |
| `erp.payables` | `financeiro` | `financeiro` |
| `erp.receivables` | `financeiro` | `financeiro` |
| `erp.bank-remittances` | `financeiro` | `cobranca` |
| `erp.financial-statement` | `financeiro` | `financeiro` |
| `erp.commissions` | `financeiro` | `financeiro` |
| `erp.cash-control` | `financeiro` | `financeiro` |
| `erp.grouped-billing` | `financeiro` | `financeiro` |
| `erp.financial-reports` | `financeiro` | `financeiro` |

## Compatibilidade e decisões de contrato

- O rodapé “Ver relatórios de cadastros” não possui destino na origem. Continua em ORIGIN_MENU com a mesma forma; não se inventou um target para incluí-lo em ManagementItem. Assim, há 43 destinos portados e um rodapé não navegável, preservado.
- O alias service-orders não duplica a contribuição nativa work, para respeitar a deduplicação de destinos. Seus campos navigation permanecem como antes.
- Os tipos de funções são exportados em PascalCase, conforme a instrução expressa da Base. A ponte e a assinatura de CanonicalManagementUrl seguem o contrato.
- part é classificação futura, sem alterar chaves efetivas: todos os destinos portados continuam sob erp. sistema pertence à união, mas não tem item navegável neste ORIGIN_MENU. Preferências permanecem separadas.
- Os ícones nativos usam os nomes Lucide existentes; os portados preservam as chaves do menu atual. A futura casca deve mapear ambas as listas permitidas.
- Não foram implementadas telas, rotas, resolvedores da Casca, ponte de runtime, novas chaves, migrações ou mudanças de autorização.

## Verificações realizadas e limites

| Verificação | Resultado |
|---|---|
| npm run check | Interrompido pela restrição spawnSync git EPERM em scripts/check-encoding.mjs; não é resultado aprovado |
| ./node_modules/.bin/tsc --noEmit | Aprovado, sem diagnósticos |
| npm run test:erp:painel | 371 arquivos aprovados, um reprovado (build), 372 no total |
| node web/erp/build.test.mjs | Cinco testes aprovados; um reprovado por tamanho inicial |
| Seis verificações do mesmo build com a candidata em memória | Aprovadas; asserções e limites preservados, arquivo da aplicação ainda inalterado |
| node web/erp/test/fagoo-workspace.test.mjs | Três testes aprovados |
| node web/erp/test/origin-menu-model.test.mjs | Cinco testes aprovados |
| Comparação em memória com os dois menus originais de HEAD | ORIGIN_MENU e COMPANY_PREFERENCES idênticos; resolveMenu, resolvePreferences e workspaceMenu idênticos em 2.816 combinações de papéis, recursos, blocos e capacidades |
| node scripts/erp-scope-css.mjs --check | Aprovado |
| node scripts/check-conflict-markers.mjs | Aprovado |
| Verificação independente de codificação | 4.204 arquivos aprovados, incluindo os novos; mesmas regras de UTF-8/BOM/caracteres corrompidos, lista obtida diretamente por git ls-files para evitar a limitação de spawnSync |
| git diff --check | Aprovado |
| Vitest (catálogo, módulos, ERP/painel) | Não executado por instrução do usuário; depende da verificação externa |

Sem commit, sem acesso à rede e sem execução de Vitest. Nenhum teste ou limite foi enfraquecido. Os protótipos de build ficaram em /tmp e não alteraram arquivos da aplicação. O log fornecido foi preservado.
