# Comercial avulso — abertura das cinco telas

Relato completo atualizado em 19/11/2026. As cinco telas estão habilitadas e
saíram de `MOTOR_PENDING`. A validação usa a erp-api original
(`createHandler`/adaptadores), SQLite Node, diferenciais contra o PostgreSQL
embarcado e, para atividades, o **SqlStorage real em Workerd offline**.
O fluxo completo Worker → Coordinator → D1/R2 passou na verificação externa
da abertura. A execução adicional dos quatro testes Worker novos revelou
uma falha no preparo do teste de confirmação; a nova execução após o ajuste
descrito abaixo permanece pendente, sem declaração de aprovação.

## Verificação complementar da confirmação pelo bot

A execução externa adicional informou **18 testes aprovados e 1 falha** nos
quatro arquivos novos. Passaram `erp-activity-routes`,
`erp-cnab-operacional-rotas` e `erp-meu-negocio-rotas`; a falha ficou em
`erp-commercial-bot`, na **segunda expectativa**, de `mfa_required`.

O primeiro pedido, feito pelo próprio bot, continua recusado com
`person_required`: `confirmProposal` verifica `actor.via` antes de ler ou
executar a proposta. `src/approvals.ts` usa a mesma restrição para decisões.
O ajuste anterior de identidade no ERP preserva a pessoa representada e
não interfere nessa recusa, que ocorre antes da chamada ao ERP.

O defeito era **do preparo do teste**, não uma permissão de autoconfirmação:
`f.admin` em `tests/service-center-fixture.ts` é um ator de serviço sem
`sessionId`. Acrescentar somente `aal: 1` e `mfa.policy: "financial"` não
o transforma numa sessão. `requireFinancialAal` (`src/mfa.ts`) dispensa
atores sem sessão e sem `via`; por isso aquela chamada direta resolveu e
salvou a meta. O portão do ERP tem política própria, desligada nesse preparo,
e não exigiu um segundo fator na rota.

Salvar meta não movimenta dinheiro, mas o contrato existente de
`erp.business.goal.save` está marcado **`sensitive: true`**. O mecanismo de
propostas atual não distingue categorias dentro dessa marca: com política
`financial` ou `all`, exige MFA para toda proposta sensível confirmada por
sessão humana (`src/bot-actions/actions.ts`, `docs/MODULOS.md`, seção
“Ações pelo bot”, e `docs/API.md`, seção de mesmo nome). Portanto, a recusa
da meta foi mantida; não se retirou sensibilidade nem se criou uma isenção.

Alterações desta verificação:

- `tests/erp-commercial-bot.test.ts`: cria uma sessão bearer no D1 e obtém
  o ator por `authenticate`, com política `financial`. A meta conserva as
  recusas do bot e da sessão `aal1`; após cada tentativa, confere proposta
  pendente, sem decisão nem resultado. Só a mesma sessão elevada a `aal2`
  confirma e salva a meta. O novo caso de geração de remessa v2, categoria
  documentada como documento financeiro e também sensível, conserva as duas
  recusas, a proposta pendente e a lista de remessas vazia. Esse caso testa
  o guarda antes da execução; o fluxo CNAB válido completo continua no teste
  de rotas existente.
- `docs/ERP-COMERCIAL-AVULSOS.md`: registra a causa, a política existente e
  o alcance da validação. Nenhum arquivo de produto executável foi alterado.

Os outros três testes Worker e a sonda `tests/erp-painel-rotas.test.ts`
foram conferidos contra a implementação e permanecem válidos, sem mudanças.
Continuam cobrindo abertura e corpo, papel humano, partes desligadas,
paginação, metas, atividades e o fluxo de remessa/retorno. A configuração
delimita o acesso dos bots; sensibilidade mantém proposta e confirmação
humana, sem proibição fixa da operação para bots. Origem externa não ganha
contexto interno, e a pessoa não ganha papel ou acesso por usar o bot.

Validação local desta verificação, sem rede:

- **16 testes Node aprovados**, sem falhas ou testes ignorados:
  `node --no-warnings --test tests/erp/commercial-contract.test.mjs tests/erp/commercial-navigation.test.mjs`
  (5),
  `node --no-warnings --test tests/erp/access/activity-routes.test.mjs tests/erp/preferences/business-open.test.mjs`
  (8) e
  `node --no-warnings --test tests/erp/cnab/panel-opening.test.mjs` (3).
- `npx tsc --noEmit`, `node scripts/check-encoding.mjs`,
  `node scripts/check-conflict-markers.mjs` e `git diff --check` aprovados.
  O TypeScript do projeto não inclui os arquivos de `tests/`.
- **Pendente do script externo:** executar novamente os quatro testes Worker
  novos e a sonda `erp-painel-rotas`. Os resultados locais não substituem essa
  execução. Vitest e Wrangler não foram executados nesta verificação.
- Nenhuma alteração em testes diferenciais, áreas excluídas, dependências,
  migrações, recursos Cloudflare ou classes de Durable Object. Sem commit,
  push ou troca de branch. Não há dúvida sobre a causa identificada; resta
  confirmar o resultado do teste corrigido no Worker.

## Causa da verificação externa anterior e correção

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
  foi conferida por teste e não precisou mudar. Na junção, cobrança e retornos
  operacionais também aparecem no menu de compatibilidade em Financeiro;
  registro de atividades e consulta de exclusões aparecem em Sistema.
  Esses quatro destinos continuam fora do contrato persistido de favoritos,
  que aceita os 42 destinos anteriores. O painel respeita essa distinção;
  ampliar os favoritos exige uma mudança própria no contrato do servidor.
- `web/erp/app/components/RealActivity.tsx`: botão de detalhe na cópia do painel.
  Na junção, `home-request.ts` e `home-model.ts` também distinguem os destinos
  do menu dos aceitos como favoritos. As exceções estão justificadas em
  `web/erp/ORIGEM.json`.
- `src/modules/erp/identity.ts`: na junção candidata, a pessoa via bot volta
  a ser agente por padrão. A remoção incondicional dessa marca na frente de
  telas reabertas (`bb279122`) quebrava o padrão provado por `erp-bot-via`.
  A exceção agora exige concessão nominal, bot/área/conversa interna válidos
  e, para escrever, proposta em confirmação pela sessão da pessoa. Papel,
  MFA, horário, `via` e recibo da proposta são preservados.
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
vínculo do bot e com origem externa. Há testes de MFA em sessão humana para
meta e remessa, de recusa do próprio bot e de perda do papel humano antes de
confirmar (`tests/erp-commercial-bot.test.ts`).

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
catálogo. Na junção, `bot.update`/`PATCH /profiles/{profile}/bots/{id}` recebe
`erp_operations` (ids dos contratos; `[]` revoga), com
`erp_data_acknowledged=true` ao liberar. Só administrador configura; o comando
é auditado pelo fluxo existente. A concessão fica nas opções do bot da área,
nasce vazia e avisa sobre o envio de dados ao provedor de IA. Não amplia o
papel da pessoa. Leituras usam a operação liberada; escritas passam pela
proposta e confirmação existentes. Ainda não há editor dessas concessões no
painel nem liberação autônoma persistida nesta junção.

`tests/erp-commercial-bot.test.ts` configura a concessão antes dos casos
positivos e acrescenta recusas sem configuração, por operação/área/papel,
revogação, falsa confirmação e bot desligado; a importação configurada usa a
mesma rota real. Os testes isolados anteriores conferiam o vínculo à conversa
e a confirmação, mas não o padrão legado nem uma concessão persistida.
Os 45 contratos não pretendem cobrir toda rota histórica: o subfluxo anterior
de crédito líquido Itaú, `/v1/retornos-itau109`, não foi criado nesta tarefa e
fica fora desse inventário (`web/erp/app/components/ItauNetCredit.tsx:47`).

## Validação da abertura das telas (rodada anterior)

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
- **Pendência registrada naquela rodada:** repetir `erp-painel-rotas` e
  `management-ported`; incluir também `erp-meu-negocio-rotas`,
  `erp-activity-routes`, `erp-cnab-operacional-rotas` e `erp-commercial-bot`.
  Os quatro arquivos novos não estavam no comando do log fornecido. Cobrem
  administrador/corpo, falta de papel, parte desligada, ações principais e
  proposta/confirmação. O teste direto do SqlStorage foi acrescentado a
  `erp-activity-routes` nesta rodada.
- Sem rede, commit, push, troca de branch, Vitest ou Wrangler CLI. Nenhuma
  classe de Durable Object de produção, recurso Cloudflare, dependência,
  migração D1 ou mudança de esquema SQLite foi criada.

Pendências finais: nova validação Worker após o ajuste do teste e ligação dos
contratos ao catálogo de bots. Não há mais dúvida residual sobre a causa do
SQL de atividades: ela foi reproduzida e o reparo confirmado no SqlStorage.
