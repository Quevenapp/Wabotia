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

## Proposta: manifesto assinado (Ed25519), não implementada

- O índice v2 ganha `signature` (Ed25519 sobre o JSON canônico do índice,
  que já fixa o SHA-256 do manifesto, que fixa cada blob). O workerd tem
  `crypto.subtle.verify({name: "Ed25519"})`.
- A chave pública vai embutida na ponte (`src/release.ts`), numa lista para
  permitir troca: uma chave nova entra numa versão assinada pela antiga.
- A privada fica fora do repositório e da máquina de build; `release.mjs`
  assina com ela num passo manual.
- Ganho: um site oficial comprometido não consegue publicar código nas
  instalações. Custo: guarda da chave, e perder a chave trava as
  atualizações automáticas (só reinstalação). Decisão do usuário; se for
  adotada, precisa estar na ponte, porque ela é a última versão que todos
  instalam sem assinatura.

## Roteiro do teste de ponta a ponta (sessão K)

Objetivo: 0.17.0 → ponte → versão fictícia de formato 2 com 300 estáticos e
cerca de 30 MB, numa instalação de teste, sem tocar no catálogo oficial.

O endereço do catálogo é fixo (`RELEASE_ORIGIN`). Para não publicar no site
oficial, use um **catálogo de teste**: um Worker só de estáticos
(`wabotia-catalogo-teste`) e builds da ponte e da fictícia com
`RELEASE_ORIGIN` trocado por esse endereço numa cópia local (sem commit).

1. **Catálogo de teste.** Numa cópia do `feat/pacote-v2`, troque
   `RELEASE_ORIGIN` pelo endereço do catálogo de teste e mude a versão do
   `package.json` só na cópia (por exemplo `0.20.90`).
2. **Ponte.** `npm run release -- --bridge` na cópia. Confira no log: pacote
   de formato 1 abaixo de 20 MB, `releases/latest.json` e
   `releases/v2/bridge.json` gravados.
3. **Fictícia.** Na mesma cópia, versão `0.20.91`, acrescente em `public/`
   300 arquivos (por exemplo `public/e2e/<n>.bin`, cerca de 100 KB cada, mais
   dois de 10 MB) para somar cerca de 30 MB, e rode `npm run release` sem
   `--bridge`. Confira: `releases/latest.json` continua na `0.20.90`;
   `releases/v2/latest.json` aponta para a `0.20.91` com
   `requires.min_version` `0.20.90`.
4. Publique a pasta `public/releases` da cópia no Worker de catálogo de teste.
5. **Instalação 0.17.0** de teste com um build da 0.17.0 cujo
   `RELEASE_ORIGIN` aponte para o catálogo de teste. Em Sistema e
   atualizações: deve aparecer só a `0.20.90`. Atualize; confira
   `/api/health` com o commit da ponte.
6. Na ponte, consulte de novo: deve aparecer a `0.20.91`. Atualize e anote o
   número de rodadas por etapa (o estado em `system:release-state`), o
   tempo total e se alguma rodada passou do limite de CPU ou memória.
   Confira `/api/health` e se os 300 arquivos respondem.
7. **Lote real de estáticos:** anote quantos `buckets` a Cloudflare devolveu
   e o tamanho de cada um (log do Coordinator ou estado); é a conferência
   que a documentação não responde.
8. **Falha entre `migrate` e `publish`:** repita os passos 5 e 6 numa
   instalação nova revogando a permissão Workers Scripts: Edit do token logo
   depois das migrações; espere `failed` em `publish`, devolva a permissão,
   libere a nova tentativa e confira que a migração não é reaplicada.
9. Apague o Worker de catálogo de teste e as instalações de teste ao fim
   (com o OK do usuário).

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
