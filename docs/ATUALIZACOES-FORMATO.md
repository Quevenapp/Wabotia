# Formato do pacote de atualização (formato 2) e assinatura

O pacote antigo (formato 1) era um JSON único com tudo em base64, até 24 MiB,
relido e decodificado em toda etapa do atualizador, com no máximo 100
estáticos. O ERP (Fagoo) não cabe nele. O formato 2 troca o formato, os
limites e passa a exigir assinatura.

**Sem ponte.** Nenhuma instalação baixou o formato 1 (decisão de 16/11/2026),
então não há versão de transição: o leitor do formato 1, o `--bridge`, o
degrau e o caminho antigo por GitHub/Deploy Hook saíram do código. O catálogo
publicado do formato 1 **não muda**: `releases/latest.json` fica parado na
0.20.0, com os 39 pacotes antigos, e nada no código o lê ou escreve.

## Formato 2

```
/releases/latest.json              formato 1, parado na 0.20.0 (intocado)
/releases/v2/latest.json           índice: {format:2, version, commit,
                                   manifest_sha256, manifest_size,
                                   total_size, requires, issued_at, expires}
/releases/v2/latest.sig            assinatura do índice
/releases/<versão>/manifest.json   metadados; modules/assets/migrations
                                   como {name, type, size, sha256}
/releases/<versão>/manifest.sig    assinatura do manifesto
/releases/<versão>/release-v2.json o índice daquela versão (e .sig), para
                                   instalar de uma pasta local
/releases/blobs/<sha256>           bytes crus, endereçados por conteúdo
```

- Sem base64. O mesmo conteúdo vira um blob só, compartilhado entre versões.
- Migração: o blob é um JSON com a lista de instruções SQL.
- `requires.min_version`: versão mínima instalada; o atualizador (manual e
  automático) recusa começar abaixo dela. Padrão `0.0.0`; muda com
  `npm run release -- --min-version x.y.z`. Mecanismo para o futuro: nenhuma
  versão o usa hoje.
- `requires.workers_paid`: liga a sonda do plano pago antes de migrar
  (`--workers-paid`).
- `issued_at` e `expires` (ms Unix): o prazo do índice, abaixo.

**Limites** (`src/release.ts`): manifesto 2 MiB; arquivo 25 MiB (teto de um
estático da Cloudflare, que serve os blobs); módulos do Worker somados
40 MiB; versão inteira 160 MiB; 256 módulos, 2.000 estáticos, 1.000
migrações; lote de envio de estáticos 2.000 hashes. Inalterados: Durable
Object só `v1` com `Coordinator`, `run_worker_first` fixo e as ligações
conferidas antes de publicar.

**Fora do pacote:** o catálogo (`releases/`) e o guia em PDF ficam só no
site oficial (`excludedAsset` em `scripts/release-plan.mjs`). O Worker sai
com `--minify`, só na linha de comando do dry-run, não no `wrangler.jsonc`.

**Instaladores.** O de terminal (`public/install-wabotia.mjs`) e o pelo
navegador (o Worker do site oficial) só leem o formato 2 e conferem as duas
assinaturas. Os dois saem do mesmo commit que grava o índice: o
`release.mjs` gera o instalador, e o deploy do site leva o catálogo e o
código do instalador pelo navegador juntos.

### Migrações

- **Todas as migrações da versão são conferidas antes de aplicar a
  primeira** (etapa `prepare`, até 20 por rodada): uma segunda migração
  malformada para o trabalho antes de tocar no banco.
- Cada arquivo é aplicado num `batch` do D1 com o registro em
  `d1_migrations` na mesma transação: ou o arquivo inteiro entra com o
  recibo, ou nada.
- Limite por arquivo: 100 instruções, cada uma com menos de 100 mil
  caracteres. Migração grande se divide em vários arquivos numerados; o
  atualizador aplica um por rodada.
- O esquema do ERP não passa pelo D1: fica no SQLite do objeto e é
  versionado em código. Os módulos que ainda usam o D1 seguem esta regra.

### Ordem das versões

- **Instalação:** o atualizador (manual e automático) só instala versão
  **maior** que a instalada. Igual com outro commit ou menor: recusa ("A
  atualização não volta de versão"). Um índice antigo ou adulterado não faz
  voltar código sobre um banco já migrado.
- **Publicação:** `release.mjs` recusa versão que não seja maior que a do
  índice v2 publicado e que a 0.20.0 (a última do formato 1). Republicar a
  mesma versão só com o mesmo manifesto (é o que `--renew` faz).

## Assinatura (Ed25519)

**O que é assinado.** Dois arquivos, cada um com seu `.sig`:

- o **índice** (`v2/latest.json`): fixa versão, commit, SHA-256 do
  manifesto e o prazo. A assinatura do índice é o que impede servir um
  índice antigo para sempre (congelamento) e voltar versão;
- o **manifesto** de cada versão: fixa o SHA-256 de cada arquivo. Assinar
  o manifesto também deixa conferir uma versão instalada de uma pasta local
  ou buscada pelo número, sem depender do índice do dia.

A assinatura cobre `domínio + bytes exatos do arquivo`, com domínios
diferentes (`"wabotia-release-index-v2\n"` e
`"wabotia-release-manifest-v2\n"`): a assinatura de um nunca vale como a do
outro. O `.sig` é `{"format":1,"algorithm":"Ed25519","key_id":"principal",
"signature":"<64 bytes em base64>"}`. Os blobs não são assinados um a um:
o SHA-256 de cada um está no manifesto assinado.

**Chaves embutidas** (`src/release-keys.json`): `principal` e `reserva`,
públicas, 32 bytes em base64url. Vale a assinatura de **qualquer uma** das
duas. Verificação com `crypto.subtle.verify({name: "Ed25519"}, …)`, igual no
workerd e no Node 22.

**Quem confere:** `checkUpdate` (botão e automático, antes de qualquer
etapa), a etapa `manifest` do atualizador (e de novo a cada rodada, ao reler
o manifesto guardado no R2), o instalador de terminal (pela rede e de pasta
local) e o instalador pelo navegador (antes de criar qualquer recurso).
Sem assinatura válida: "A assinatura da versão oficial não confere (…).
Nada foi alterado."

### Prazo do índice (`expires`)

- **Proposta adotada: 90 dias.** `release.mjs` grava `issued_at` = agora e
  `expires` = agora + 90 dias. O verificador aceita no máximo 180 dias entre
  os dois e recusa `issued_at` mais de um dia no futuro.
- **Sem versão nova em 90 dias:** `npm run release -- --renew` reassina o
  mesmo índice com prazo novo (mesma versão, mesmo manifesto) e o site é
  publicado de novo. Lembrete: renovar aos 60 dias.
- **Índice vencido numa instalação:** a consulta e a atualização são
  recusadas com "O índice da versão oficial venceu: o mantenedor precisa
  renová-lo. O atendimento continua normal; tente mais tarde." Nada mais
  para: o Worker instalado segue atendendo, o automático registra
  `check_failed` e tenta de novo na próxima janela. Os dois instaladores
  também recusam começar (o de pasta local não confere o prazo: a pasta é
  uma cópia guardada de uma versão já assinada).
- **Por que um prazo:** quem controlar o site (ou um cache) poderia servir
  para sempre um índice antigo e assinado, escondendo uma versão de
  correção. Com o prazo, isso dura no máximo 90 dias.

### Chaves privadas

- Geradas por `node scripts/release-keygen.mjs --id <principal|reserva>
  --out <arquivo .pem>`: o script recusa caminho dentro do repositório e
  arquivo existente, grava a chave PKCS8 com acesso só do usuário atual
  (no Windows, `icacls /inheritance:r /grant:r <usuário>:F`) e imprime só a
  chave pública.
- Ficam em `D:\Code\Env\wabotia\chaves-release\` (`principal.pem`,
  `reserva.pem`), fora do repositório, com acesso só do usuário do Windows.
  **Recomendação:** guardar também uma cópia da `reserva.pem` em mídia
  offline separada; as duas no mesmo disco caem juntas.
- **Nunca** viram segredo de CI, variável do Worker ou arquivo do
  repositório. `release.mjs` lê o caminho de `WABOTIA_RELEASE_KEY` ou de
  `release-signing.local.json` (`{"key": "<caminho>"}`, no `.gitignore`),
  recusa caminho dentro do repositório, confere que a pública derivada está
  em `src/release-keys.json`, confere cada assinatura antes de gravar e não
  imprime, registra nem copia a chave. O `.gitignore` também ignora `*.pem`
  e `*.key`; o pacote só leva `output/release-worker` e `dist`.
- A principal assina toda publicação; a reserva só numa emergência.

### Troca, perda e comprometimento

- **Troca planejada:** uma versão assinada por uma chave ainda válida traz
  o `src/release-keys.json` novo. Quem instala essa versão passa a aceitar
  só a lista nova. Gere a chave nova com `release-keygen.mjs`, troque a
  pública no JSON, publique (assinada pela chave atual) e só então passe a
  assinar com a nova.
- **Perda da principal:** a próxima versão sai assinada pela reserva (aponte
  `WABOTIA_RELEASE_KEY` para `reserva.pem`) e traz uma principal nova na
  lista. Nenhuma instalação trava.
- **Perda das duas:** nenhuma instalação aceita versão nova. Saída:
  reinstalar pelo instalador (que traz a lista nova embutida) com
  exportação e importação dos dados. Por isso a reserva deve ficar também
  fora do disco da principal.
- **Comprometimento de uma chave:** publique o quanto antes, assinada pela
  outra, uma versão cuja lista não tem a chave comprometida. **Limite:**
  até instalar essa versão, uma instalação ainda aceita um pacote assinado
  pela chave comprometida, desde que servido pelo site oficial (o atacante
  precisa também do site). Não há lista de revogação; se for preciso fechar
  essa janela, o próximo passo é `releases/v2/revocations.json` assinado e
  guardado pela instalação.

### Candidato e build de teste

- **`--candidate`**: grava em `output/release-candidate/` **sem
  assinatura**, com `"candidate": true` no índice; as instalações recusam
  ("versão sem assinatura"). Serve para medir e conferir, nunca para
  publicar. Mesmo com a chave configurada, o candidato não assina.
- **`--test-origin <url>`** (só para o ensaio): build de teste em que o
  `RELEASE_ORIGIN` aponta para `<url>/api/test-catalog`, a própria
  instalação de teste.
  - Constante de build `__WABOTIA_TEST_RELEASE_ORIGIN__`, declarada em
    `src/release.ts` e definida só no build de teste (um wrangler
    temporário, `wrangler.release-test.local.json`, no dry-run, e o
    `define` do esbuild no instalador); sem ela vale o endereço oficial.
  - Índice e manifesto levam `test_origin` **assinado**: o build oficial
    recusa qualquer pacote de teste, e o de teste só aceita os da própria
    origem.
  - Só no build de teste existe a rota `GET /api/test-catalog/releases/*`,
    que serve o catálogo do R2 da instalação (prefixo `test-catalog/`,
    enviado por `scripts/release-test-upload.mjs`); `/api/health` mostra
    `test_build: true` e `release_origin`.
  - Grava em `output/release-test/`; o instalador de teste fica em
    `output/release-test/install-wabotia.mjs`. Imprime "BUILD DE TESTE: não
    publicar".
  - **Recusa num pacote oficial:** sem `--test-origin`, `release.mjs` para
    se `WABOTIA_TEST_RELEASE_ORIGIN` estiver definida ou se o
    `wrangler.jsonc` tiver `define` com a constante, e confere que o Worker
    e o instalador gerados contêm o endereço oficial.

## Etapas do atualizador (`src/updates.ts`)

Cada chamada do alarme do `_admin` faz uma rodada curta e grava o andamento.
Nenhuma rodada lê o pacote inteiro: o manifesto e só os arquivos daquela
rodada.

| Etapa | O que faz |
|---|---|
| `manifest` | Baixa o manifesto e o `.sig`, confere assinatura, SHA-256 e estrutura, guarda os dois em `system/releases/<id>/` |
| `blobs` | Baixa até 20 arquivos ou 16 MiB por rodada (ao menos um), confere tamanho e SHA-256, guarda em `system/releases/<id>/b/<sha>`; retomada pula o que já está guardado |
| `prepare` | Confere todas as migrações (20 por rodada); depois a instalação (Durable Object, ligações) e abre a sessão de envio de estáticos |
| `assets` | Envia um lote inteiro da Cloudflare por rodada (em base64), como a documentação pede; só o último traz o token de conclusão |
| `migrate` | Sonda do plano pago (uma vez, se `workers_paid`), depois uma migração por rodada, cada uma num `batch` com o registro em `d1_migrations` |
| `publish` | Publica o Worker com os módulos guardados (lidos e conferidos de novo) |

**Limpeza do R2.**
- Ao concluir, o trabalho é gravado como `completed` **antes** de apagar o
  prefixo `system/releases/<id>/`; se o R2 falhar, `cleanup_pending` fica
  marcado e a limpeza se repete na próxima consulta.
- Ao cancelar, o prefixo é apagado.
- Ao começar um trabalho novo, tudo o que sobrou em `system/releases/`
  (trabalho anterior falho, cancelado ou com limpeza interrompida) é
  apagado.

Nova tentativa automática recomeça na etapa que falhou (em `assets`, volta a
`prepare`: a sessão da Cloudflare vale uma hora e só pede o que faltou).

## Sonda do plano pago

`paidPlanProbe`: 60 `SELECT 1` no D1 numa invocação, numa rodada própria
antes da primeira migração. Pela página de limites do D1 (16/11/2026),
"Queries per Worker invocation: 1000 (Workers Paid) / 50 (Free)": no
gratuito, a 51ª falha e o atualizador para com `workers_paid_required` sem
tocar no banco.

**O que não deu para provar:** o teste simula o gratuito (um D1 que falha na
51ª consulta); não houve conta gratuita real. A página geral de limites dos
Workers, na mesma data, diz "Subrequests to internal services: Free is
1,000". Se o D1 passar a contar por essa regra, a sonda **passa** no gratuito
e deixa de proteger. Antes de publicar uma versão com `--workers-paid`,
conferir numa conta gratuita real; se passar, acrescentar a confirmação do
administrador ("esta instalação está no plano pago") ao iniciar a
atualização.

## Conferências na documentação da Cloudflare (16/11/2026)

- **Worker:** 64 MiB sem compressão, nos dois planos; "There is no
  compressed size limit. Only the uncompressed bundle size counts."
- **Estáticos:** 20.000 arquivos por versão no gratuito, 100.000 no pago;
  25 MiB por arquivo; 128 MB de memória por isolate.
- **Envio direto de estáticos:** a página não dá limite numérico de
  arquivos ou bytes por envio nem por lote ("Limits differ based on account
  plan"); cada lote de `buckets` deve ir junto num envio; o token da sessão
  e o de conclusão valem uma hora; o de conclusão vem quando todos os
  arquivos chegaram. Por isso o atualizador e o instalador pelo navegador
  mandam um lote por envio. O tamanho real de um lote só se confirma com o
  envio real (roteiro abaixo): um lote grande demais para a memória do
  Worker apareceria ali.

## Tamanhos medidos (0.20.0, `4ea7864`)

| Pacote | Worker | Tamanho |
|---|---|---|
| Formato 1, como era | 8,91 MB | ≈18,28 MB (publicado: 18,3 MB) |
| Formato 2 com `--minify` e sem os PDFs do guia | 4,65 MB | 6,65 MB em 63 arquivos únicos, manifesto 10 KB |

- **`@anthropic-ai/sdk` por `fetch` direto (avaliado, recusado):** no
  Worker minificado, o SDK ocupa 0,39 MB e o `zod` (usado só pela saída
  estruturada do mesmo arquivo), 0,48 MB: 0,87 MB de 4,65 MB. O ganho não
  importa diante do teto do Worker (64 MiB) e do formato 2 (160 MiB). O
  risco sim: comportamento idêntico exigiria refazer à mão o esquema que o
  `zodOutputFormat` gera para a saída estruturada, a política de novas
  tentativas e prazo do cliente (408/409/429/5xx e erro de conexão), os
  cabeçalhos de versão da API e o mapeamento de erros tipados, num provedor
  ainda não testado contra a API real; a orientação da Anthropic para
  projetos TypeScript é usar o SDK, e as ferramentas que a sessão P vai
  acrescentar se apoiam nos tipos dele. O maior item do Worker é o `unpdf`
  (2,27 MB, leitura de PDF no Conhecimento).

## Testes

- `tests/release-v2.test.ts`: índice e prazo, manifesto e limites,
  assinatura (principal, reserva, chave desconhecida, chave errada com nome
  confiável, sem assinatura, arquivo inválido, troca de papel índice ↔
  manifesto, índice vencido); no atualizador: manifesto alterado em um
  byte, blob trocado e blob corrompido, segunda migração malformada, queda
  no meio de `assets`, limpeza (`completed` antes, `cleanup_pending`,
  restos antigos), ordem das versões, lote de 250 hashes, blobs de 20 MB,
  falha entre `migrate` e `publish`, sonda do plano pago; regras de
  publicação (`checkVersionOrder`, `excludedAsset`, `insideRepository`).
- `tests/web-install.test.ts`: os mesmos casos no instalador pelo
  navegador (sem assinatura, chave desconhecida, vencido, reserva, manifesto
  alterado, blob trocado/corrompido, um lote por envio).
- `tests/installer.test.mjs`: os mesmos casos no instalador de terminal
  (pasta local e rede), com as assinaturas geradas por
  `scripts/release-sign.mjs`, o mesmo código do `release.mjs`.
- `tests/automatic-updates.test.ts`: o automático com índice assinado,
  `min_version` e sem voltar versão.

## Roteiro do ensaio de ponta a ponta (sessão K)

Objetivo: instalação do zero com um pacote de formato 2 assinado, depois
atualização formato 2 → formato 2 pelo painel, em
`wabotia-staging-verticais`, sem tocar no catálogo oficial.

**Pré-condições:** revisão da sessão A concluída; os aparelhos de teste não
estão usando a staging; OK do usuário para reinstalar a staging do zero (a
instalação atual tem dados de teste e aparelhos pareados). Sem esse OK, use
outro nome na mesma conta (por exemplo `wabotia-staging-pacote`) e troque o
nome nos passos.

1. **Versão A (build de teste):** na cópia de trabalho, sem commit, mude a
   versão do `package.json` para `0.21.90` e rode
   `npm run release -- --test-origin https://wabotia-staging-verticais.<subdomínio>.workers.dev`
   com a chave configurada. Confira a mensagem "BUILD DE TESTE" e
   `output/release-test/v2/latest.json` com `test_origin`.
2. **Instalação do zero:**
   `node output/release-test/install-wabotia.mjs --name wabotia-staging-verticais --release-dir output/release-test/0.21.90`.
   O instalador confere `release-v2.sig` e `manifest.sig`. Confira
   `/api/health`: `version` 0.21.90, `test_build: true` e `release_origin`.
3. **Versão B:** versão `0.21.91`, com 300 arquivos em `public/e2e/` (cerca
   de 100 KB cada, mais dois de 10 MB, perto de 30 MB no total); rode o
   mesmo `release --test-origin`. Confira que `v2/latest.json` aponta para a
   0.21.91.
4. **Catálogo de teste no R2:**
   `node scripts/release-test-upload.mjs --config <pasta da instalação>/wrangler.jsonc`.
   Confira `GET <url>/api/test-catalog/releases/v2/latest.json`.
5. **A → B pelo painel:** Sistema e atualizações → Verificar atualização →
   Atualizar. Anote:
   - as rodadas por etapa (`system:release-state`) e o tempo total;
   - quantos `buckets` a Cloudflare devolveu e o tamanho de cada um;
   - qualquer estouro de CPU ou memória.
   Confira `/api/health` (0.21.91) e os 300 arquivos.
6. **Assinatura na prática:** suba por cima, no R2, um `v2/latest.sig` de
   outra versão; Verificar atualização deve recusar com "conteúdo alterado".
   Devolva o original.
7. **Falha entre `migrate` e `publish`:** numa versão C com uma migração,
   revogue a permissão Workers Scripts: Edit do token logo depois das
   migrações; espere `failed` em `publish`, devolva a permissão, libere a
   nova tentativa e confira que a migração não é reaplicada.
8. **Automático:** repita 5 numa versão D com a atualização automática
   ligada e uma janela que inclua a hora do ensaio.
9. **Plano pago:** se o usuário tiver uma conta gratuita, rode a sonda numa
   instalação de teste nela (versão marcada com `--workers-paid`) e anote se
   ela recusa. Até lá, a sonda fica **não comprovada**.
10. **Ao fim:** volte a versão do `package.json`, apague
    `output/release-test/` e o prefixo `test-catalog/` do R2. A staging fica
    com um build de teste, que só lê o catálogo de teste: volte ao build
    oficial reinstalando, com o OK do usuário.

## Para a revisão da sessão A (núcleo)

- `src/release.ts`: só formato 2 (`validateIndexV2` com prazo,
  `parseIndex`, `parseManifest` com assinatura e as mesmas travas de Durable
  Object, rotas e ligações), `verifySignature` com domínios separados,
  chaves de `src/release-keys.json`, `RELEASE_ORIGIN` com a constante de
  teste e `test_origin`.
- `src/updates.ts`: `checkUpdate` lê e confere o índice assinado;
  `startDirectUpdate` recusa voltar versão, confere `min_version` e limpa
  restos em `system/releases/`; o automático faz o mesmo; `processPhase`
  guarda e reconfere `manifest.sig`, confere todas as migrações em
  `prepare`, manda um lote inteiro por rodada; `updateStatus` grava
  `completed` antes da limpeza (`cleanup_pending`).
- `src/web-install.ts`: confere `v2/latest.sig` antes de criar recursos e
  `manifest.sig` a cada passo; um lote por envio.
- `scripts/release.mjs`, `release-sign.mjs`, `release-plan.mjs`,
  `release-keygen.mjs`, `release-test-upload.mjs`.
- `src/index.ts`: rota `/api/test-catalog/releases/*` só no build de teste.
