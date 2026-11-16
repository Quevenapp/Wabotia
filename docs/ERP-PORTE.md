# Porte do ERP (Fagoo) por domínio — regras para quem porta

Base: `feat/erp-motor`. Provas e números: `docs/ERP-FASE0.md`. Mapa de fechos:
`docs/erp-closure-map.json`. Dono de cada RPC e das funções compartilhadas:
`src/erp/domains/ownership.generated.json`.

## Quem é dono de quê

| Pasta | Domínio | Sessão |
|---|---|---|
| `src/erp/engine/`, `src/erp/schema/`, `scripts/erp/gen-*.mjs`, `tests/erp/harness/` | motor e base (**congelados**) | N |
| `access/`, `preferences/public.ts` (`get`), `sync/` (contrato de integração) | núcleo transversal | N |
| `reference/`, `company/`, `access/` | Referências, Empresa, Acesso | N |
| `catalog/` | Catálogo, contatos, preços (`erp_catalog`, `erp_pricing`) | P (`feat/erp-catalogo`) |
| `stock/`, `finance/`, `documents/`, `fiscal/`, `cnab/`, `pos/`, `preferences/` | o resto, na ordem do relatório | a alocar |

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
   - Tipos de argumento primeiro (uuid 22P02, date 22007/22008), como o Postgres.
   - Gatilhos viram funções da camada de tabela, chamadas por quem escreve (`stock/internal.ts`, `catalog/internal.ts`). Os que só lançam erro já estão em SQL gerado.
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
6. **Fechamento:** um domínio só fecha com o diferencial verde e os tetos baixados. Aviso curto à orquestração com as linhas de TS, os RPCs portados e os testes.

## Regras que valem para todos

- **Dialeto:** as dez regras de `docs/ERP-FASE0.md`.
  - i64 lido por `CAST(… AS TEXT)`.
  - BigInt nunca como parâmetro.
  - Nada de FK adiada.
  - Máximo de 100 parâmetros.
  - `LIKE` do usuário vira `instr()`.
  - `lower`/`NOCASE` só valem para ASCII: compare em TS ou use a coluna `__fold`.
  - A ordem das chaves do jsonb vem de `jsonbKeys`; o texto canônico, de `jsonbText`.
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
- **Desvios deliberados do Fagoo:** só valores semeados, em `src/erp/schema/deviations.ts`, com motivo; nunca regra de negócio. O diferencial aplica os mesmos valores nos dois motores.
- **Blocos opcionais** (`erp-fiscal`, `erp-cobranca`, `erp-pdv`):
  - O portão é por rota, no Worker.
  - Guardas sobre dados de um bloco desligado continuam valendo; desligar não apaga dados.
  - Leitura de tabela de bloco desligado retorna o que houver, ou nada.
- Commits pequenos, push sem PR, nada de publicar nem implantar.
