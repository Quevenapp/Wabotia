# Emissor fiscal do ERP (cliente do cofre NFapi)

A emissão de nota fiscal não fica no Wabotia. Cada emitente instala um
**cofre NFapi**: um Worker na conta Cloudflare dele, que guarda o certificado
A1, numera, monta e assina o XML e fala com a SEFAZ. O Wabotia é só cliente:
guarda o endereço do cofre e uma chave de API e chama a API.

O ERP fala só com `FiscalProvider` (`provider.ts`). A NFapi é a única
implementação (`nfapi-provider.ts`).

## Arquivos

| Arquivo | O quê |
|---|---|
| `contract/openapi.json` | Cópia versionada do contrato do cofre (OpenAPI 3.1). Hoje: **0.9.1**, de `Quevenapp/nfapi` `vault/docs/openapi.json` no canal estável (`cofre-estavel`), commit `5db281e`. |
| `contract/types.generated.ts` | Tipos gerados do contrato. Não edite. |
| `contract/generate.ts` | Gerador de tipos, lista de operações e comparação de contratos. Funções puras. |
| `contract/sync.mjs` | Copia um contrato novo e regera os tipos. |
| `nfapi.ts` | Cliente fino: uma função por operação, sem repetição. |
| `provider.ts` | `FiscalProvider`, `FiscalError`, registro e `fiscal_provider_not_configured`. |
| `nfapi-provider.ts` | Provedor NFapi: referência, repetição, idempotência e mapa de erros. |
| `config.ts` | Endereço e chave (segredo do núcleo), "Testar conexão" e alertas. |
| `routes.ts` | Rotas `/erp-emissor` para o painel. Ainda não montadas: veja "Montagem". |
| `index.ts` | O que o domínio Fiscal importa: `fiscalProviderFor(ctx)`. |

Testes: `tests/erp/emissor/` (vitest). Rode `npx vitest run tests/erp/emissor`.
O cofre simulado (`fake-vault.ts`) parte dos exemplos do contrato e confere
cada pedido e cada resposta contra os schemas do contrato.

## Atualizar o contrato

A NFapi avisa que os campos podem mudar depois do primeiro teste em
homologação.

1. Copie o contrato **do canal estável** (não do disco, que pode estar à
   frente) e regere os tipos:

   ```bash
   git -C D:\Code\NFapi show origin/cofre-estavel:vault/docs/openapi.json > openapi-estavel.json
   node src/erp/emissor/contract/sync.mjs openapi-estavel.json
   ```

   O comando lista as diferenças para a cópia anterior.
2. Rode `npx vitest run tests/erp/emissor/contract.test.ts`. Ele falha quando:
   - os tipos não foram regerados;
   - uma operação ou um código de resposta entrou ou saiu;
   - uma situação de emissão nova não tem tradução;
   - a tabela de códigos de erro (`x-codigos`) ganhou ou perdeu um código.
     O `ERROR_MAP` é tipado pela tabela gerada, então o `tsc` também acusa;
   - os campos de `Erro` ou de `Cofre` mudaram;
   - um exemplo de pedido não passa no próprio schema.
3. Ajuste o cliente e o provedor, e só então atualize `EXPECTED` no teste.

Em produção, o **Testar conexão** lê `GET /v1/openapi.json` do cofre instalado
e compara com a cópia versionada:
- versão de outra minor (antes da 1.0) gera o alerta `contract_incompatible`;
- diferença de forma na mesma minor gera o alerta `contract_changed`.

## Cofre antigo: versão mínima por operação

O cliente atende cofres desde a **0.3.2**. Cada operação mais nova tem a
versão mínima em `OPERATION_MIN_VERSION` (`nfapi.ts`), pelo histórico do
canal estável:

| Desde | Operações |
|---|---|
| 0.4.0 | NFC-e com `contingencia` diferente de `nunca` |
| 0.4.1 | XML dos eventos (cancelamento, carta de correção) e consulta de inutilizações; `POST /v1/inutilizacoes` repetido devolve 200 com `repetido` |
| 0.7.0 | Cupom da NFC-e (JSON) |
| 0.8.0 | DANFE, DANFE NFC-e e logotipo |
| 0.9.0 | NF-e recebidas, manifestação e distribuição |

Sem custo no caminho feliz: só quando uma dessas chamadas falha como falha
uma rota inexistente (404, 405, 400 ou resposta fora do contrato) o cliente
lê `GET /v1/cofre`. Versão abaixo da mínima vira `NfapiOutdatedError`, e o
provedor devolve `409 vault_outdated` com `min_version` e a versão
instalada na mensagem, nunca o 404 cru. Um 404 de id inexistente num cofre
em dia continua 404.

No painel, o "Testar conexão" trata o cofre mais antigo como compatível e
mostra o alerta `vault_feature_outdated` por recurso (`FEATURE_MIN_VERSION`
em `config.ts`): documentos impressos e contingência na 0.8.0, notas
recebidas na 0.9.0. Cofre de minor **mais nova** que a fixada continua
`contract_incompatible`, até o Wabotia acompanhar.

## Trava de evento fiscal em teste

Em processo de teste (vitest ou `node --test`, lido do ambiente do executor
em `TEST_PROCESS`, sem opção para desligar), **nenhum POST** sai para um
cofre que não seja o simulado: o host precisa terminar em `.test` ou
`.invalid` (reservados, RFC 6761). A recusa é `NfapiTestGuardError`, antes
de qualquer `fetch`, e o provedor não a converte em erro fiscal. Vale para
emissão, consulta, cancelamento, carta de correção, inutilização,
manifestação (pela nota e pela chave), consulta por chave e sincronização.
Leituras saem. O cofre simulado usa `https://nfapi-cofre.fake-vault.test`.

## Emissão: referência, repetição e idempotência

**Referência.** É `wb.<id do documento>.v<versão>`, derivada da `FiscalKey`
(`document_id`, `version`). É a mesma em toda tentativa e cabe no padrão do
contrato (`^[A-Za-z0-9._:-]{1,80}$`).
- **Rejeitada ou com erro:** reenvie o pedido corrigido na **mesma** versão.
  O cofre aceita conteúdo novo numa referência rejeitada. Pedir a versão
  seguinte nesse caso dá `409 fiscal_previous_version_reusable`, sem chamar a
  emissão.
- **Versão nova (`v<n+1>`):** só depois que a nota da versão anterior foi
  cancelada, ou denegada (a denegação consome o número).
- **Antes de emitir,** o provedor confere as versões anteriores no mesmo
  ambiente. Se uma delas estiver autorizada, em processamento ou indefinida, a
  emissão para com `409 fiscal_previous_version_open`. Uma versão anterior
  indefinida é consultada primeiro.

**Corpo igual entre tentativas.** O cofre compara o conteúdo: corpo diferente
na mesma referência dá `409 referencia_com_conteudo_diferente`, e isso nunca é
repetido. Por isso o domínio Fiscal guarda o corpo da versão. A `dataEmissao`
**sai do pedido por padrão**:
- o cofre carimba a hora da emissão no fuso da UF, e ela fica fora da
  comparação;
- a NFC-e com data atrasada seria rejeitada.

Com `emit(..., { keep_issue_date: true })` a data vai, e o ERP precisa
reenviar exatamente a mesma.

**NFS-e indefinida:** não há `/consultar` para ela. Só a repetição do pedido
com a mesma referência fecha (o cofre consulta antes de reenviar). É o que o
`emit` faz; `reconcile` existe só para NF-e e NFC-e. A NFapi registra isso
como lacuna conhecida, sem data.

**Algoritmo de `emit`** (no máximo 3 envios):

| O que voltou | O que o provedor faz |
|---|---|
| 201 / 200 | Resultado. `replayed: true` quando o cofre já tinha a nota (200). |
| Resposta perdida (rede, tempo esgotado, página da Cloudflare) ou `500 erro_interno` | `GET ?referencia=&ambiente=`. Se a emissão está lá, devolve; se está indefinida, consulta. Só reenvia se a referência não estiver no cofre. |
| `502 sem_resposta_conclusiva` | `POST /:id/consultar`. Só se continuar indefinida, repete o POST com a mesma referência (o cofre consulta de novo antes de reenviar). |
| `409 emissao_em_andamento` | Devolve a emissão em processamento. |
| `409 referencia_com_conteudo_diferente` | Erro para a pessoa, sem repetir. |
| `422` com emissão (`nfe_rejeitada`, `nfe_denegada`, erro antes de transmitir) | Resultado `rejected`, `denied` ou `error`, com `messages` (cStat e xMotivo). Corrigido, o corpo novo pode ir com a **mesma** chave: a referência rejeitada aceita conteúdo novo. |
| Tentativas esgotadas, com emissão conhecida | Resultado `undetermined` ou `processing`, com `provider_ref`. O ERP guarda e chama `reconcile` depois. |
| Tentativas esgotadas, sem emissão | `503 fiscal_provider_unreachable`, `retryable: true`. |

**O que a resposta traz para o cupom (contrato 0.3.1 em diante).** Na NF-e e na NFC-e,
o resultado traz:
- `access_key`, `protocol`, `authorized_at` (o `dhRecbto` da SEFAZ);
- `issued_at` (o `dhEmi`, com o fuso da UF);
- `series`, `number`, `total`, `environment`;
- só na NFC-e: `qr_code` e `consult_url`.

Itens, descontos, pagamentos e troco são os que o ERP enviou, ou estão no
`nfeProc` (`xml()`). Dois cuidados:
- **O total do cupom é `total`.** O cofre soma os totais, então o cupom usa
  o `total` da resposta, não a soma feita pelo ERP.
- **Homologação.** O cofre troca no XML a descrição do primeiro item e o nome
  do destinatário por "EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL".
  O XML de homologação não bate com o que o ERP enviou nesses dois campos.

**Eventos:**
- **Cancelamento e carta de correção:** uma repetição depois de resposta não
  conclusiva, conferindo antes a situação da nota.
- **`event_repeated`:** é o `repetido` do cofre (0.3.2). `true` quando o
  evento já estava registrado e nada novo foi ao governo. Fica `null` quando
  a resposta se perdeu e o estado foi lido depois. Ele sozinho não decide o
  efeito no ERP: se a resposta da primeira chamada se perdeu, a segunda vem
  com `true` e o ERP nunca lançou o efeito. Lance o efeito pelo estado do
  próprio documento (ainda não está cancelado no ERP? Cancele).
- **Inutilização:** desde a 0.4.1 a faixa já inutilizada volta 200 com
  `repetido` (`repeated` no resultado), então depois de resposta não
  conclusiva o provedor repete uma vez. Em cofre mais antigo não repete,
  porque a SEFAZ recusaria a faixa repetida.

**Testes com respostas perdidas** (`provider.test.ts`): o cofre simulado conta
as notas que o "governo" autorizou de fato, inclusive as que ficaram
indefinidas. Seis sequências de falhas misturadas, mais uma rodada extra do
ERP, nunca passam de uma nota por documento.

## Erros

O `FiscalError` estende `ApiError`. Em `details` vêm:
- `provider_code`: o código original do cofre;
- `field`: o campo recusado;
- `messages`: `[{code, description}]`, o cStat e o xMotivo;
- `emission`: o resultado, quando o cofre mandou a emissão;
- `retryable`.

| Cofre | Wabotia | Pode repetir |
|---|---|---|
| `400 requisicao_invalida` (+`campo`) | `422 fiscal_invalid_request` | não |
| `401 nao_autenticado` | `409 fiscal_provider_unauthorized` | não |
| `403 chave_somente_homologacao` | `409 fiscal_key_homologation_only` | não |
| `404 nao_encontrado` | `404 fiscal_document_not_found` | não |
| `409 referencia_com_conteudo_diferente` | `409 fiscal_reference_conflict` | **nunca** |
| `409 emissao_em_andamento` | `409 fiscal_in_progress` | sim |
| `409 certificado_ausente` / `certificado_vencido` | `409 fiscal_certificate_missing` / `_expired` | não |
| `409 nfe_nao_autorizada` / `nfse_nao_autorizada` | `409 fiscal_not_authorized` | não |
| `409 faixa_em_uso` / `numero_ja_utilizado` | `409 fiscal_range_in_use` / `fiscal_number_used` | não |
| `422 serie_nao_cadastrada` / `serie_obrigatoria` | `422 fiscal_series_not_registered` / `fiscal_series_required` | não |
| `422 uf_nao_suportada` | `422 fiscal_uf_not_supported` | não |
| `422 inutilizacao_extinta` (SP, AC, BA) | `422 fiscal_void_range_abolished` | não |
| `422 emitente_divergente` | `422 fiscal_emitter_mismatch` | não |
| `422 *_rejeitado(a)`, `nfe_denegada` | `422 fiscal_rejected` / `fiscal_denied` (na emissão, viram resultado) | não |
| `422 carta_nao_se_aplica` / `limite_de_cartas` | `422 fiscal_correction_not_applicable` / `_limit` | não |
| `422 producao_bloqueada` | `409 fiscal_production_blocked` | não |
| `422 certificado_do_cliente_invalido` | `409 fiscal_certificate_rejected` | não |
| `422 host_nao_permitido` | `502 fiscal_provider_error` | não |
| `409 distribuicao_nao_configurada` | `409 fiscal_distribution_not_configured` | não |
| `409 xml_indisponivel` (nota recebida só com resumo) | `409 fiscal_xml_unavailable` | não |
| `409 manifestacao_ja_registrada` | `409 fiscal_manifestation_already_registered` | não |
| `422 chave_de_acesso_invalida` | `422 fiscal_invalid_access_key` | não |
| `422 justificativa_obrigatoria` | `422 fiscal_justification_required` | não |
| `422 limite_de_manifestacoes` | `422 fiscal_manifestation_limit` | não |
| `422 manifestacao_rejeitada` / `consulta_rejeitada` | `422 fiscal_rejected` | não |
| `422 nota_nao_localizada` | `422 fiscal_received_note_not_found` | não |
| `429 limite_de_consultas` / `consumo_indevido` | `429 fiscal_query_limit` / `fiscal_queries_blocked`, com `retry_at` (ISO, lido de `erro.mensagem`) | depois de `retry_at` |
| operação mais nova que o cofre | `409 vault_outdated`, com `min_version` | não |
| arquivo acima do limite (PDF 10 MB, imagem 2 MB) | `502 fiscal_file_too_large` | não |
| `502 sem_resposta_conclusiva` | `503 fiscal_no_conclusive_answer` | sim |
| `500 erro_interno` | `503 fiscal_provider_unavailable` (na emissão, procura a referência antes) | sim |
| `503 cofre_nao_configurado` | `409 fiscal_provider_not_ready` | não |
| `sem_conexao` (só em `mensagem.codigo` do status da SEFAZ) | `503 fiscal_provider_unavailable` | sim |
| código fora da tabela: 4xx / 5xx | `422 fiscal_provider_rejected` / `503 fiscal_provider_unavailable` | não / sim |
| sem resposta | `503 fiscal_provider_unreachable` | sim |
| página `error code: 1042` | `502 fiscal_provider_same_zone` | não |
| sem emissor | `409 fiscal_provider_not_configured` | não |

**Rejeições de cadastro.** Algumas rejeições da SEFAZ dependem de cadastro fora
do sistema e não se resolvem repetindo. Elas ficam em
`REGISTRATION_REJECTIONS` (`provider.ts`), pelo cStat da primeira mensagem.
Na emissão viram erro, não resultado, para o ERP e o caixa não insistirem.
O erro traz:
- o código e a mensagem para a pessoa;
- `messages` com o cStat e o xMotivo originais;
- `emission` com a emissão rejeitada;
- `retryable: false`.

| cStat | Erro | O que a pessoa faz |
|---|---|---|
| 245 "CNPJ Emitente não cadastrado" | `422 fiscal_issuer_not_accredited` | Credenciar a empresa na SEFAZ do estado (visto na NFC-e em SP). |
| 181 CNPJ do destinatário inexistente na Receita | `422 fiscal_recipient_not_registered` | Corrigir o CNPJ do cliente. Em homologação, só CNPJ existente passa. |

Corrigido o cadastro ou o dado, a emissão segue a regra da rejeição: reenvie
na **mesma** versão.

A tabela segue `x-codigos` do contrato: 43 códigos com status, em
`CONTRACT_ERROR_CODES`. Código desconhecido é tratado pelo status HTTP, como
o contrato pede.

**Formato antigo.** Até a 0.3.1, os erros gerais (`503 cofre_nao_configurado`,
`404` de rota, `500 erro_interno`) saíam como `{ "error": { "code",
"message" } }`. O cliente aceita esse formato e o converte, enquanto houver
cofre antigo instalado. Pode sair quando nenhum cofre anterior à 0.3.2
estiver em uso.

## Onde mora a configuração

A configuração fica num segredo do núcleo, `secrets` com id
`erp-emissor:<área>`, cifrado com AES-GCM pela `MASTER_KEY`. É o mesmo padrão
da Cobrança com o token do Mercado Pago. Por que não nos outros lugares:
- **Configuração do módulo:** é texto puro e volta inteira ao painel.
- **SQLite do objeto `erp:<área>`:** entra no backup lógico no R2
  (`/erp-backup`), e a chave sairia junto.

Tudo fica no mesmo registro, sem migração: endereço, chave, quem alterou e o
último teste de conexão (sem segredos).

A chave nunca é devolvida. A visão só diz `api_key_set`. Trocar o endereço
exige informar a chave de novo, para ela nunca ir a outro host. O endereço é
só a origem `https://`, sem caminho, usuário ou senha. O cliente não segue
redirecionamento.

## Rotas para o painel (contrato para a sessão M)

Montagem em `src/index.ts`, que fica fora desta pasta:

```ts
const emissor = (c) => erpEmissorRoute(c.env, c.req.raw, c.req.param("profile"), c.get("actor"));
app.all("/api/v1/profiles/:profile/erp-emissor", emissor);
app.all("/api/v1/profiles/:profile/erp-emissor/*", emissor);
```

Todas exigem:
- uma pessoa (`kind: user`) com acesso à área;
- os módulos `erp` e `erp-fiscal` ligados. Desligado, a resposta é `409
  module_disabled`.

Escrita só com administrador. Em caso de erro fiscal, a resposta é `{ error:
{ code, message, provider_code, field, messages, emission, retryable } }`.

| Rota | Quem | O quê |
|---|---|---|
| `GET /erp-emissor` | quem tem acesso | Estado guardado (não chama o cofre). |
| `PUT /erp-emissor` `{url, api_key?}` | admin | Salva. `api_key` é obrigatória na primeira vez e ao trocar o endereço. |
| `DELETE /erp-emissor` | admin | Remove a configuração. |
| `POST /erp-emissor/test` | admin | "Testar conexão": chama `GET /v1/cofre`, `/v1/series` e `/v1/openapi.json`, guarda e devolve o estado. |
| `GET /erp-emissor/series` | quem tem acesso | Séries ao vivo do cofre. |
| `GET /erp-emissor/sefaz?uf=SP&modelo=nfce&ambiente=homologacao` | quem tem acesso | Status da SEFAZ: `{in_operation, authorizer, message, average_seconds}`. |
| `GET /erp-emissor/nfe/{ref}/danfe` | quem tem acesso | DANFE em PDF. |
| `GET /erp-emissor/nfce/{ref}/danfce?largura=80\|58&via=consumidor\|estabelecimento` | quem tem acesso | DANFE NFC-e em PDF. Largura ou via desconhecida: 400 sem chamar o cofre. |
| `GET /erp-emissor/nfce/{ref}/cupom?via=` | quem tem acesso | Cupom em JSON (`Cupom` do contrato), para a impressora do caixa. |
| `GET /erp-emissor/logotipo` | quem tem acesso | Logotipo (PNG ou JPEG); sem logotipo: 404 `fiscal_logo_missing`. |
| `GET /erp-emissor/{nfe\|nfce\|nfse}/{ref}/cancelamento/xml` | quem tem acesso | XML do cancelamento. |
| `GET /erp-emissor/nfe/{ref}/carta-correcao/{n}/xml` | quem tem acesso | XML da carta de correção `n`. |
| `GET /erp-emissor/inutilizacoes/{ref}/xml` | quem tem acesso | XML da inutilização. |

"Quem tem acesso" é qualquer papel `erp:*`. Os arquivos vão com o tipo e o
tamanho que o cofre mandou, sem transformação, `Cache-Control: private,
no-store` e `X-Content-Type-Options: nosniff`. O cofre gera os PDFs na hora:
nada fica guardado no Wabotia, e nenhum conteúdo de nota vai para log.
Caractere fora do Latin-1 sai como "?" no PDF (limite do cofre).
Erros do 0.8.0: 409 `fiscal_not_authorized` para nota sem XML autorizado
arquivado; 404 `fiscal_document_not_found` para id inexistente ou de outro
modelo.

Estado (`GET`, `PUT`, `DELETE`, `POST /test`):

```jsonc
{
  "configured": true,
  "provider": "nfapi",
  "url": "https://nfapi-cofre.sua-conta.workers.dev",
  "api_key_set": true,
  "contract_version": "0.3.2",          // contrato com que o Wabotia foi escrito
  "updated": 1763300000000,
  "checked": {                          // null antes do primeiro teste
    "at": 1763300000000, "ok": true,
    "error": null,                      // {code, message, provider_code} quando ok=false
    "state": {
      "provider": "nfapi", "version": "0.3.2",
      "update": { "published": "0.3.3", "pending": true },
      "certificate": { "holder": "EMPRESA LTDA", "document": {"kind": "cnpj", "id": "…"},
                       "valid_until": "2027-03-01T03:00:00.000Z",
                       "days_left": 104 },  // recalculado a cada leitura
      "production_released": false,
      "key": { "scope": "completo", "environments": ["homologacao", "producao"] },
      "documents": { "nfse": true, "nfe": ["SP", "…"], "nfce": ["SP"] }
    },
    "series": [{ "kind": "nfce", "environment": "homologacao", "series": 1,
                 "next_number": 1, "description": null, "cnpj": "…" }],
    "contract": { "pinned": "0.3.2", "vault": "0.3.2", "compatible": true, "differences": [] }
  },
  "alerts": [ { "code": "vault_outdated", "level": "warning", "message": "…", "version": "0.3.3" } ]
}
```

Os textos dos alertas já vêm prontos para mostrar.

| `alerts[].code` | Nível | Quando |
|---|---|---|
| `never_checked` | warning | A conexão nunca foi testada. |
| `check_failed` | error | O último teste falhou (`checked.error`). |
| `check_stale` | info | O último teste tem mais de 24 h. |
| `vault_outdated` | warning | "Cofre desatualizado": `update.pending`. |
| `certificate_missing` | error | O cofre não tem A1. |
| `certificate_expired` | error | O certificado venceu (`days_left` negativo). |
| `certificate_expiring` | warning | "Certificado vence em N dias" (`days_left` ≤ 30). |
| `contract_incompatible` | error | O contrato do cofre é de outra minor. |
| `contract_changed` | info | O contrato do cofre tem diferenças na mesma minor. |
| `production_blocked` | info | O cofre só emite em homologação. |
| `key_homologation_only` | info | A chave só opera em homologação. |
| `vault_feature_outdated` | warning | "Cofre desatualizado para X": `feature` e a versão mínima em `version`. |
| `contingency_pending` | warning | NFC-e em contingência ainda sem transmissão (`pending_notes`). |
| `logo_missing` | info | O cofre não tem logotipo (o DANFE sai sem a marca). |

## Chamada de Worker para Worker

A documentação da Cloudflare (lida em 16/11/2026) diz:
- **Erro 1042:** um Worker tentou buscar outro Worker da mesma zona, o que só
  funciona com a flag de compatibilidade `global_fetch_strictly_public`
  ([erros do Workers](https://developers.cloudflare.com/workers/observability/errors/)).
- **Sem a flag:** o `fetch` para a própria zona vai à origem e ignora os
  Workers daquela URL.
- **Com a flag:** o `fetch` volta pela "porta da frente", como tráfego da
  internet. A flag não é padrão em nenhuma data de compatibilidade
  ([compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)).
- **Entre Workers:** há dois caminhos, a flag ou um service binding
  ([fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/)). O
  service binding exige o Worker de destino na mesma conta.

O que isso significa para o Wabotia:
- **Cofre em outra zona ou em outra conta:** o `fetch` comum funciona. Isso
  vale, por exemplo, para o cofre em `*.workers.dev` com o Wabotia num
  domínio próprio.
- **Cofre na mesma zona do Wabotia:** dá erro 1042 sem a flag. Exemplos: os
  dois em subdomínios do mesmo domínio próprio, ou provavelmente os dois no
  mesmo `<conta>.workers.dev`.
- **A flag vale para quem chama:** ela iria no Worker do Wabotia, não no do
  cofre. A NFapi registra o mesmo arranjo.
- **Correção sem recurso novo:** uma linha no `wrangler.jsonc` (arquivo do
  núcleo, das sessões A e O; não editei):
  `"compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"]`.
  Instalador e atualizador já repassam as flags, sem nenhuma outra mudança:
  - `scripts/release.mjs` copia `config.compatibility_flags` do
    `wrangler.jsonc` para o pacote;
  - `src/release.ts` confere o campo e manda `pkg.compatibility_flags` no
    `metadata` do `workerUpload`;
  - `src/web-install.ts` e `scripts/install-release.ts` fazem o mesmo na
    instalação.
  - Os testes (vitest) leem o mesmo `wrangler.jsonc` e passariam a rodar com
    a flag.
- **Efeito no resto do Wabotia:**
  - A flag só muda o `fetch` global. Bindings não mudam: Durable Objects,
    `ASSETS`, D1 e R2.
  - Os `fetch` globais do Wabotia vão a serviços de fora: Zernio, Meta,
    Mercado Pago, provedores de IA, Hermes e o catálogo
    `https://wabotia.queven.app`. Não achei `fetch` à própria instalação.
  - Uma instalação na mesma zona do catálogo (`queven.app`) passaria a
    alcançá-lo pela borda, que é o comportamento correto.
  - Com a flag, regras de WAF e Access da própria zona passam a valer para o
    tráfego do Wabotia que fica na zona.
- **Do lado do cofre:**
  - Cada chamada chega com o cabeçalho `CF-Worker: <zona dona do Worker do
    Wabotia>`, que a Cloudflare acrescenta a todo `fetch` de Worker
    ([cabeçalhos HTTP](https://developers.cloudflare.com/fundamentals/reference/http-headers/)).
  - O IP de origem é compartilhado da Cloudflare: entre zonas, o
    `CF-Connecting-IP` é um endereço fixo de Workers.
  - Por isso o cofre não pode liberar o Wabotia por IP. A autenticação é a
    chave de API, e para o cliente nada muda.
- **Service binding:** não usado, porque o atualizador não o cria. O
  `FiscalContext.fetch` aceita um `fetch` injetado, se um dia existir um.
- **Detecção:** o cliente reconhece a página `error code: 1042` e devolve
  `fiscal_provider_same_zone`. O "Testar conexão" mostra o erro.
- **Não conferido numa conta real:** se dois Workers no mesmo
  `<conta>.workers.dev` disparam o 1042.

## Contingência da NFC-e (cofre 0.4.0 em diante)

`emit(ctx, "nfce", pedido, key, { contingency })`, com `contingency`:
- `never` (padrão do cofre): sem resposta do governo, `503
  fiscal_no_conclusive_answer`, como antes;
- `automatic`: o cofre espera até 20 s e, sem resposta conclusiva, emite a
  nota em contingência offline (tipo de emissão 9) com **número novo**. As
  vendas seguintes saem direto em contingência enquanto a SEFAZ segue fora;
- `forced`: emite direto em contingência.

O que o ERP recebe e faz:
- **Resultado.** Status `contingency`, com `contingency: { pending, since,
  reason, transmission_attempts, last_attempt_at, normal_note_in_review,
  review_failure, normal_note_cancelled }`. O caixa imprime o DANFE NFC-e
  normalmente, e o cofre usa os textos e vias próprios da contingência.
- **Nota válida.** Na regra das versões, a nota em contingência conta como
  autorizada: bloqueia versão nova com `fiscal_previous_version_open`.
- **Transmissão.** O cofre transmite sozinho quando a SEFAZ volta. Para
  forçar uma tentativa, o caminho é `reconcile` (`/consultar`): não existe
  `transmitContingency`. O prazo legal é o fim do primeiro dia útil seguinte.
- **Painel.** `state().contingency.pending_notes` gera o alerta
  `contingency_pending`.
- **Tempo-limite.** O cliente usa no mínimo 60 s de tempo-limite de escrita
  quando o pedido traz contingência, acima da espera de 20 s do cofre.
- **Comparação de conteúdo.** O modo não entra nela: trocar o modo entre
  tentativas não dá `referencia_com_conteudo_diferente`.

**A mesma referência repetida durante a espera** (o caixa desistiu e
repetiu, ou a resposta se perdeu) nunca gera segunda nota nem reenvia ao
governo. Enquanto o cofre espera, a referência está `processando`: a
repetição recebe `409 emissao_em_andamento`, e o provedor devolve a emissão
em processamento. Depois da espera, a repetição recebe `200` com a nota em
contingência. É o teste `contingency.test.ts`, que conta os envios ao
governo no cofre simulado.

## NF-e recebidas e manifestação do destinatário (cofre 0.9.0)

São notas que outras empresas emitiram contra o CNPJ do titular. O cofre as
baixa do Ambiente Nacional no ritmo que ele permite. NSU e espera são só do
cofre. O ERP **lê**:

- **Lista por cursor.** `received(ctx, { after, limit, environment,
  access_key })` devolve `{ items, last_sequence, has_more }`. Guarde
  `last_sequence` e passe em `after`. A sequência cresce a cada mudança
  (XML completo chegou, cancelada, manifestada), então **a mesma nota
  reaparece**: trate por `provider_ref` ou `access_key`. Ler não consulta o
  governo.
- **Papel.** `role` é `recipient` ou `third_party`. Só as de `recipient` se
  confrontam com pedido de compra.
- **Resumo.** Antes da manifestação só há resumo: sem itens nem XML
  (`xml_available: false`). `receivedXml` e `receivedDanfe` dão `409
  fiscal_xml_unavailable`.
- **Manifestação.** `manifest(ctx, { ref } | { access_key, environment?,
  cnpj? }, { type, justification? })`, com `type` `ciencia`, `confirmacao`,
  `desconhecimento` ou `nao_realizada`. A justificativa (15 a 255
  caracteres) só vale na não realizada.
  - É **evento fiscal**: no ERP, ação sensível da categoria nota fiscal.
  - Repetir devolve `repeated: true` sem enviar nada.
  - O provedor não repete sozinho, nem depois de 502: quem chama decide.
  - Erros próprios: 409 `fiscal_manifestation_already_registered`, 422
    `fiscal_manifestation_limit` e `fiscal_justification_required`.
- **Estado.** `distribution(ctx)` devolve o estado por CNPJ e ambiente:
  último NSU, próxima consulta, bloqueio e consultas por chave na última
  hora.
- **Consulta por chave.** `queryAccessKey(ctx, { access_key })` gasta a
  cota de 18 por hora. Esgotada, volta `429 fiscal_query_limit` com
  `retry_at`; bloqueio do Ambiente Nacional, `429 fiscal_queries_blocked`.
  Sem repetição automática.
- **Sincronizar.** `POST /v1/distribuicao/sincronizar` existe no cliente fino
  (o contrato exige), mas **não** no provedor: o cofre já consulta sozinho, e
  o ERP nunca chama em laço. Desde 0.9.1 o resultado traz `recuperados`.
- **Documentos a recuperar (0.9.1).** Quando outro sistema (o do contador,
  por exemplo) consulta o mesmo CNPJ, o Ambiente Nacional recusa a consulta
  do cofre (656) e alguns documentos ficam para trás; o cofre os busca sozinho
  pelo NSU, a cerca de 12 por hora. O provedor expõe a contagem em
  `FiscalDistributionState.recovering_documents` (0 no uso normal e em cofre
  0.9.0, que não informa).
- **Primeira consulta.** A de um CNPJ não traz nada: não há retroativo.
- **Configuração do cofre.** Sem ela, `409
  fiscal_distribution_not_configured`. Chave de homologação não age em
  produção.

**Dentro do objeto `erp:<área>`.** O cliente é `fetch` puro: roda também no
alarme do objeto. A conexão vem de `emissorConnection(env, área)`, que lê o
segredo `erp-emissor:<área>` no D1 e o decifra com a `MASTER_KEY`. Não
guarde a chave no SQLite do objeto, porque ele vai para o backup no R2.

## O que falta para emitir de ponta a ponta

- **Mapeamento da nota:** do documento do ERP (domínio Fiscal, ainda não
  portado) para `PedidoNfe`, `PedidoNfce` e `PedidoNfse`. Isso inclui guardar
  o corpo e a versão, e gravar número, série, chave, protocolo e XML.
- **Montar as rotas** em `src/index.ts` e as telas (sessão M).
- **Flag de compatibilidade** se o cofre puder estar na mesma zona.
- **Notas recebidas no ERP:** guardar as recebidas e confrontá-las com o
  pedido de compra é do domínio Fiscal (sessão G).
- **Fora deste cliente:** impressão (apps), carta de correção impressa, SVC
  da NF-e e DANFSe.
- **Conferência da 0.8.0 e da 0.9.0:** a NFapi conferiu a 0.8.0 em testes
  automatizados e visualmente, não num cofre publicado. O código de barras e
  o QR Code não foram lidos por leitor físico. A 0.9.0 foi testada com um
  Ambiente Nacional simulado, nunca contra o serviço real. Aqui, tudo contra
  o cofre simulado.
- **Teste real a partir do Wabotia:** este cliente nunca falou com um cofre
  real; os testes usam um cofre simulado. Do lado da NFapi, em 16/11, com um
  script local sobre o código do cofre (não pela API de um cofre publicado),
  na SEFAZ-SP em homologação:
  - **NF-e:** autorizada (cStat 100), com carta de correção (135) e
    cancelamento (135) registrados;
  - **NFC-e:** rejeitada com 245, porque o emitente de teste não é
    credenciado. Segue sem validação real, inclusive o QR Code versão 3;
  - **Inutilização:** não testada.

  Em homologação, a SEFAZ confere o CNPJ do destinatário na Receita
  (rejeição 181), então um teste real precisa de CNPJ existente.
- **Lacuna do contrato:** `500 erro_interno` e `503 cofre_nao_configurado`
  estão em `x-codigos`, mas as operações não declaram 500 nem 503. O cliente
  trata os dois mesmo assim.
