# Entrega L — lançamentos

`extension.ts` exporta `entriesExtension`; não registra rotas nem eventos por
efeito colateral. `store.ts` usa a autorização e as projeções congeladas de F0.
Toda escrita é entregue a `commitChild`; não há gravação independente de
histórico, atividade, publicação ou financeiro.

`model.ts` valida textos por pontos de código, milésimos inteiros entre zero e
10^12, instante Unix em milissegundos e classificação. Lista: 50 registros por
padrão, máximo 100, ordem decrescente por `(occurred_at,id)`, cursor vinculado à
área, pai, coleção, filtros e contexto de visibilidade. Arquivados ficam fora
por padrão; o limite de 10.000 inclui todos os registros.

## Linhas para o integrador

Em `src/modules/os/extensions.ts`, no bloco reservado:

```ts
import { entriesExtension } from "./entries/extension";
```

Acrescentar à lista `osExtensions`:

```ts
entriesExtension,
```

Em `src/modules/os/definition.ts`, acrescentar a `events`:

```ts
"os.entry.created",
"os.entry.revised",
"os.entry.archived",
```

Acrescentar a `bot.deny`:

```ts
"os.entry.",
```

As três escritas aceitam a classificação sensível na mesma rota. Por isso as
operações inteiras ficam fora do catálogo de propostas do bot; o manipulador
também exige `mayReadSensitive` para criar, corrigir ou arquivar conteúdo
sensível. A leitura pelo bot usa somente registros públicos, mesmo com
`via.masked=false`. Não há ferramentas MCP novas.

O runtime de F0 já consome descritores e a lista de rotas limitadas em
`src/index.ts` já permite
`service-orders/conversation/:id/orders/:order_id/entries`. Não precisa de
registro adicional nesses arquivos.

Aplicar `0104_os_entries.sql` depois de `0100_os_work_types.sql`: a chave
estrangeira composta depende do índice único do pai criado por M.

## Pontos para M e I

Correção cria **um novo filho**: `ChildMutation.id` é o ID novo e
`expected_version` é `null`. A primeira instrução é `INSERT ... SELECT`, que
confere a área, pai, versão e ausência de arquivamento/substituição do original.
A segunda arquiva o original, incrementando sua versão. M deve abortar o lote
se a primeira instrução afetar zero linhas, como exige F0. O retorno/histórico
da mutação identifica o novo lançamento; `replaces_id` preserva a cadeia. Os
nomes `replaces_id` e `archived_at` constam de `changed_fields` na correção.

IDs novos e chaves de mutação derivam de SHA-256 de área, ator, pai, operação,
alvo e `requestId`. Repetições confirmadas ainda chamam `commitChild`, para M
concluir a publicação pendente. Não há sucesso antecipado que dispense essa
recuperação. A integração deve validar o replay durável e a atomicidade reais
de M. Histórico paginado continua na rota do pai, de M.

## Complementos e lacunas do contrato

- Foi acrescentado `GET service-orders/:id/entries/summary`, pois a tarefa
  pede somar e a seção 5 não define essa rota. Aceita `kind` e
  `include_archived=0|1`; retorna `{data: [{kind, unit, count,
  quantity_milli}]}`. Soma por tipo **e unidade**. `quantity_milli` é texto
  decimal exato, ou `null` quando todas as quantidades são nulas: o máximo
  agregado de 10^16 ultrapassa o inteiro seguro de JavaScript. Registros
  ocultos são excluídos antes da agregação. Arquivados, inclusive originais
  corrigidos, só entram com `include_archived=1` (total histórico).
- O DDL foi copiado literalmente da seção 4. Não existe campo monetário nos
  DTOs ou no DDL congelado. `value`/`value_cents` são rejeitados; nenhum valor
  é silenciosamente descartado ou armazenado em texto. A definição desse
  campo depende de revisão coordenada de contrato, não foi inventada por L.
- `CustomWorkType`/`WorkTypeView` não contêm catálogo de tipos de lançamento;
  apenas `features.entries`. Assim `kind` segue o contrato atual: texto livre
  de 1–64 pontos de código, sem enumeração global nem catálogo paralelo.
  Restringir os tipos de lançamento pelo snapshot requer uma assinatura
  coordenada com M/F0. As assinaturas congeladas ficaram intactas.
- Datas são instantes Unix inteiros em milissegundos, de zero ao limite de
  `Date` (8.640.000.000.000.000), sem conversão de datas civis/string.
- Correções nunca reduzem `sensitive`. Não existe edição de conteúdo nem
  exclusão; os textos, quantidades e datas anteriores permanecem armazenados.

## Verificação

`tests/os-entries.test.ts` usa a fixture comum intacta. O embutido e as falhas
`not_implemented` usam F0 real. Os cenários personalizados usam mocks locais
explícitos de resolução e `commitChild`, mantendo a autorização real e
executando SQL no D1. O dublê simula CAS, lote atômico, histórico e recuperação
de publicação; não substitui os testes de integração da implementação de M.
Enquanto 0100 não chega, somente o teste cria o índice único referenciado do
pai, com o mesmo nome e colunas previstos por M.

Rodar externamente: `npx vitest run tests/os-entries.test.ts`. Vitest e Wrangler
não foram executados nesta máquina. O orçamento D1 da invocação completa,
catálogo de propostas e recuperação durável de M ficam para a integração.

Verificação local: `npx tsc --noEmit` aprovado; checagem TypeScript isolada do
teste também aprovada, com os tipos de `@cloudflare/vitest-plugin/types` e a
declaração local de `Cloudflare.Env`. `node scripts/check-conflict-markers.mjs`
aprovado. A comparação textual do DDL com o bloco da seção 4 não teve diferenças.
Os seis arquivos entregues são texto ASCII/UTF-8 sem BOM, com LF.

Comando da checagem isolada (não executa Vitest):

```sh
npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --types @cloudflare/workers-types,@cloudflare/vitest-plugin/types,vite/client --strict --skipLibCheck --allowImportingTsExtensions tests/os-entries.test.ts
```
