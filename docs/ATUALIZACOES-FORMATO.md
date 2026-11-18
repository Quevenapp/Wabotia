# Formato do pacote de atualização (formato 2) e assinatura

O pacote antigo (formato 1) era um JSON único com tudo em base64, até 24 MiB,
relido e decodificado em toda etapa do atualizador, com no máximo 100
estáticos. O ERP (Fagoo) não cabe nele. O formato 2 troca o formato, os
limites e passa a exigir assinatura.

**Com ponte (desde 17/11/2026).** A 0.21.0 saiu ainda no formato 1 e a
instalação do usuário foi atualizada para ela pelo painel: o atualizador
dela só lê `releases/latest.json`. A **versão ponte 0.21.1** é a última com
pacote de formato 1 e já traz o leitor do formato 2; a seção
[Versão ponte](#versão-ponte-0211) explica o degrau, os tamanhos, a herança
do formato 1 e a saída de emergência. O leitor do formato 1 não volta ao
código (a ponte só escreve esse formato), nem o caminho antigo por
GitHub/Deploy Hook.

## Formato 2

```
/releases/latest.json              formato 1, congelado na ponte (0.21.1)
/releases/v2/bridge.json           {version, commit} da ponte
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
  automático) recusa começar abaixo dela. A ponte sai com `0.0.0`; toda versão
  depois dela exige a ponte (o padrão) ou o que `--min-version x.y.z` pedir,
  nunca menos que a ponte.
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
  índice v2 publicado e que a de `releases/latest.json` (a 0.21.0 antes da
  ponte; a própria ponte depois dela). Republicar a
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
local) e o instalador pelo navegador (antes de criar qualquer recurso). No
instalador pelo navegador, o andamento volta do navegador a cada passo: ele
leva os bytes exatos do índice e a assinatura, que o servidor confere de
novo em todo passo; o índice que o navegador mandar fora disso é ignorado.
Sem assinatura válida: "A assinatura da versão oficial não confere (…).
Nada foi alterado."

### Prazo do índice (`expires`)

- **Proposta adotada: 90 dias.** `release.mjs` grava `issued_at` = agora e
  `expires` = agora + 90 dias. O verificador aceita no máximo 180 dias entre
  os dois e recusa `issued_at` mais de um dia no futuro.
- **Sem versão nova em 90 dias:** `npm run release -- --renew` reassina o
  mesmo índice com prazo novo (mesma versão, mesmo manifesto) e o site é
  publicado de novo. Lembrete aos 60 dias, sem nada automático: qualquer
  execução do `release.mjs` avisa quando o índice publicado passou de 60
  dias ou venceu, e a tela **Sistema** do site oficial (instalação com
  `WABOTIA_WEB_INSTALLER=1`) mostra o mesmo aviso no cartão de atualização.
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
  - Índice e manifesto levam `test_origin` **assinado**. O build oficial
    recusa qualquer `test_origin`, seja qual for o valor (inclusive o
    endereço oficial) e esteja a assinatura como estiver; o de teste só
    aceita os da própria origem.
  - **Chave do ensaio, nunca a oficial.** O build de teste é assinado só
    pela chave de `WABOTIA_TEST_RELEASE_KEY`:
    - um `.pem` descartável, fora do repositório, gerado por
      `node scripts/release-keygen.mjs --id ensaio --out <arquivo>`;
    - o `release.mjs` nem procura a chave oficial nesse modo e recusa uma
      chave oficial como chave do ensaio.
  - A pública do ensaio entra só no build de teste, pela constante
    `__WABOTIA_TEST_RELEASE_KEYS__`, que vale só junto com a origem de teste.
    Ela **substitui** as oficiais: o build de teste não aceita versão
    oficial, e o oficial não aceita versão de teste. Duas travas
    independentes: a origem e a chave.
  - Testado em `tests/installer.test.mjs`, que compila o `src/release.ts`
    dos três jeitos (oficial, só a constante das chaves, teste).
  - Só no build de teste existe a rota `GET /api/test-catalog/releases/*`,
    que serve o catálogo do R2 da instalação (prefixo `test-catalog/`,
    enviado por `scripts/release-test-upload.mjs`); `/api/health` mostra
    `test_build: true` e `release_origin`.
  - Grava em `output/release-test/`; o instalador de teste fica em
    `output/release-test/install-wabotia.mjs`. Imprime "BUILD DE TESTE: não
    publicar".
  - **Recusa num pacote oficial:** sem `--test-origin`, `release.mjs` para
    se `WABOTIA_TEST_RELEASE_ORIGIN` ou `WABOTIA_TEST_RELEASE_KEY` estiver
    definida, ou se o `wrangler.jsonc` tiver `define` com uma das duas
    constantes. Também confere que o Worker e o instalador gerados contêm o
    endereço oficial.

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

## Versão ponte (0.21.1)

### O degrau

```
0.21.0 (lê releases/latest.json, formato 1)
   └─> 0.21.1 PONTE: pacote de formato 1 para a 0.21.0 ler; o código só lê
       o formato 2 assinado (releases/v2/latest.json + .sig)
          └─> 0.22.0 em diante: só formato 2, com requires.min_version 0.21.1
```

- `npm run release -- --bridge` grava o formato 2 **e** o pacote de formato
  1 (`releases/0.21.1/package.json` + `release.json`), aponta
  `releases/latest.json` para a ponte e registra `releases/v2/bridge.json`.
- Sem `--bridge`, o script nunca escreve `releases/latest.json` e recusa
  publicar antes de existir a ponte. Uma segunda ponte é recusada.
- O leitor da 0.21.0 exige `format: 1` no índice: um engano no catálogo não
  a leva a um pacote que ela não sabe ler.
- A ponte é **a 0.21.0 sem mudança de comportamento** mais o atualizador e
  os instaladores do formato 2: sem ERP novo e sem migração nova (as mesmas
  62, até a 0089). A etapa `migrate` do atualizador antigo não aplica nada,
  então não existe o caso "migrou e não publicou" neste salto.
- **É o último salto sem assinatura:** a 0.21.0 confere só o SHA-256 que vem
  no `releases/latest.json`, por HTTPS. A ponte traz as chaves públicas
  (`src/release-keys.json`); daí em diante, toda versão é assinada.

### Travas do leitor da 0.21.0

O `release.mjs` (`legacyProblems`) para antes de gravar se o pacote de
formato 1 sair destas travas do `src/release.ts` da 0.21.0:

- até 24 MiB (25.165.824 bytes);
- de 1 a 63 módulos e de 1 a 100 estáticos;
- até 100 migrações, cada uma com até 100 instruções de menos de 100 mil
  caracteres;
- nomes e tipos válidos;
- Durable Object `v1`/`Coordinator`, `run_worker_first` fixo e SPA.

O `scripts/erp/check-candidate.mjs <pasta da versão>` faz a prova de
verdade: compila o `src/release.ts` da 0.21.0 (`fca4bb2`) sem alteração e
passa o pacote por `validateIndex` e `parsePackage`. Confere também:

- o formato 2 pelo leitor atual (índice, manifesto, todos os blobs e
  migrações). Sem os `.sig`, num candidato, ele assina em memória com uma
  chave temporária, só para conferir o resto;
- que o pacote de formato 1 tem o mesmo código do manifesto.

### Completa ou enxuta (`--slim`)

Medido em `b72afc7` (candidato; a 0.21.0 publicada tinha 23.655.027 bytes):

| Variante | Pacote de formato 1 | Folga até 24 MiB |
|---|---|---|
| Completa (0.21.0 + atualizador novo) | **23.672.785 bytes** | 1.493.039 bytes |
| Enxuta (`--bridge --slim`: sem os 24 `/assets/erp-*`) | **16.320.406 bytes** | 8.845.418 bytes |
| Formato 2 da mesma versão (os dois casos) | 17.766.774 bytes em 125 blobs, manifesto 20 KB | — |

**A enxuta:**

- Só o pacote de formato 1 perde as telas do ERP do painel: 24 chunks
  carregados sob demanda, que o `index.html` não cita. O manifesto do
  formato 2 da mesma versão continua completo.
- Instalada pela 0.21.0, ela abre tudo, menos a tela do ERP (o pedido do
  chunk recebe a página da SPA). O ERP no servidor segue igual.
- Por isso a enxuta só sai **junto** com a versão seguinte de formato 2,
  que traz as telas de volta em minutos.
- Ela também cabe nos 20 MB das instalações até a 0.17.0.

**O que dá para tirar da completa sem tirar telas.** O Worker
(9.720.627 bytes, 12,96 MB em base64) é 55% do pacote:

- o motor do ERP, espalhado (cerca de 4,4 MB);
- `unpdf` (2,27 MB);
- `zod` e o SDK da Anthropic (0,87 MB);
- os módulos.

O único corte sem tela seria trocar por um vazio os decodificadores de
imagem do pdf.js:

- `pdfjs-openjpeg_nowasm_fallback.mjs`, 431 KB;
- `pdfjs-jbig2_nowasm_fallback.mjs`, 147 KB.

Isso economiza cerca de 0,77 MB no pacote (3%), mas muda comportamento da
leitura de PDF no Conhecimento. **Recusado:** a ponte é a 0.21.0 sem
mudança. Os estáticos fora do ERP somam 2,44 MB e são todos do painel. Não
há mapa de código nem PDF no pacote.

**Memória.** É o risco do salto 0.21.0 → ponte. O atualizador da 0.21.0
(que não muda mais) relê o pacote inteiro em toda rodada:

- `arrayBuffer`, SHA-256, `Buffer.from` + `toString`, `JSON.parse`;
- para cada arquivo, a decodificação do base64, a recodificação e o
  SHA-256.

Com 23,7 MB, isso dá cerca de 70 a 95 MB vivos acima da base, na rodada mais
pesada. A base é o isolate do `_admin` com o Worker de 9,7 MB e
possivelmente outros objetos `Coordinator`; o teto do isolate é 128 MB.

- A enxuta reduz o pico em cerca de 30%.
- O salto 0.20.0 → 0.21.0 já leu um pacote de 23,66 MB na instalação do
  usuário, mas com o código da 0.20.0, que é mais leve.
- O ensaio decide entre as duas.

### Herança do formato 1

Quando a ponte começa a rodar, encontra o que o atualizador da 0.21.0
guardou.

- **O trabalho em `system:release-state`.** `settleFormat1Job` fecha uma
  vez, na consulta, no início e em cada rodada:
  - o que publicou o código em execução fica concluído;
  - outro ainda ativo vira falho, sem nova tentativa automática;
  - o pacote antigo (`system/releases/<id>.json`, fora do prefixo do
    trabalho) sai do R2.
- **O índice do formato 1 em cache** (`system:release-latest`) não vale
  como cache nem aparece como versão disponível.

Testes em `tests/release-v2.test.ts`.

### Saída de emergência: trabalho preso em "atualizando"

**Quando:** a 0.21.0 estoura a memória ao ler o pacote da ponte.

- A rodada morre sem registrar erro: o estado fica `pending` na mesma
  etapa.
- A trava (`system_update_locks`) vence em 3 minutos, e o alarme do `_admin`
  tenta de novo: **para sempre, a cada ~3 min**.
- A 0.21.0 não oferece "Liberar nova tentativa" para um trabalho `pending`.
- O atendimento segue normal; só a atualização fica parada.

**O que o usuário vê antes:**

- em **Sistema e atualizações**, "Atualizando para 0.21.1" com a mesma
  etapa ("verificando instalação", "enviando arquivos", "preparando banco"
  ou "publicando") por mais de 15 minutos;
- nenhum botão de nova tentativa;
- `/api/health` ainda com `"version": "0.21.0"`.

Se houver acesso ao `wrangler tail` do Worker, as execuções do alarme
aparecem com `exceededMemory`.

**Saída:** publicar à mão, com o Wrangler, **exatamente o commit da ponte**.
A ponte, ao rodar, vê que o trabalho buscava o código em execução e o fecha
como concluído. Quem roda é o usuário, na instalação dele.

1. Na pasta do repositório, numa cópia limpa do commit da ponte (o
   `commit` de `releases/0.21.1/release.json`):
   `git worktree add <pasta> <commit>`, depois `npm ci` nessa pasta. Não
   use outra versão: o `buildInfo.commit` precisa ser igual ao do trabalho.
2. Confira a configuração da instalação (`wrangler.operational.local.json`):
   - o mesmo `name`, D1, R2 e `migrations` (`v1`/`Coordinator`);
   - as `compatibility_flags` da ponte, incluindo
     `global_fetch_strictly_public`.
3. Faça um marcador do Time Travel do D1 (nada é migrado, mas é o ponto de
   volta).
4. Na pasta da ponte:
   - `npm run build`;
   - `$env:CLOUDFLARE_ACCOUNT_ID="<conta>"; npx wrangler deploy --minify --keep-vars --config <caminho da configuração>`.

   O `--keep-vars` mantém `WABOTIA_INSTALLATION_ID`, `WABOTIA_ACCOUNT_ID` e
   `WABOTIA_WORKER_NAME`, que o instalador gravou e que o atualizador
   confere. Os segredos (`MASTER_KEY`, `WABOTIA_UPDATE_TOKEN`) não mudam com
   o deploy.

**Depois:**

- `/api/health` mostra a versão 0.21.1 e o commit da ponte;
- no painel, **Reabrir painel atualizado**: em **Sistema e atualizações**,
  a atualização aparece "concluída", instalada 0.21.1, e o alarme para de
  tentar;
- o pacote antigo sai do R2 na mesma consulta;
- a próxima versão (formato 2) segue pelo painel, normalmente.

### Ensaio da ponte (antes de publicar)

A staging dos aparelhos não serve, por três motivos:

- a 0.21.0 tem o `RELEASE_ORIGIN` fixo no código;
- a staging foi implantada pelo Wrangler, não pelo instalador;
- está em uso nos aparelhos.

O ensaio usa uma instalação descartável, que nasce como a do usuário. Os
recursos são criados e apagados com o OK do usuário, e o token Cloudflare
quem digita é ele.

1. **Catálogo de teste:** um Worker só de estáticos
   (`wabotia-catalogo-ensaio`) servindo a árvore `releases/` sob
   `/api/test-catalog/`.
2. **0.21.0 de teste:**
   - cópia local do `fca4bb2`, sem commit, com o `RELEASE_ORIGIN` de
     `src/release.ts` trocado por
     `https://wabotia-catalogo-ensaio.<subdomínio>.workers.dev/api/test-catalog`;
   - versão `0.21.80` e `WABOTIA_ALLOW_OVER_20MB=1 npm run release`
     (formato 1, sem chave) dessa cópia;
   - instalar com o `public/install-wabotia.mjs` dela
     (`--name wabotia-ensaio-ponte`);
   - ligar o ERP numa área e criar alguns dados.
3. **Ponte de teste:** neste branch, versão `0.21.81`, sem commit:
   - uma chave do ensaio, uma vez:
     `node scripts/release-keygen.mjs --id ensaio --out <pasta fora do repositório>\ensaio.pem`;
   - `WABOTIA_TEST_RELEASE_KEY=<esse arquivo> npm run release -- --bridge --test-origin https://wabotia-catalogo-ensaio.<subdomínio>.workers.dev`;
   - para a enxuta, guarde antes `output/release-test` com outro nome, pois
     cada variante usa a pasta inteira;
   - subir no catálogo de teste.
4. **0.21.80 → 0.21.81 pelo painel,** com `wrangler tail` aberto:
   - anotar a saída de cada alarme (`exceededMemory`), as rodadas por etapa
     e o tempo;
   - primeiro a completa e, se estourar ou passar perto, a enxuta.
5. **Se a completa estourar:** ensaiar a saída de emergência acima.
6. **Ponte → formato 2:** uma `0.21.82` grande (o roteiro abaixo, passos 3
   a 8), com uma migração.
   - Ela precisa de **commit próprio**: o atualizador decide pelo commit,
     não pela versão, e um build sem commit grava o mesmo commit da ponte e
     aparece como "nada disponível".
   - Faça um commit local num worktree descartável, em HEAD destacado, sem
     branch e sem push; ele fica órfão quando o worktree for apagado.
7. **Fim:** apagar os dois Workers, o D1 e o R2 do ensaio, e a cópia local.

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

## Correções posteriores à ponte 0.21.1

Estas correções valem para o atualizador da versão seguinte; a ponte já
publicada não muda. Todos os campos novos de `system:release-state` são
opcionais: o estado gravado pela ponte continua válido.

1. Antes de cada rodada, grava `round_started_at`, `round_progress` e
   `rounds_without_progress`. Mudança de etapa, arquivos baixados/enviados,
   migrações conferidas/aplicadas e sonda concluída zeram o contador e
   atualizam `last_progress_at`. Após três rodadas interrompidas sem avanço,
   a próxima entrada encerra o trabalho como `failed`, com orientação em
   português. O reset aceita `pending` sem avanço há **mais de 30 minutos**;
   sem os campos novos, usa `updated` (ou `created`).
2. A consulta de status conclui e limpa sob `updateLock`, relendo o trabalho
   e conferindo seu `id` antes de gravar. Com a trava ocupada, apenas lê.
   Mesmo se a concessão vencer durante uma limpeza lenta, A não regrava B.
3. Antes de ler os blobs e montar o base64, soma o lote: acima de
   `MAX_UPLOAD_BATCH_BYTES` (**48 MiB brutos**) falha com mensagem clara.
   O publicador recusa estáticos acima de **24 MiB por arquivo** antes de
   carregá-los, metade desse orçamento. Como a Cloudflare agrupa os lotes,
   o limite por arquivo não dispensa a conferência da soma no envio.
4. Falhas transitórias em `publish` antes de gravar `sending` entram na
   nova tentativa automática com o mesmo recuo e limite existentes. Após
   iniciar o PUT do código, permanece a conferência manual do resultado.
5. Um 401/403 em `assets` volta uma vez a `prepare`, que abre nova sessão
   pedindo só o que falta. `upload_session_renewals` limita a renovação a
   uma por trabalho, inclusive nas retomadas automáticas.
6. O cache só vale com `expires > now()`, e o início valida o índice com o
   horário atual. Um trabalho já iniciado continua depois do vencimento.
7. `CloudflareCallError.status` informa o HTTP mesmo com corpo não JSON;
   a mensagem inclui `Cloudflare HTTP <código>`. A decisão de repetir usa
   esse campo, sem interpretar o texto: 403 HTML não é repetível.

Não há mudança no formato dos pacotes, manifestos, índices ou assinaturas,
nas chaves, nos recursos Cloudflare ou nas migrações D1.

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
