# Porte do ERP (Fagoo) por domínio — regras para quem porta

Base: `feat/erp-motor`. Provas e números: `docs/ERP-FASE0.md`. Mapa de fechos:
`docs/erp-closure-map.json`. Dono de cada RPC e das funções compartilhadas:
`src/erp/domains/ownership.generated.json`.

## Tronco e junções

O tronco comum do ERP é **`feat/erp-motor`**. Só a sessão N faz push nele (decisão da orquestração, 16/11/2026).
- **Sempre verde.** Um branch de domínio só entra com `npm run test:erp` e `npm run check` verdes.
  - Teste pendente (`todo`) só entra declarado, com o motivo.
  - Depois de juntar, a N roda tudo de novo. Se quebrar, quem conserta é o dono do domínio que entrou, e a junção espera.
- **Cada domínio no próprio branch:**
  - `feat/erp-catalogo` (P);
  - `feat/erp-catalogo-produtos` (G);
  - `feat/erp-financeiro` (O);
  - `feat/erp-estoque` (N).

  Cada sessão junta o tronco no próprio branch com frequência. Ao fechar um bloco verde, avisa a N com o commit, e a N junta.
- **Ordem atual:**
  1. Catálogo da P: juntado;
  2. `feat/erp-catalogo-produtos` da G, quando a fase em andamento estiver verde;
  3. Financeiro da O, depois de registrar os escritores no harness oficial.
- **`feat/erp-base`** é só um apelido, igual ao tronco. Não use: a base é `feat/erp-motor`.
- **Conflito de tetos** (`LIMITS` no `schema-parity`): na junção vale o menor número que passa.

## Testes na máquina compartilhada

O Dell tem 6 núcleos (12 threads), e várias sessões rodam suítes ao mesmo tempo. Em 16/11 havia 41 processos `node` e 6 `workerd`, com a CPU a 100%. Resultado: estouros de 5 s em testes que passam sozinhos e suítes que travam sem saída. Regras (orquestração, 16/11/2026):
1. **No desenvolvimento, rode só o que você mexeu**: o arquivo ou o domínio. A suíte completa (`npm test`, `npm run test:erp`) fica para antes do push.
   - `npm run test:erp:domain -- <domínio>`, por exemplo `catalog`, `finance` ou `stock`, roda `tests/erp/<domínio>/`, `tests/erp/fagoo/<domínio>-*` e `tests/erp/<domínio>-*`.
   - `--harness` acrescenta os testes do harness, e `--base` os do motor: paridade do esquema, assinaturas, erros de CHECK e UNIQUE, desvios e texto.
2. **No máximo 3 trabalhadores na suíte completa.** O `npm run test:erp` e o comando por domínio já usam `--test-concurrency=3`; no vitest, `--maxWorkers=3`.
3. **Tempo-limite estourado sob carga não é falha de lógica, mas também não é "passou".**
   - Rode o arquivo sozinho. Se passar, registre como "tempo-limite sob carga".
   - Teste que depende de tempo real ganha tempo-limite próprio no teste.
   - Nunca aumente o tempo-limite global.
4. **Não deixe processos órfãos** (`wrangler tail`, `workerd`, suítes abandonadas). Confira e encerre os seus ao fim de cada bloco.
5. **Teste que depende da hora em que a suíte roda é defeito do teste** (orquestração, 17/11/2026). Use relógio injetado (o `clock`/`now` do motor, `vi.useFakeTimers` só com `Date`), nunca `Date.now()` do momento.

### Suíte do tronco (`npm run test:trunk`)

Antes de cada push no tronco a N roda `npm run test:trunk` (orquestração, 17/11/2026). Uma rodada com o núcleo dentro levou ~35 min (test:erp 15,5 min, vitest 18,6 min), por isso o vitest é separado:
- **Sempre:** `npm run check` (marcas de conflito, codificação e tsc 5.9), o tsc 7 (o do worktree do painel, ou `ERP_TSC7`) e `npm run test:erp`.
- **Vitest só do motor**, quando a junção (diff contra `origin/feat/erp-motor`) fica dentro de `src/erp`, `tests/erp`, `tests/erp-*.test.ts`, `scripts/erp` e `docs`: roda `tests/erp-*.test.ts`, `tests/erp/**/*.test.ts` e o que importa `../src/erp`.
- **Vitest inteiro**, quando:
  - a rodada vai à instalação de teste sem a junção da M (`--full`);
  - traz migração do D1 (`migrations/`);
  - toca arquivo fora do motor, ou a costura e a montagem (`src/erp/api`, `src/index.ts`);
  - guarda: o último vitest inteiro foi há mais de 24 h ou há 2 rodadas (estado em `output/test-trunk-state.json`).
- No fim, o script imprime qual vitest rodou e por quê, as contagens e os tempos. O relato da rodada copia esse bloco. `--plan` só mostra a decisão.
- **Suíte completa só pelo `npm run test:trunk`** (orquestração, 17/11/2026), em qualquer sessão. Ele pega uma vaga da trava entre sessões (`scripts/erp/suite-lock.mjs`, diretório `D:\Code\wabotia\.suite-locks`): no máximo 2 suítes completas ao mesmo tempo na máquina, e a rodada do tronco tem vaga própria (`ERP_TRUNK_ROUND=1`, só a N). Sem vaga, espera e mostra, a cada minuto, quem está segurando (pid, worktree, branch, desde quando). Vaga de processo morto ou com mais de 90 min é liberada; a vaga sai na saída, também em erro. Teste de um arquivo ou de um domínio (`test:erp:domain`) não entra na fila.

### Codificação

Todo arquivo de texto versionado é UTF-8 sem BOM (orquestração, 17/11/2026). O `npm run check` roda `scripts/check-encoding.mjs` e falha com:
- bytes inválidos em UTF-8;
- BOM no início;
- U+FFFD;
- sequências de UTF-8 lido como Latin-1 ou Windows-1252 (`Ã£`, `Ã§`, `Ã©`, `Ã‡`, `â€`).

Arquivo que cita essas sequências de propósito entra na lista `ALLOWED` do script, com o motivo.

No PowerShell 5.1:
- `Get-Content` e `Set-Content` sem `-Encoding` leem e gravam em ANSI, e `Out-File` grava com BOM;
- `[IO.File]::ReadAllText(caminho)` lê UTF-8, mas `WriteAllText` com texto vindo de `Get-Content` grava o estrago.

Prefira a ferramenta de edição. Em script, use `[IO.File]::ReadAllText` e `WriteAllText` com `New-Object Text.UTF8Encoding($false)`.

## Quem é dono de quê

| Pasta | Domínio | Sessão |
|---|---|---|
| `src/erp/engine/`, `src/erp/schema/`, `scripts/erp/gen-*.mjs`, `tests/erp/harness/` | motor e base (**congelados**) | N |
| `access/`, `preferences/public.ts` (`get`), `sync/` (contrato de integração) | núcleo transversal | N |
| `reference/`, `company/`, `access/` | Referências, Empresa, Acesso | N |
| `catalog/` | Catálogo, contatos, preços (`erp_catalog`, `erp_pricing`) | P (`feat/erp-catalogo`) |
| `catalog/` (produtos, preços: fase da G) | produtos e preços | G (`feat/erp-catalogo-produtos`) |
| `stock/` | Estoque | N (`feat/erp-estoque`) |
| `finance/` | Financeiro | O (`feat/erp-financeiro`) |
| `documents/`, `fiscal/`, `cnab/`, `pos/`, `preferences/` | o resto, na ordem do relatório | a alocar |

`documents/internal.ts` (`autoProducts`) e `documents/public.ts` (`allowed`)
já existem; são do domínio Documentos. `catalog/` (`document_product`,
`validate_data`, `unit_price`, `next_product_code`, camada de tabela de
`record`/`product`) passa para a P.

Mudança em pasta congelada ou de outro domínio: peça ao dono. Nunca edite.

## O que cada sessão edita

- `src/erp/domains/<domínio>/`:
  - `public.ts`: o que outros domínios chamam;
  - `internal.ts` e ajudantes;
  - `rpc/<rpc>.ts`;
  - `index.ts`: um import por arquivo de `rpc/`.
- `scripts/erp/overrides/<domínio>.mjs`: decisões do conversor do domínio.
- `tests/erp/<domínio>/` e `tests/erp/fagoo/<domínio>-*.test.mjs`.

## Funções de outro domínio

- Use só o `public.ts` do dono. Cada `public.ts` reexporta
  `stubs.generated.ts`: as funções que outros domínios chamam e ainda não
  foram portadas.
- O stub lança `0A000 rpc_not_ported:<schema.função>`, como RPC não
  portado. O diferencial do RPC que depende dele falha até o dono portar: é
  o sinal de pedir.
- O nome TS é o camelCase da função do Fagoo (`erp_access.permission_keys` →
  `permissionKeys`). Quando há colisão no domínio, leva o schema na frente
  (`homeAllowed`).
- Para portar uma função compartilhada:
  1. Escreva-a no `public.ts` com o mesmo nome. Pode ser `export { x } from "./internal.ts"`.
  2. Rode `node --no-warnings scripts/erp/gen-ownership.mjs`: o stub sai.
- Assinatura: o primeiro argumento é `ctx: RpcContext` quando a função
  escreve ou usa relógio e `settings`. Leitura pura pode receber `db: SqlDriver`.
  Os demais argumentos seguem a ordem do Postgres.
- Antes de rodar o `gen-ownership`, gere o mapa:
  `node --no-warnings scripts/erp/closure-map.mjs --fns --json output/closure-fns.json`.

Funções mais usadas entre domínios (o resto está em `ownership.generated.json`):

| Função do Fagoo | Dono | Nome TS | Domínios | RPCs | Situação |
|---|---|---|---|---|---|
| `erp_access.permission_keys` | access | `permissionKeys` | 11 | 362 | stub (prioridade da N) |
| `erp_access.permission_parent` | access | `permissionParent` | 11 | 360 | portada |
| `erp_access.permitted` | access | `permitted` | 10 | 359 | portada |
| `erp_preferences.get` | preferences | `get` | 9 | 201 | portada |
| `erp_sync.enabled`, `applying`, `enqueue` | sync | `enabled`, `applying`, `enqueue` | 9 | 78–81 | portadas |
| `erp_catalog.contact_scope`, `contact_visible_to` | catalog | `contactScope`, `contactVisibleTo` | 8 | 91–142 | stub |
| `erp_documents.allowed` | documents | `allowed` | 8 | 114 | portada |
| `erp_documents.require_access`, `require_role`, `os_permitted`, `contact_usable` | documents | `requireAccess`, … | 8 | 75–100 | stub |
| `erp_finance.require_access`, `keys`, `document_seller`, `commission_seller`, `uuid_value` | finance | `requireAccess`, … | 7 | 38–127 | stub |
| `erp_access.resources_for_role` | access | `resourcesForRole` | 7 | 122 | stub (prioridade da N) |
| `erp_catalog.fold`, `unit_price`, `unit_price_numeric`, `data`, `dto` | catalog | `fold`, … | 7 | 33–90 | portadas |
| `erp_purchase_receipts.active` | stock | `active` | 7 | 42 | stub |
| `erp_stock.require_access` | stock | `requireAccess` | 6 | 95 | portada |
| `erp_documents.normalize`, `normalize_core` | documents | `normalize`, `normalizeCore` | 4 | 6 | stub |

## Como portar um RPC

1. **Fecho:** `node --no-warnings scripts/erp/call-graph.mjs <rpc> --source`. Corpos isolados: `node --no-warnings output/fnsrc.mjs schema.função`.
2. **Código:**
   - Escreva `rpc/<rpc>.ts` com `registerRpc("<rpc>", fn)` e importe em `index.ts`.
   - **Argumentos: o motor já trata, não repita no corpo.** O `callRpc` aplica `engine/args.ts` antes do corpo, com as assinaturas do oráculo (`engine/signatures.generated.ts`, gerado por `scripts/erp/gen-signatures.mjs`):
     - argumento desconhecido ou obrigatório faltando → 42883;
     - tipos, na ordem em que os argumentos vieram:
       - uuid → 22P02;
       - integer e bigint → 22P02 e 22003 (leitura do PG 17, com espaço, sinal, `0x`/`0o`/`0b` e `_`);
       - boolean → 22P02;
       - date → 22007/22008;
       - `uuid[]`/`text[]` (`malformed array literal`);
     - DEFAULT do argumento omitido; `null` explícito continua `null`.

     O corpo recebe:
     - uuid canônico em minúsculas;
     - integer como `number`;
     - bigint como `number`, ou `bigint` além de 2^53;
     - boolean como `boolean`;
     - text sempre texto.

     jsonb e timestamptz passam como vieram. Tire os auxiliares locais (`argOr`, `uuidArg`, `?? 25`…). `tests/erp/signatures.test.mjs` confere tudo contra o oráculo.
   - Diferença conhecida: date só no formato `AAAA-MM-DD`. O Postgres aceita outros formatos, como `2026-11-16T10:00Z`; a erp-api manda ISO.
   - **Erros de restrição: o motor já traduz.** O `fromSqlite` devolve a mensagem do Postgres:
     - CHECK: 23514 `new row for relation "<tabela>" violates check constraint "<restrição>"`;
     - UNIQUE e PK: 23505 `duplicate key value violates unique constraint "<restrição ou índice>"`.

     Os nomes vêm do DDL gerado e são conferidos contra o oráculo (`tests/erp/check-errors.test.mjs`). Exceção: `erp_finance.movement(settlement_id)` tem dois índices parciais nas mesmas colunas, e a mensagem do SQLite não diz qual. Ali sai o código 23505 com a mensagem do SQLite. Não traduza à mão no domínio.
   - **Coluna identity (número que a pessoa vê): use `nextIdentity(ctx, "<schema>__<tabela>", "<coluna>")`** (`engine/sequence.ts`), nunca max+1 nem o rowid automático.
     - O número não volta com a transação, como o `nextval`: um RPC que falha depois de pedir o número o consome nos dois motores.
     - Peça o número **na posição do `nextval` no INSERT, na ordem das colunas** (achado da O no faturamento agrupado). Se uma coluna anterior recusa, o Postgres ainda não consumiu; se a recusa vem de uma coluna depois, já consumiu.
   - **Dois campos inválidos na mesma linha: a ordem das recusas no Postgres muda com o cache de planos** (achado da O na conciliação, `statement_import`).
     - Vale para comando SQL do PL/pgSQL: INSERT, UPDATE ou SELECT com subconsulta.
     - Nas 5 primeiras execuções na sessão, o plano é custom. As funções IMMUTABLE com argumentos de variável (`cents`, `txt`, `ofx_text`, `uuid_value`) são dobradas no planejamento e recusam antes das STABLE e VOLATILE, como a `day`.
     - Da sexta em diante, o plano é genérico e segue a ordem das colunas.
     - O motor segue a ordem das colunas. Nos geradores do diferencial, estrague **um campo por linha**; teste de dois campos inválidos na mesma linha não é estável no oráculo.
   - Gatilhos viram funções da camada de tabela, chamadas por quem escreve (`stock/internal.ts`, `catalog/internal.ts`). Os que só lançam erro já estão em SQL gerado.
   - **Tabela só do motor (dado que o Fagoo não tem): `src/erp/schema/engine-tables.ts`**, combinada com a N antes. DDL do SQLite à mão, com `since` (a versão em que nasce) e o id da entrada em `structural.ts`. Ela vai no fim do `ERP_DDL` e muda o `ERP_DDL_HASH`, entra no backup e é criada nos objetos já migrados pelo passo `createEngineTables` em `migrate.ts` (suba `ERP_DDL_VERSION`). Fica fora do diferencial (o oráculo não a tem): o RPC que só o motor tem é testado no SQLite, com o teste do workerd para a migração e o backup.
   - **FK `DEFERRABLE` (a linha aponta para outra que nasce depois na mesma transação): `deferForeignKeys(ctx, "<schema>__<tabela>")`** (`engine/fk.ts`). Liga o `PRAGMA defer_foreign_keys` e confere as tabelas com `foreign_key_check` antes do COMMIT, pela fila de adiados: violação vira 23503 e desfaz. Nunca ligue o PRAGMA sem a conferência: violação adiada que chega ao COMMIT reinicia o objeto (`schema/migrate.ts`, prova 1). Exemplo: a baixa da reserva (`consumed_command_id` → o movimento do lançamento).
   - **Gatilho `DEFERRABLE INITIALLY DEFERRED`: `defer(ctx, fn)`** (`engine/registry.ts`). Roda no fim da transação, antes do COMMIT, na ordem em que foi enfileirado (os da mesma linha, na ordem do nome do gatilho), incluindo o que a própria fila enfileira. Não deduplique: o Postgres enfileira um evento por linha escrita. Um erro no adiado desfaz a transação inteira.
3. **Testes originais:**
   - Copie para `tests/erp/fagoo/`, trocando só os auxiliares:
     - criar o banco → `dualFixture()`;
     - `select public.rpc(...)` → `f.rpc`;
     - SQL direto de escrita → `db.query` + `f.sync()`.
   - Asserções iguais. Teste de grants/RLS sai, declarado no cabeçalho.
   - Função interna: `f.dual(nome, pg, () => inTransaction(f.driver, ctx => …))`.
4. **Diferencial aleatório:** `tests/erp/stock-post-diff.test.mjs` e `tests/erp/cross-domain.test.mjs` são os modelos.
5. **Pendências cobertas em TS:**
   - CHECK sem tradução ou gatilho em PL/pgSQL que o domínio cumpre em TS vai em `covered`, no `scripts/erp/overrides/<domínio>.mjs`:
     ```
     export const covered = {
       checks: { "erp_catalog.payment_method.payment_method_defaults_fit": { where: "src/erp/domains/catalog/…ts função", test: "tests/erp/catalog/….test.mjs" } },
       triggers: { "erp_company__file.file_identity": { where: "…", test: "…" } },
     };
     ```
   - As chaves seguem o `report.generated.json`: CHECK `schema.tabela.restrição`, gatilho `schema__tabela.gatilho`.
   - O `test` precisa exercitar a recusa nos dois motores.
   - `tests/erp/schema-parity.test.mjs` recusa um item que não esteja pendente, sem `where` ou `test`, ou com arquivo de teste inexistente.
   - Os tetos (`LIMITS`, hoje CHECK 221 e gatilhos 237) contam só o que ninguém cobre: baixe-os no seu branch ao cobrir. Na junção eu concilio.
   - Gatilho em PL/pgSQL que é só "se condição, recusa" sobre colunas da própria linha (imutabilidade, por exemplo, em tabela que o motor não muda) não precisa de TS: vira gatilho do SQLite por `sqlTriggers` no `scripts/erp/overrides/<domínio>.mjs` (chave `schema__tabela.gatilho`, `{ when, code, message, reason }`; o `when` é SQLite com `OLD.`/`NEW.`).
     - O gerador confere `code` e `message` no corpo da função do oráculo.
     - O DDL muda, então combine a versão comigo (passo `recreateTriggers` em `migrate.ts`).
     - Teste no modelo `tests/erp/cnab-sql-triggers.test.mjs`: o mesmo UPDATE/DELETE direto nos dois motores.
     - O SQLite dispara primeiro o gatilho criado por último; o gerador cria em ordem inversa do nome, para valer a ordem do Postgres.
6. **Fechamento:** um domínio só fecha com o diferencial verde e os tetos baixados. Aviso curto à orquestração com as linhas de TS, os RPCs portados e os testes.

## Regras que valem para todos

- **Origin fora não é "sem efeito"** (orquestração, 17/11/2026; achado da O no `commission_seller`, que virou constante e só divergiu quando o `transition` passou a rodar nos dois motores).
  - "Origin fora" (`sync/origin-off.ts`, desvio `origin-fora`) mantém a sincronização operacional, aplicação e envio legados desligados. A função interna [Receber dados do Bling](RECEBER-BLING.md), acrescentada na versão 11 do esquema, tem interruptor independente e coleta somente para acervo no `Coordinator`; não reativa esses executores nem o papel PostgreSQL.
  - Leitura de linha espelhada ou de tabela do Origin se porta como leitura: `origin_sync.*`, `erp_catalog.origin*`, `authority='origin'`, `erp_document_mirror.visible`. Sem dado, ela devolve o mesmo que a constante devolveria; com dado, o harness compara.
  - Guarda sobre registro espelhado (`authority='origin'`) se porta como guarda: `erp_document_mirror.guard_document`, `guard_item`, `guard_effect`, `require_visible`.
  - O que precisa do Origin vivo pode sair 0A000 visível (`notPorted`). Valor inventado ou "nada acontece" silencioso, não.
- **Dialeto:** as dez regras de `docs/ERP-FASE0.md`.
  - i64 lido por `CAST(… AS TEXT)`.
  - BigInt nunca como parâmetro.
  - Nada de FK adiada.
  - Máximo de 100 parâmetros.
  - `LIKE` do usuário vira `instr()`.
  - `lower`/`NOCASE` só valem para ASCII: compare em TS ou use a coluna `__fold`.
  - A ordem das chaves do jsonb vem de `jsonbKeys`; o texto canônico, de `jsonbText`.
  - **Ordem dos gatilhos** (achado de 17/11, `tests/erp/cnab-sql-triggers.test.mjs`): o Postgres dispara os gatilhos da mesma tabela e momento em ordem alfabética do nome; o SQLite dispara primeiro o criado por último.
    - Com dois gatilhos que recusam a mesma linha, o erro muda de um motor para o outro.
    - O gerador (`gen-sqlite.mjs`) cria os gatilhos de cada tabela em ordem inversa do nome, e o passo `recreateTriggers` (`migrate.ts`) refaz essa ordem nas instâncias que já existem.
    - Guarda escrita em TS no ponto de um gatilho segue a ordem do nome, junto com as outras guardas da mesma tabela e do mesmo momento.
- **Decimais:**
  - A escala de cada coluna está em `columns.generated.ts`.
  - `dec`/`dec_i64` são escalados (`toScaled`, `formatScaled`).
  - `dec_text` é decimal em TEXT (`decText`, `compareDec`, `exact`): nunca compare nem some no SQL.
  - Casas a mais são recusadas (CHECK `trunc`), nunca arredondadas.
- **Texto com a semântica do Postgres** (`src/erp/engine/text.ts`, provado contra o oráculo em todo o Unicode por `tests/erp/text.test.mjs`):
  - `lower()` e `upper()` são caractere a caractere. Use `pgLower`/`pgUpper`, nunca `toLowerCase`/`toUpperCase`:
    - não há sigma final (`ΟΔΟΣ` → `οδοσ`);
    - `İ` → `i`, e o `upper` de `ß` é `ẞ`;
    - ~350 caracteres seguem a tabela Unicode do próprio Postgres.
  - `\s` e `[[:space:]]` não pegam NBSP, U+1680, U+2007, U+202F nem U+FEFF, mas pegam U+0085 e U+3000. Use `PG_SPACE`/`pgHasSpace`.
  - `[[:cntrl:]]` pega C0, DEL e C1. Use `PG_CNTRL`/`pgHasCntrl`.
  - Os ajudantes `pgBtrim` (só espaço), `pgLength` e `pgLeft` contam caracteres, não unidades UTF-16.
  - O cliente do PGlite tira um U+FEFF do começo do texto devolvido. Em teste, ponha um caractere na frente (`'x'||…`).
- **Armazenamento** (`storage.buckets`/`storage.objects` do Supabase): no Wabotia é o R2.
  - `preferences.storageReady()` não lança (o R2 sempre existe; o harness cria o bucket no oráculo).
  - Objeto conferido dentro do RPC: declare as chaves em `registerRpc(nome, fn, { objects: (args) => ["erp-attachments/…"] })` e leia com `ctx.objects(chave)`. Ele devolve `{size, mimetype}` ou null; o objeto `erp:` lê do R2 antes da transação.
  - No teste, `f.putObject(bucket, nome, tamanho, tipo)` grava o objeto nos dois lados.
  - Exemplo: `company/rpc/files.ts`.
  - **Do lado do Worker** (`src/erp-storage.ts`): a erp-api do Fagoo chama o `/storage/v1` do Supabase, e a costura responde do R2, no bucket MEDIA que a instalação já tem.
    - Chave: `erp-storage/<área>/<bucket>/<caminho>`, a mesma do `erpObjectKey` que o objeto `erp:` consulta.
    - Bucket lógico do Fagoo → prefixo no MEDIA (`ERP_BUCKETS`), com o tamanho e os tipos do `storage.buckets` do Fagoo e o bloco que precisa estar ligado na área:

      | Bucket (por dentro) | Apelido (endereço público) | Conteúdo | Bloco | Link assinado |
      |---|---|---|---|---|
      | `erp-attachments` | `anexos` | anexos de documento, contato, produto, financeiro e funcionário; logotipo e arquivos da empresa | `erp` | não |
      | `brufap-cnab` | `cobranca` | remessas e retornos (`profiles/<perfil>/remittances/<hash>.rem`, `…/returns/<hash>.ret`) | `erp-cobranca` | não |
      | `brufap-exports` | `exportacoes` | pacote da exportação da empresa | `erp` | sim (120 s) |
      | `brufap-received-dfe` | `dfe` | notas recebidas (DF-e) | `erp-fiscal` | não |
      | `brufap-fiscal-artifacts` | `fiscal` | XML assinado, recibos e respostas da SEFAZ | `erp-fiscal` | não |

      Ficam de fora (404, como qualquer bucket fora da tabela): `origin-backups` e `origin-fiscal-xml` (Origin, bloco "externo") e `brufap-a1-vault`. O certificado A1 nunca fica no Wabotia: mora no cofre da NFapi, separado do sistema que tem bots e integrações (decisão do usuário). Gravar ou ler nele dá 404 mesmo com `erp-fiscal` ligado.
      O novo [acervo recebido do Bling](RECEBER-BLING.md) usa prefixo privado por área no `MEDIA` existente e download autenticado próprio; não abre esses buckets lógicos legados.

      O caminho é o que a RPC registra, e o prefixo (área e bucket) é posto pela camada. Por dentro (chave no R2, `ctx.objects` e o diferencial) vale o nome do Fagoo, por exemplo `ctx.objects("brufap-cnab/" + caminho)`; o apelido só aparece no endereço público.
    - Rotas: enviar (`POST`, `x-upsert`; chave repetida → 409, que os adaptadores do Fagoo já aceitam), substituir (`PUT`), baixar (`GET …/authenticated/…`), apagar (`DELETE`) e assinar (`POST …/sign/…`).
    - Nada é público. A leitura é pela rota da erp-api, com o envelope da pessoa, ou, só na exportação, por URL assinada. Com o bloco do bucket desligado, nada entra nem sai (403), mesmo que a rota tenha passado.
    - URL assinada: a costura troca o endereço local por `/api/public/erp-storage/<área>/<apelido>/<caminho>?token=…`, na origem em que a pessoa chamou. O token é um HMAC da área, do bucket (o nome do Fagoo), do caminho e da expiração, com até 1 h. A chave do HMAC é derivada da MASTER_KEY com o rótulo `erp-storage-link/v1`, nunca a MASTER_KEY direto. Com o ERP desligado na área, o link para de valer.
    - **Arquivo grande sem montar na memória** (exportação da empresa, até 50 MiB): `createErpUpload` grava em partes de 5 MiB e só dá o nome no fim, com o SHA-256 (`exports/<id>/<sha>.zip`); `createZipStream` (`src/erp-zip.ts`) escreve o ZIP direto nele, um conjunto de dados por vez, página por página. Os dois juntos substituem o `createZip` + `exportStorage.put` do `runExport` do Fagoo, que monta o pacote inteiro e o copia de novo no `finish` (mais de 100 MB num isolado de 128 MB).
    - **Tarefas da plataforma** (`src/erp-export.ts`): o `runPlatformTasks` do Fagoo chama o `TASK_HANDLERS` por dentro, então o agendador do ERP chama `runErpPlatformTasks({ env, profile, rpc, exportStorage, attachments, … })`. É o mesmo laço, com as mesmas RPCs, e o `company_export` é o `runExportStreamed`. As outras tarefas, como notificações e limpeza das exportações vencidas, são as do Fagoo. `tests/erp-export.test.ts` confere que o pacote (entrada a entrada) e a sequência de RPCs são os do `runExport` do Fagoo.
    - Testes: `tests/erp-storage.test.ts`, com os adaptadores do Fagoo sem alteração.
- **Identidade** (`auth.*` do Supabase): use a porta `ctx.identity` (`src/erp/engine/identity.ts`), nunca uma tabela `auth`.
  - **Envelope.** O Worker o preenche e o manda no cabeçalho `x-erp-identity` (JSON em base64url). Traz:
    - `actor`: `user_id`, `name`, `email`, `erp_role` (`admin|consulta|vendas|financeiro|estoque|fiscal` ou null), `session_id`, `aal` (`aal1`/`aal2`), `verified_factor`, `is_agent`;
    - `people`: as pessoas da área, com os mesmos campos menos a sessão, ou null.
  - **Projeção.** Com `people`, o Acesso atualiza `erp_access.membership` e `profile` antes de cada RPC (`access/identity.ts`). Por isso o `activeRole(db, user)` de todo domínio continua valendo, e nenhum RPC grava papel.
  - **Ajudantes:** `personExists`, `personEmail`, `hasVerifiedFactor` e `sessionAal2` (`access/identity.ts`).
  - **No teste:** `tests/erp/access/identity-helper.mjs` (`rpcAs`) monta o envelope do `auth.*` do oráculo, para os dois motores verem as mesmas pessoas, sessões e fatores.
  - **Diferenças estruturais.** O que do oráculo não existe no motor por decisão (`auth`, os 8 RPCs de usuários, agentes, storage, Origin) está em `src/erp/schema/structural.ts`, com o motivo e o substituto.
- **Segundo fator** (fase 3, `erp_access_gate_v2`): é por pessoa e por sessão, não por RPC.
  - Com a política ligada (`mfaPolicyOn`), quem está no escopo (`mfaInScope`) só usa o ERP inteiro numa sessão aal2.
  - O escopo é o papel admin, o papel financeiro ou quem tem alguma das `MFA_SENSITIVE` (`access/internal.ts`).
  - `gateRequired` também liga com horário de acesso próprio ou de vendedor.
- **Migrações congeladas sempre com LF** (`.gitattributes`). O manifesto de SHA-256 e o oráculo leem com LF.
- **Recibo de comando:** recibo que vem de outro domínio leva escopo (`scopedCommand`), porque a tabela de recibos é compartilhada.
- **Origin desligado** (PLANO-FAGOO.md, item 17; desvio `origin-fora` em `src/erp/schema/deviations.ts`): `erp_sync.settings.enabled=false` nos dois motores, então `enqueue` não grava. O que fazer com o que toca o Origin:
  - **Chamada a `erp_document_mirror.require_visible`:** a linha sai.
  - **`report_coverage`:** vira a constante `{"origin":"brufap","mirror_excluded_count":0,"coverage":{"partial":false,"reason":"native_effects_only"}}`.
  - **Regras nativas guardadas em schemas do Origin:** são `native_item_required`, a imutabilidade em `guard_document`, o ramo nativo de `visible`, `erp_fiscal_mirror.native_visible`/`report_visible` e `guard_zero_title`. Elas são portadas no domínio dono da tabela.
  - **Colunas de proveniência que ficam como constante:** `document.origin`/`authority` = 'brufap', `title.origin_zero_source_id` = NULL.
  - **Nomes com "origin" que são nativos e ficam:** `stock-origin.mjs`, `erp_document_copy_origin`, `product.origin` (ICMS).
  - **Mapa completo:** `sessao-N-origin-poda.md`, na pasta de notas.
  - **Origin vivo, 0A000 visível (`rpc_not_ported`), Catálogo** (orquestração, 17/11/2026): são etapas da sincronização. Revisam e aplicam o que o coletor do Bling deixou em `origin_sync.raw_record`. A decisão posterior mantém a coleta dentro do `Coordinator`, como acervo histórico; adoção revisada e escrita contínua de volta são etapas futuras separadas, sem liberar estes aplicadores. O que cada um fazia, para o contrato de integração:
    - `erp_catalog_import_sources`: lista paginada (cursor por `source_id`, busca em nome/código) dos registros de contatos ou produtos em `raw_record`.
      Para cada um, traz o plano de revisão (`import_review_plan`) sem as mudanças campo a campo; só administrador (`require_import_admin`).
    - `erp_catalog_import_preview`: para os `source_id` escolhidos, calcula o plano de importação (`import_review_plan`/`import_changes`, mapeamento `map_origin` do payload Bling para o cadastro).
      Cada item sai como novo, vínculo, atualização ou conflito, com as mudanças campo a campo e o hash da fonte; não grava nada.
    - `erp_catalog_import_apply`: aplica até 100 itens do plano revisado, conferindo o `preview_hash` da prévia (recibo `import_review_command`).
      Cria ou atualiza o cadastro, grava `erp_catalog.origin` (vínculo, `applied_hash`), `source_snapshot` e o espelho `origin_mirror`.
    - `erp_catalog_origin_categories_sync`: aplica as categorias de produto da fonte (`raw_record` 'product_categories') na taxonomia.
      Usa `origin_category_apply`/`parent`/`inactive` e registra o vínculo e os problemas (pai ausente, ciclo, nome) em `erp_catalog.taxonomy_source`.
    - `erp_catalog_origin_deletion_apply`: um produto por vez (versão esperada, ação `delete` ou `restore`): exclui logicamente o apagado na fonte ou restaura o que voltou (`origin_deletion_rows`).
      Registra em `product_source_deletion` (quem, quando, `human_edited` anterior); recibo em `erp_catalog.command`; só administrador de importação.
    - Ficam portadas, como leitura do espelho: `erp_catalog_origin_mirror_get`, `erp_catalog_origin_categories` e `erp_catalog_origin_deletions`.
- **Desvios deliberados do Fagoo:** só valores semeados, em `src/erp/schema/deviations.ts`, com motivo; nunca regra de negócio. O diferencial aplica os mesmos valores nos dois motores.
- **Blocos opcionais** (`erp-fiscal`, `erp-cobranca`, `erp-pdv`):
  - O portão é por rota, no Worker.
  - Guardas sobre dados de um bloco desligado continuam valendo; desligar não apaga dados.
  - Leitura de tabela de bloco desligado retorna o que houver, ou nada.
- Commits pequenos, push sem PR, nada de publicar nem implantar.
