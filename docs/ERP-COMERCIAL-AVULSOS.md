# Comercial avulso — abertura das cinco telas

Relato completo atualizado em 19/11/2026. As cinco telas estão habilitadas e
saíram de `MOTOR_PENDING`. A validação usa a erp-api original
(`createHandler`/adaptadores), SQLite Node, diferenciais contra o PostgreSQL
embarcado e, para atividades, o **SqlStorage real em Workerd offline**.
O fluxo completo Worker → Coordinator → D1/R2 ainda precisa de nova execução
externa depois desta correção; não foi declarado verde.

## Causa da verificação externa e correção

O `.codex-verificacao.log` registrou `check` aprovado e 33 testes aprovados,
com quatro falhas em dois arquivos:

- Duas falhas da sonda eram o mesmo erro de atividades/exclusões. A consulta
  reunia 36 fontes em um único `UNION ALL`; o SqlStorage aceita **cinco termos
  por SELECT composto**. A reprodução direta, sem Vitest, revelou
  `too many terms in compound SELECT: SQLITE_ERROR`. O SQLite Node aceita a
  consulta antiga, por isso o diferencial sozinho não detectava o problema.
- Duas falhas de navegação eram expectativas antigas de que Meu negócio e
  Registro de atividades ainda estariam indisponíveis. Os exemplos negativos
  passaram a usar as oito telas fiscais realmente pendentes; foram acrescentadas
  verificações positivas das cinco telas e negativas de papel/parte, inclusive
  com consulta e fragmento. Nenhuma recusa foi removida da cobertura.

`src/erp/domains/access/activity.ts:265` compõe uma árvore de subconsultas com
até cinco termos em cada nível. Conserva as 36 fontes, período, filtros,
ordenação e paginação globais, em **uma consulta**. O plano do SqlStorage não
materializa tabelas intermediárias. A hipótese anterior sobre parâmetros
numerados foi descartada: eles também funcionaram na reprodução. Os 78
parâmetros anônimos atuais permanecem dentro do teto de 100; não eram a causa.
Regressões em `tests/erp/access/activity-routes.test.mjs:135` conferem fontes
do primeiro e do último grupo, datas, filtros e paginação. O teste direto em
`tests/erp-activity-routes.test.ts:51` expõe o erro SQL na asserção, sem depender
de saída de console.

| Tela | Diagnóstico e alteração | HTTP próprios ao abrir | RPCs | SELECTs do motor vazio |
|---|---|---:|---:|---:|
| Meu negócio | RPC, registro e semente já funcionavam; pendência antiga não coberta pela sonda. Filtros de data/situação e limites passaram para SQL. | 3 | 3 | 39 |
| Registro de atividades | RPC já portado; corrigido o limite de cinco termos por SELECT composto no SqlStorage. A tela inicia sem pesquisa e lê `/people`. | 1 | 0 | 0; pesquisa: 2 |
| Consulta de exclusões | Mesma consulta de atividades, filtrada por exclusão; acrescentado botão de detalhe antes/depois. | 1 | 1 | 2 |
| Cobrança operacional | A sonda chamava raiz sem rota; alias de leitura aponta para a coleção existente. Página v2 agora limita snapshots no SQL. | 2 | 2 | 4 |
| Retornos operacionais | A sonda chamava raiz sem rota; alias de leitura aponta para arquivos de retorno. | 3 | 3 | 5 |

As contagens são das consultas próprias da tela, sem barra comum, sessão,
projeção de identidade, privacidade D1 e portões do Worker. A barra possui quatro
leituras comuns na sonda; a sessão também consulta `/v1/me`. Os testes Node
contam SELECTs do RPC em banco novo, com relógio fixo. Os testes Worker conferem
`Server-Timing` com uma ida ao motor por leitura. Não houve medição de latência
ou de SQL de produção. Em Meu negócio, as três parcelas são 6 + 5 + 28 SELECTs;
com documentos, itens e metas existentes, o número varia.

## Arquivos e comportamento

- `src/erp/domains/preferences/rpc/erp_home_business_panel.ts`: pedidos por
  período/situação usando os índices de data existentes; existência anterior
  de clientes restrita aos contatos do período; metas ordenadas e limitadas no
  SQL; vendedores das metas projetados com DISTINCT/ORDER/LIMIT 200, sem carregar
  documentos inteiros. Diferenciais preservam períodos, totais, ordenação e
  limites de 200 metas e vendedores.
- `src/erp/domains/access/activity.ts:265` e `rpc/activity.ts:43`: composição
  compatível com o limite real do SqlStorage, sem multiplicar consultas.
  `activity.ts:278` e `rpc/activity.ts:123`: detalhe consulta somente a fonte
  e a chave primária, inclusive quando outras partes estão desligadas.
- `src/erp/domains/cnab/rpc/erp_cnab_reads.ts`: filtro banco/carteira antes de
  `LIMIT limit+1`, com cursor pelo índice de `id`.
- `src/erp/blocks.ts` e `api/local-fetch.ts`: aliases somente GET/HEAD das três
  raízes CNAB; não herdam POST das coleções.
- `src/erp/parts-requirements.ts`: atividades pertencem à Base; margem e
  previsão exigem na rota as mesmas partes adicionais da tela.
- `src/modules/erp/panel-menu.ts`, `web/erp/motor.ts`: entradas liberadas por
  parte e papel. A política já existente em `web/management/ported-policy.ts`
  foi conferida por teste e não precisou mudar.
- `web/erp/app/components/RealActivity.tsx`: única alteração na cópia do painel,
  mínima, com justificativa consolidada em `web/erp/ORIGEM.json`.
- `src/modules/erp/identity.ts`: bot representando uma pessoa preserva a
  identidade humana; a marca de agente autônomo fica nas aplicações/sistemas.
  Papel, MFA, horário e confirmação continuam sendo conferidos; `via` e o
  recibo da proposta permanecem no núcleo para auditoria.
- `src/modules/erp/{commercial-operations,cnab-operations,openapi}.ts` e
  `src/modules/openapi.ts`: nomes estáveis, entradas, efeitos, respostas e
  sensibilidade documentados em português no OpenAPI das mesmas rotas.

Não foi necessário portar RPC novo: foram corrigidas a ligação das rotas,
consultas de RPCs existentes e a interface. Nenhum teste diferencial existente
foi alterado; os novos casos foram acrescentados.

## Ações e limites

Meu negócio permite trocar painéis/períodos, salvar metas e conferir o comando.
Atividades/exclusões permitem filtros, paginação e detalhe; fontes que não
conservam antes/depois continuam explicando essa ausência na tabela.

CNAB permite listar perfis, aprovar, pré-visualizar, gerar, retomar, baixar,
importar e conferir retorno pelas operações já existentes. A transmissão
direta ao banco continua fora: o original gera arquivo para envio manual,
explicado em `web/erp/app/components/CnabOperationalV2.tsx:146` e
`web/erp/app/components/RealCnabOperationalReturns.tsx:137`. A baixa integral
exige prévia, nova conferência e confirmação explícita (`:101`, `:111`);
importação não implica baixa automática.

Sem aprovação vigente, remessa, retomada e download ficam fechados com motivo
na tela (`CnabOperationalV2.tsx:140`, `:150`). Referências, saldo, datas, conta
ou ocorrência incompatíveis continuam impedindo a liquidação, com pendências
visíveis (`RealCnabOperationalReturns.tsx:108` e
`web/erp/app/lib/cnab-returns-model.ts:5`). Auditorias sem antes/depois mantêm
essa explicação na tabela (`RealActivity.tsx:95`).

Os menus e as recusas seguem Vendas para Meu negócio, Base para as duas telas
de auditoria e Cobrança (com Base e Financeiro) para CNAB. Margem exige também
Compras e Estoque; previsão exige Estoque (`src/erp/parts-requirements.ts:103`).
Nenhuma das cinco telas ficou em implantação por falta de RPC ou semente.

O fiscal permanece em implantação. Não foram alterados Fiscal, sincronização,
OS, integrações, canal, motor de atendimento, dependências, D1, esquema SQLite
ou recursos Cloudflare.

## Bots

Foram documentados **45 contratos**: 15 de Meu negócio, 2 de atividades e 28
de CNAB; 32 GET, 13 POST e 15 marcados como sensíveis. Estão em
`src/modules/erp/commercial-operations.ts`, `cnab-operations.ts` e
`openapi.ts`, publicados por `src/modules/openapi.ts`. Usam as mesmas rotas da
pessoa, com nomes estáveis, parâmetros, efeitos e respostas em português.
Somente três caminhos HTTP são novos: aliases GET/HEAD de
`/v1/cobranca-operacional`, `/v1/cobranca-operacional-v2` e
`/v1/retornos-operacionais` (`src/erp/blocks.ts:27`). Não há RPC ou escrita nova.

A infraestrutura de proposta/confirmação é exercitada por teste de meta;
cada alias é exercitado com contexto de conversa interna, com recusas sem
vínculo do bot e com origem externa. Há testes de MFA e perda do papel humano
antes de confirmar (`tests/erp-commercial-bot.test.ts:43`, `:60`, `:89`).

**Ainda falta a descoberta pelo catálogo.** `src/bot-actions/catalog.ts`
exige rotas registradas em `onRead/onRoute` (`:72`); `/erp/*` continua sendo repasse.
O OpenAPI, sozinho, não faz a operação aparecer nas ferramentas do modelo.
Para cada operação deste inventário será preciso ligar esse registro ao repasse
existente, filtrar parte/papel e pessoa ∩ configuração do bot e transportar
`sensitive` para `definition.bot`/política de confirmação (`catalog.ts:104`
não lê `x-bot-sensitive`, inclusive para leituras sensíveis). Essa ligação deve
conservar a liberação administrativa por bot/área, máscaras configuráveis e o
teto de cliente da origem externa. Nenhuma operação foi declarada proibida
definitivamente para bots. Os testes de proposta não simulam inscrição no
catálogo e não provam uma configuração por operação que ainda não existe ali.
Os 45 contratos não pretendem cobrir toda rota histórica: o subfluxo anterior
de crédito líquido Itaú, `/v1/retornos-itau109`, não foi criado nesta tarefa e
fica fora desse inventário (`web/erp/app/components/ItauNetCredit.tsx:47`).

## Validação

- **104 testes Node distintos aprovados nesta rodada**: atividades 9;
  Meu negócio 8; CNAB 69; navegação/contratos/manifesto/classificação/textos 18.
  Incluem diferenciais existentes intactos, os novos diferenciais e planos de
  consulta com `EXPLAIN QUERY PLAN`. Repetições de contratos não entram no total.
- **Workerd offline aprovado**: a consulta antiga falhou com o erro SQL acima;
  a árvore corrigida passou. Pela erp-api sobre `storageDriver`/SqlStorage real,
  dez chamadas internas tiveram os resultados esperados (oito 200 e duas 403):
  abertura de ambas as telas, filtros, paginação e detalhe. As duas leituras
  SQL de abertura foram medidas novamente. Configuração sem sockets e com
  saída de rede fechada. Evidência temporária em
  `/tmp/com-revela-sql-probe/{probe.log,routes.log}`; execução direta de
  `node_modules/wrangler/node_modules/workerd/bin/workerd test`, sem Wrangler CLI.
- `npm run check` (TypeScript, UTF-8, conflitos e CSS) e `git diff --check`
  aprovados. Manifesto do painel e ausência do nome antigo em tela aprovados.
- O log externo anterior aprovou `f2-painel`, `erp-do-cnab-gate` e
  `worker-routes`, mas falhou nas quatro asserções descritas acima. Não se
  trata de resultado posterior à correção.
- **Pendente de execução externa:** repetir `erp-painel-rotas` e
  `management-ported`; incluir também `erp-meu-negocio-rotas`,
  `erp-activity-routes`, `erp-cnab-operacional-rotas` e `erp-commercial-bot`.
  Os quatro arquivos novos não estavam no comando do log fornecido. Cobrem
  administrador/corpo, falta de papel, parte desligada, ações principais e
  proposta/confirmação. O teste direto do SqlStorage foi acrescentado a
  `erp-activity-routes` nesta rodada.
- Sem rede, commit, push, troca de branch, Vitest ou Wrangler CLI. Nenhuma
  classe de Durable Object de produção, recurso Cloudflare, dependência,
  migração D1 ou mudança de esquema SQLite foi criada.

Pendências finais: validação completa no Worker após o reparo e ligação dos
contratos ao catálogo de bots. Não há mais dúvida residual sobre a causa do
SQL de atividades: ela foi reproduzida e o reparo confirmado no SqlStorage.
