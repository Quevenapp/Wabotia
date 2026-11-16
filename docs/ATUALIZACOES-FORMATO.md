# Formato do pacote de atualização e a versão ponte

O pacote antigo (formato 1) era um JSON único com tudo em base64, até 24 MiB,
relido e decodificado em toda etapa do atualizador, com no máximo 100
estáticos. O ERP (Fagoo) não cabe nele. A **versão ponte** troca o formato e
os limites; as instalações antigas chegam ao formato novo passando por ela.

## Formato 2

```
/releases/latest.json              congelado na ponte (último formato 1)
/releases/v2/latest.json           índice: {format:2, version, commit,
                                   manifest_sha256, manifest_size,
                                   total_size, requires}
/releases/v2/bridge.json           {version, commit} da ponte
/releases/<versão>/manifest.json   metadados; modules/assets/migrations
                                   como {name, type, size, sha256}
/releases/<versão>/release-v2.json o índice daquela versão
/releases/blobs/<sha256>           bytes crus, endereçados por conteúdo
```

- Sem base64. O mesmo conteúdo vira um blob só, compartilhado entre versões.
- Migração: o blob é um JSON com a lista de instruções SQL.
- `requires.min_version`: versão mínima instalada (a ponte, nas versões
  seguintes); o atualizador recusa começar abaixo dela.
- `requires.workers_paid`: liga a sonda do plano pago antes de migrar.

**Limites** (`src/release.ts`): manifesto 2 MiB; arquivo 25 MiB (teto de um
estático da Cloudflare, que serve os blobs); módulos do Worker somados
40 MiB; versão inteira 160 MiB; 256 módulos, 2.000 estáticos, 1.000
migrações; lote de envio de estáticos 2.000 hashes. Inalterados: Durable
Object só `v1` com `Coordinator`, `run_worker_first` fixo e as ligações
conferidas antes de publicar.

## Degrau fixo

1. A ponte sai com `npm run release -- --bridge`: grava o formato 2 **e** o
   pacote de formato 1 (abaixo de 20 MB, o teto das instalações até a
   0.17.0), aponta `releases/latest.json` para ela e registra
   `releases/v2/bridge.json`.
2. A ponte só lê `releases/v2/latest.json`.
3. As versões seguintes saem sem `--bridge`: só formato 2; o script recusa
   publicar sem a ponte registrada e nunca mais muda `releases/latest.json`.
4. Uma instalação antiga lê `latest.json`, vê a ponte, atualiza, e só então
   enxerga o índice v2. O leitor do formato 1 recusa um índice de formato 2
   (`validateIndex` exige `format: 1`), então mesmo um engano no catálogo
   não a leva a um pacote que ela não sabe instalar.

### Atualização automática não pula a ponte

- **Antes da ponte (0.17.x a 0.20.x):** o automático instala "versão maior
  que a atual" a partir de `releases/latest.json`, que fica congelado na
  ponte. Quem estiver várias versões atrás cai na ponte; o índice v2 não
  existe para essas versões.
- **Na ponte em diante:** o automático lê `releases/v2/latest.json` e só põe
  na fila uma versão cujo `requires.min_version` a instalação atende. Se não
  atende, para em `release_requires_review` com a mensagem "exige a X
  instalada antes" e não cria trabalho. O início manual recusa do mesmo
  jeito.
- Testes: `tests/release-v2.test.ts` (o leitor antigo só enxerga a ponte) e
  `tests/automatic-updates.test.ts` (na ponte, o automático respeita
  `min_version`).

### Instaladores no mesmo dia

O instalador de terminal (`public/install-wabotia.mjs`) e o pelo navegador
(o Worker do site oficial) já leem o formato 2 na ponte. Os dois saem do
mesmo commit que grava o `releases/v2/latest.json`: `release.mjs` gera o
instalador, e o deploy do site oficial leva o catálogo **e** o código do
instalador pelo navegador juntos. Regra de publicação: nunca subir o
catálogo da ponte sem o código da ponte no site (nem o contrário); um site
antigo com o catálogo novo instalaria a ponte pelo formato 1 (funciona, mas
fica uma versão atrás depois da primeira de formato 2), e um site novo com o
catálogo antigo não acharia o índice v2.

### Migrações

- Cada arquivo é aplicado num `batch` do D1 com o registro em
  `d1_migrations` na mesma transação: ou o arquivo inteiro entra com o
  recibo, ou nada.
- Limite por arquivo: 100 instruções, cada uma com menos de 100 mil
  caracteres (o mesmo do formato 1). Migração grande se divide em vários
  arquivos numerados; o atualizador aplica um por rodada.
- O esquema do ERP não passa pelo D1: fica no SQLite do objeto e é
  versionado em código. Os módulos que ainda usam o D1 seguem esta regra.

## Etapas do atualizador (`src/updates.ts`)

Cada chamada do alarme do `_admin` faz uma rodada curta e grava o andamento.
Nenhuma rodada lê o pacote inteiro: o manifesto e só os arquivos daquela
rodada.

| Etapa | O que faz |
|---|---|
| `manifest` | Baixa o manifesto, confere SHA-256 e estrutura, guarda em `system/releases/<id>/manifest.json` |
| `blobs` | Baixa até 20 arquivos ou 16 MiB por rodada (ao menos um), confere tamanho e SHA-256, guarda em `system/releases/<id>/b/<sha>`; retomada pula o que já está guardado |
| `prepare` | Confere a instalação (Durable Object, ligações) e abre a sessão de envio de estáticos |
| `assets` | Envia uma parte de até 16 MiB de um lote da Cloudflare por rodada (em base64); só o último envio traz o token de conclusão |
| `migrate` | Sonda do plano pago (uma vez, se `workers_paid`), depois uma migração por rodada, cada uma num `batch` com o registro em `d1_migrations` |
| `publish` | Publica o Worker com os módulos guardados (lidos e conferidos de novo) |

Os temporários são apagados pelo prefixo `system/releases/<id>/` ao concluir
ou cancelar. Nova tentativa automática recomeça na etapa que falhou (em
`assets`, volta a `prepare`: a sessão da Cloudflare vale uma hora e só pede o
que faltou).

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
  plan"); cada lote de `buckets` deve ir junto; o token da sessão e o de
  conclusão valem uma hora; o de conclusão vem quando todos os arquivos
  chegaram. Por isso o atualizador aceita lotes de até 2.000 hashes e os
  envia em partes de até 16 MiB. O tamanho real de um lote só se confirma
  com o envio real (roteiro abaixo).

## Tamanhos medidos (0.20.0, `4ea7864`)

| Pacote | Worker | Formato 1 (JSON base64) |
|---|---|---|
| Como era | 8,91 MB | ≈18,28 MB (publicado: 18,3 MB) |
| Com `--minify` | 4,65 MB | ≈12,59 MB |
| Com `--minify` e sem os PDFs do guia (2,84 MB) | 4,65 MB | **8,85 MB** (candidato da ponte) |
| Formato 2 do mesmo código | 4,65 MB | 6,65 MB em 63 arquivos únicos, manifesto 10 KB |

- `--minify` vai só na linha de comando do dry-run (`scripts/release.mjs`),
  não no `wrangler.jsonc`.
- Os PDFs do guia ficam só no site oficial; as páginas `/` e `/install`
  apontam para `https://wabotia.queven.app/guide/…`.
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

## Assinatura do índice (Ed25519): desenho pronto, não implementado

Decisão pendente do usuário (envolve guardar chaves). O desenho entra na
ponte sem retrabalho, porque a ponte é a última versão que todos instalam
sem conferir assinatura.

**O que é assinado.** O índice v2 ganha `signatures: [{key, sig}]`. A
assinatura cobre os bytes `"wabotia-release-v2\n" + JSON` do índice sem o
campo `signatures`, com as chaves em ordem alfabética (o mesmo `canonical`
de `src/security.ts`). O índice fixa o SHA-256 do manifesto, que fixa o de
cada arquivo: assinar o índice basta.

**Chaves embutidas (`src/release.ts`).**

```ts
export const RELEASE_KEYS = [
  { id: "principal-2026", ed25519: "<32 bytes em base64>" },
  { id: "reserva-2026", ed25519: "<32 bytes em base64>" },
];
```

- Vale o índice com **ao menos uma** assinatura válida de uma chave da
  lista que não esteja revogada nesta instalação. Verificação com
  `crypto.subtle.verify({name: "Ed25519"}, …)` (workerd e Node 22).
- Conferem: `checkUpdate` e o automático (antes de qualquer etapa), o
  instalador de terminal e o pelo navegador. Índice sem assinatura válida:
  "A versão oficial não tem assinatura válida. Nada foi alterado."
- A principal assina toda publicação; a reserva fica guardada em outro lugar
  (cofre separado, offline) e só assina numa emergência.
- **Troca planejada:** uma versão assinada pela principal traz a lista nova
  (por exemplo, principal-2027 e a mesma reserva). Quem instala essa versão
  passa a aceitar só a lista nova.

**Chave perdida.**
- Só a principal: a próxima versão sai assinada pela reserva e traz uma
  principal nova. Nenhuma instalação trava.
- As duas: nenhuma instalação aceita versão nova. Saída: reinstalação pelo
  instalador (que tem a lista nova embutida), com exportação e importação
  dos dados. Por isso as duas nunca ficam no mesmo lugar.

**Chave comprometida.**
- Publica-se, assinado pela outra chave, `releases/v2/revocations.json`
  (`{revoked: ["principal-2026"], at}`), e uma versão nova sem a chave
  comprometida, assinada pela que sobrou.
- O atualizador lê as revogações a cada consulta, aceita só a lista
  assinada por uma chave válida e guarda o resultado num segredo da
  instalação: uma revogação vista não se desfaz, mesmo que o site volte a
  servir a lista antiga.
- **Limite:** uma instalação que ainda não leu a revogação aceita uma versão
  assinada pela chave comprometida servida por quem controla o site. A
  janela fecha na primeira consulta depois da revogação. Exigir as duas
  assinaturas fecharia a janela, mas a perda de qualquer chave travaria
  todas as instalações; o desenho prefere uma de duas.

**Como o `release.mjs` assina.**
- `--sign <arquivo>`: caminho de uma chave privada PKCS8 (PEM) **fora** do
  repositório; o script recusa um caminho dentro da pasta do projeto ou
  versionado pelo Git, e recusa publicar (sem `--candidate`) sem assinatura.
- Lê a chave com `createPrivateKey`, assina com `crypto.sign(null, bytes,
  chave)`, confere a assinatura contra a pública correspondente de
  `RELEASE_KEYS` (chave errada ou fora da lista: para) e só então grava o
  índice. A chave nunca é impressa, registrada em log nem copiada; o
  processo não a passa a subprocessos (`wrangler` roda antes da assinatura).
- Geração das chaves: `node -e` com `generateKeyPairSync("ed25519")`,
  numa máquina sem rede, gravando a privada direto num pendrive cifrado; a
  pública (32 bytes em base64) vai para `RELEASE_KEYS` num commit.
- `--candidate` sai sem assinatura; os testes usam um par gerado na hora.

## Roteiro do teste de ponta a ponta (sessão K)

Objetivo: versão antiga → ponte → versão fictícia de formato 2 com 300
estáticos e cerca de 30 MB, numa instalação de teste, sem tocar no catálogo
oficial.

### Catálogo de teste: a própria instalação de teste

A instalação de distribuição é um Wabotia comum que serve `/releases` dos
próprios estáticos. No ensaio, a instalação de teste serve o próprio
catálogo, e um build **só de teste** aponta o `RELEASE_ORIGIN` para ela.
Proposta (não implementada; entra antes do ensaio, com a revisão da A):

- **Constante de build** `__WABOTIA_TEST_RELEASE_ORIGIN__`, declarada em
  `src/release.ts`:

  ```ts
  declare const __WABOTIA_TEST_RELEASE_ORIGIN__: string | undefined;
  export const RELEASE_ORIGIN =
    typeof __WABOTIA_TEST_RELEASE_ORIGIN__ === "string"
      ? __WABOTIA_TEST_RELEASE_ORIGIN__
      : "https://wabotia.queven.app";
  ```

  Ela só existe quando o build de teste a define
  (`wrangler deploy --define __WABOTIA_TEST_RELEASE_ORIGIN__:'"https://<teste>.workers.dev"'`).
  No build de produção ela não existe e o `typeof` cai no endereço oficial.
- **`release.mjs` recusa num pacote oficial:** para se o `wrangler.jsonc`
  tiver `define` com essa constante, se a variável de ambiente
  `WABOTIA_TEST_RELEASE_ORIGIN` estiver definida, ou se o Worker gerado não
  contiver o literal `https://wabotia.queven.app` (sinal de que a constante
  foi substituída). O build de teste usa um script próprio
  (`scripts/release-test.mjs`), que grava em `output/release-test/` e
  imprime "BUILD DE TESTE: não publicar".
- `/api/health` do build de teste traz `release_origin` diferente do
  oficial, para conferir antes de começar.

### Passos

1. **Instalação de teste** com o build de teste da ponte (versão local
   `0.20.90`, `RELEASE_ORIGIN` = ela mesma). Para partir da 0.17.0, é
   preciso uma segunda instalação de teste com a 0.17.0 apontada para o
   catálogo de teste (uma linha trocada numa cópia, sem commit): depende do
   OK do usuário.
2. **Catálogo da ponte:** `node scripts/release-test.mjs --bridge` no build
   de teste; confira pacote de formato 1 abaixo de 20 MB,
   `releases/latest.json` e `releases/v2/bridge.json`. Publique a pasta
   `releases` nos estáticos da instalação de teste.
3. **Fictícia:** versão local `0.20.91`, com 300 arquivos em
   `public/e2e/` (cerca de 100 KB cada, mais dois de 10 MB, total perto de
   30 MB); `release-test.mjs` sem `--bridge`. Confira:
   `releases/latest.json` continua na `0.20.90`; `releases/v2/latest.json`
   aponta para a `0.20.91` com `requires.min_version` `0.20.90`.
4. **Versão antiga → ponte** (se houver a segunda instalação): em Sistema e
   atualizações aparece só a `0.20.90`. Atualize; confira `/api/health`.
5. **Ponte → fictícia:** consulte de novo; aparece a `0.20.91`. Atualize e
   anote rodadas por etapa (`system:release-state`), tempo total e qualquer
   estouro de CPU ou memória. Confira `/api/health` e os 300 arquivos.
6. **Automático:** repita 4 e 5 com a atualização automática ligada e uma
   janela que inclua a hora do ensaio; o automático deve parar em cada
   degrau, nunca saltar da versão antiga para a `0.20.91`.
7. **Lote real de estáticos:** anote quantos `buckets` a Cloudflare devolveu
   e o tamanho de cada um.
8. **Falha entre `migrate` e `publish`:** revogue a permissão Workers
   Scripts: Edit do token logo depois das migrações; espere `failed` em
   `publish`, devolva a permissão, libere a nova tentativa e confira que a
   migração não é reaplicada.
9. **Plano pago:** se o usuário tiver uma conta gratuita, rode a sonda numa
   instalação de teste nela (marcando a fictícia com `--workers-paid`) e
   anote se ela recusa. Até lá, a sonda fica **não comprovada**.
10. Apague as instalações de teste ao fim, com o OK do usuário.

## Para a revisão da sessão A (núcleo)

- `src/release.ts`: formato 1 intacto (só o lote de envio sobe para 2.000);
  formato 2 novo: `validateIndexV2`, `parseManifest` (mesmas travas de
  Durable Object, rotas e ligações), `fetchManifest`, `fetchBlob`,
  `checkBlob`, `uniqueBlobs`, `nextRound`, `assetManifestV2`,
  `assetsForHashes`, `assetUploadV2`, `workerUploadV2`,
  `migrationStatements`, `versionAtLeast` e as constantes de limite.
- `src/updates.ts`: `checkUpdate` lê só `releases/v2/latest.json`;
  `startDirectUpdate` confere `requires.min_version` e começa em `manifest`;
  `automaticUpdateTick` para em `release_requires_review` quando a versão
  exige outra instalada antes;
  `processPhase` com as seis etapas; `paidPlanProbe`; `dropTemporary` apaga
  o prefixo `system/releases/<id>/` (e o `package_key` antigo, se houver);
  nova tentativa automática recomeça na etapa que falhou (`assets` volta a
  `prepare`); fases tentáveis: `manifest`, `blobs`, `prepare`, `assets`.