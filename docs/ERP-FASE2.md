# ERP — contrato integrado da fase 2

A área possui nove chaves. `erp` significa **Cadastros**; o botão
de navegação permanece **ERP**. Todas começam desligadas. A migração aditiva
`0133_erp_parts.sql` replica o estado existente de `erp` nas cinco novas
partes, sem sobrescrever escolhas, reiniciar revisões ou alterar o SQLite do
ERP. As tabelas continuam existindo mesmo quando uma parte está desligada.
Na janela entre a migração e o Worker novo, ativações antigas sem a marca
`profile_erp_parts_managed` também completam essas cinco partes. Escritas da
versão nova gravam a marca antes dos módulos no mesmo lote D1 e conservam a
seleção explícita, inclusive ao reativar a Base ou reaplicar a migração.

## Módulos e dependências

| Chave | Nome | Dependências diretas |
|---|---|---|
| `erp` | Cadastros | — |
| `erp-produtos` | Produtos e serviços | Cadastros |
| `erp-vendas` | Vendas | Produtos e serviços |
| `erp-compras` | Compras | Produtos e serviços |
| `erp-estoque` | Estoque | Produtos e serviços |
| `erp-financeiro` | Financeiro | Cadastros |
| `erp-fiscal` | Fiscal | Cadastros |
| `erp-cobranca` | Cobrança bancária | Financeiro |
| `erp-pdv` | Caixa / PDV | Vendas, Financeiro, Estoque |

Somente Base declara os seis papéis anteriores. Chave não concede papel,
permissão nem MFA. Ligar dependentes expõe seus requisitos; desligar uma
parte com dependentes exige a confirmação de cascata. A gravação do conjunto
é um único batch, com eventos posteriores.

## Regras de operação

Desligar suspende operação nova com `409 module_disabled`. Uma venda ou
compra pode continuar sem Estoque e/ou Financeiro: postagem e `autoFinance`
são pulados antes de exigir referências dessas integrações. Efeitos já
gravados conservam flags e guardas. Estornos configurados continuam possíveis;
sem efeito ativo, retornam `skipped`, com `reason: part_disabled` quando cabível.

Comissão nova exige Financeiro e origem comercial. Confirmação, edição,
troca de vendedor e produtores indiretos não recalculam comissão suspensa.
Cancelamento explícito pode compensar a operação anterior. Captura de custo
e margem exigem Vendas + Compras + Estoque. Custo histórico não é apagado;
fonte suspensa não deve produzir margem corrente.

Religar não recompõe o passado. Leitura e replay não completam efeitos
pulados; `parts` não entra no hash do comando. Uma nova ação explícita usa
estado e preferências atuais, podendo executar automação antes suspensa.
O painel avisa antes da confirmação. Não há corte contábil novo.

Campos de partes suspensas são preservados se omitidos ou reenviados
idênticos. Alteração e limpeza por `null` são recusadas pelo servidor.
Cópia não transporta vínculos operacionais indisponíveis. Parcelas,
vencimentos e condições comerciais permanecem utilizáveis; contas,
categorias, tarifas e comissão obedecem ao Financeiro. O limite operacional
de crédito fica suspenso; proteções históricas de unidade e tipo continuam.

As operações compostas usam requisitos compartilhados: recebimento físico
exige Compras + Estoque; reserva exige Vendas + Estoque; composição, lotes e
inventário exigem Produtos + Estoque; XML comercial exige Fiscal, Produtos
e dono; lançamento de nota exige Fiscal + destino e, se vinculada a pedido,
Compras. Agrupamento novo exige Financeiro e a origem de cada item. Títulos
antigos continuam liquidáveis no Financeiro com Vendas desligado.

## Manutenção de efeitos históricos

`GET /v1/sistema/manutencao-efeitos?type=…&id=…` consulta vínculos,
bloqueadores, ações reversas e a versão da origem quando existente. Postagens
financeiras de notas incluem IDs e versões atuais dos títulos; remessas
incluem a sequência como texto. São somente leituras de tabelas existentes.

`POST` aceita uma ação enumerada e os argumentos da operação original:
alvo, versões, prévia, motivo e comando. Não aceita RPC livre, SQL, partes,
papel ou bypass. O escopo temporário permite apenas a cadeia de compensação
vinculada à origem. Administrador pode acessar origem desligada pela Base;
demais acessos continuam sujeitos aos papéis e permissões originais.

Liquidação, cobrança protegida, reserva, recebimento, agrupamento, saldo
insuficiente e versão divergente continuam sendo bloqueadores reais. A tela
recusa executar se faltar versão ou prévia necessária. Desligar uma chave
não apaga vínculos nem elimina essas proteções.

## Transporte e entrega de estado

`parts.ts` define nove booleanos; somente `false` desliga na compatibilidade
do motor direto. Toda entrada de produção exige mapa completo e
`partsControl: {profile, revision, expires_at}`. Corpo comercial e cabeçalho
externo não autorizam partes. Fotografia ausente/inválida responde
`503 erp_parts_unavailable`; revisão superada responde `409 erp_parts_stale`.
No armazenamento, a costura interrompe o adaptador quando essas recusas ou
`module_disabled` aparecem, preservando o código público. Um 409 de parte
desligada não pode ser tratado como duplicação idempotente de arquivo.

O lote de autenticação inclui pessoas, aplicações e a fotografia das partes.
A consulta de pessoas contém uma linha de controle independente de haver
pessoas: `identityPartsState` a consome e `personOf` não a projeta como membro.
O instante da leitura vem do SELECT. O envelope conserva também a privacidade
cadastral e a identidade técnica restrita do cadastro único, que precisa só
de Base. O objeto não consulta D1. O RPC aplica a fotografia ao KV na mesma
ida, antes de efeitos e de armazenamento; a leitura autenticada de metadados
continua em um batch D1 e um RPC.

Comandos, modelos e cron entregam `/erp-parts` e confirmam apenas a revisão
recebida. `erp_sync` expõe revisão corrente, entregue e `pending|applied`.
Uma entrega RPC sem ACK D1 pode continuar indicada como pendente até a
reconciliação seguinte. `applied` não garante execução de tarefa. A validade
máxima é seis minutos; cron renova a cada cinco minutos. Perda, duplicação,
revisões fora de ordem e revalidações entre unidades estão descritas em
[ERP-AGENDADOR.md](ERP-AGENDADOR.md).

## Consultas e painel

Ausência não vira zero: DTOs usam `null`, omitem capacidades e acrescentam
`unavailable_parts` apenas no modo dividido. Flags de existência histórica
permanecem verdadeiras. Parsers mantêm validações de seções disponíveis.
Relatórios, etiquetas, listas, transições e tarefas resolvem também suas
definições persistidas; o corpo não pode trocar a fonte real.

Menu, URL, favoritos, abas, ações e prefetch usam requisitos completos.
Somente Base abre diretamente Clientes. Extensões nativas isoladas não
montam o ERP portado; sem gestão disponível há estado vazio e acesso a
Módulos. Favoritos indisponíveis permanecem salvos. A demonstração usa as
mesmas definições dos nove módulos, com as cinco novas partes e PDV ligados,
Fiscal e Cobrança desligados. Os grupos nativos precedem os grupos portados.

As famílias `a1`, `fiscal-authorization` (incluindo `reviewed`),
`fiscal-danfe`, `fiscal-reconciliation`, `fiscal-signed`, `fiscal-unsigned` e
`fiscal-wsdl` pertencem ao Fiscal. A classificação não instala seus serviços
externos: Fiscal ligado não promete disponibilidade de emissão. Endereços
desconhecidos continuam 404; os aliases antigos de contexto de PDV e check-in
resolvem para os destinos atuais com seus requisitos completos.

## Modelos e limites da entrega

Modelos aceitam IDs embutidos com hífen, exigem o fechamento transitivo e
mostram todas as ativações na prévia. Seleção incompleta acusa conflito;
não ativa dependências escondidas nem sobrescreve alterações locais.
Cobrança e PDV continuam opções explícitas. Processos e projetos permanecem
tipos de trabalho; Mesas exige Pedido e Jurídico exige OS.

Não há integração operacional automática `os`/`pedido` → financeiro,
estoque ou fiscal por aplicar um modelo. A OS comercial antiga continua em
Vendas; seus dados não são migrados ao módulo nativo `os`. Não foram criadas
recorrências financeiras, recomposição comercial, nova classe de Durable
Object ou novo recurso Cloudflare. Não há transação distribuída D1/SQLite;
a unidade síncrona iniciada conclui com a fotografia que recebeu.

## Pontos de manutenção e aceitação

- `parts.ts`, `parts-requirements.ts`: tipos, dependências e requisitos por
  entidade, campo, preferência, relatório, notificação e destino.
- `blocks.ts`: famílias, métodos, alternativas, aliases e rotas conhecidas.
  `tests/erp/fixtures/route-blocks.json` preserva as 764 entradas originais,
  expandidas em 983 combinações; as entradas locais adicionais têm testes próprios.
- `engine/parts-gate.ts`: classificação explícita de todo RPC registrado,
  referências persistidas e escopo finito de manutenção.
- `modules/erp/parts-state.ts`, `identity.ts`, `parts-control.ts`: leitura,
  transporte, monotonicidade, TTL e confirmação de revisão.
- `schema/deviations.ts`: `ERP_PART_BEHAVIORS` é catálogo informativo; não
  integra `ERP_DEVIATIONS`, o gerador nem substituições no Postgres.
- `dual-fixture.mjs`: partes explicitamente ligadas no diferencial.
  `f2-paridade.test.mjs` compara também a ausência com o mapa completo,
  incluindo respostas, erros e todas as tabelas SQLite.
- `f2-aceite.test.mjs`: matriz de postagem, parsers, cadastro técnico,
  privacidade, replay, manutenção HTTP e versões dos vínculos históricos.
- `tests/f2-aceite.test.ts`: demonstração real, lote D1/envelope/KV, aplicação,
  sistema e recusa pública de referência persistida suspensa.

As demais suítes `f2-*` cobrem rollback, comissão, custo, preservação,
alarmes, migração, entrega perdida/duplicada/fora de ordem, modelos e
navegação. O aceite final exige `check`, `build`, `test:erp`, `test:erp:painel`
e Vitest inteiros verdes. Nesta máquina Vitest, Wrangler e verificações que
dependem de rede ficam a cargo do script do orquestrador; testes escritos
não equivalem a testes executados.

## Relato consolidado do aceite — 19/11/2026

**Registro histórico de `f2-aceite`.** As duas autorizações pendentes abaixo
foram concedidas em `f2-aceite2`. O estado desta continuação, a verificação
local e a tabela de asserções estão na seção final deste documento. Os logs
e impedimentos desta seção descrevem a rodada anterior, não a atual.

Este relato inclui as alterações que já estavam na árvore quando esta rodada
começou e as correções posteriores ao log `.codex-verificacao.log`. **O aceite
integral ainda não está comprovado.** O último resultado externo disponível
é de **278 arquivos aprovados, 14 reprovados, 2.961 casos aprovados e 28
reprovados**. Esse resultado antecede a correção do transporte desta rodada;
não é uma contagem de falhas da árvore atual. Vitest não foi executado nesta rodada.

Não houve commit, acesso à rede, migração nova, modificação de DDL/semente,
alteração do oráculo ou aumento do orçamento do pacote inicial. Nenhum caso
antigo foi excluído, pulado ou teve suas asserções afrouxadas. As mudanças de
preparação dos testes antigos estão enumeradas abaixo.

### Causas encontradas e correções

1. **Segunda ida ao D1.** `erpIdentity` já transportava a fotografia consistente
   lida junto com a autenticação, mas `erpApi` a substituía por uma nova leitura.
   A API agora reutiliza o envelope completo e válido para aquela área. A
   obtenção no D1 permanece para chamadas internas sem fotografia válida.
   As revalidações de privacidade cadastral foram preservadas; a otimização de
   uma ida ao D1 continua restrita às leituras de metadados previstas.
2. **Identidade técnica do cadastro sem marca de portão.** Uma chamada direta
   de `localFetch` com a identidade técnica, sem o coletor opcional `gate`,
   deixava de enviar `GATE_HEADER` e era recusada por `erp_customer_bridge_scope`.
   O transporte agora exige o portão também para esse ator. A lista finita de
   RPCs, os campos administrativos, a ausência de MFA/elevação e a privacidade
   continuam conferidos no objeto. `identity.ts` e `rpc-endpoint.ts` foram
   relidos; não foi aberto fallback de autorização para envelopes incompletos.
3. **404 indevido em rotas conhecidas.** O compilador dos padrões substituía
   apenas letras minúsculas em parâmetros. `:commandId`, por exemplo, virava
   `[^/]+Id`, exigindo um sufixo literal que um UUID real não possui. Agora
   reconhece o nome inteiro, inclusive camelCase e números. A aceitação percorre
   os padrões afetados, seus métodos e a recusa de segmentos extras.
4. **Hospedeiro ainda restrito às quatro chaves antigas.** O runtime não
   invalidava chamadas quando uma das cinco partes novas mudava e dependia de
   a casca ter instalado o contexto. Agora publica as nove partes, possui seu
   próprio contexto e o renova antes de liberar a posse anterior. A equivalência
   de contextos compara as nove autorizações efetivas, não a ordem das chaves
   nem módulos nativos irrelevantes. Um contexto encerrado continua recusando
   callbacks antigos; um hospedeiro novo pode estabelecer autorização nova.
5. **Resposta de prefetch exportada pelo adaptador substituído no teste.** A
   proteção de resposta foi extraída para `web/management/context-response.ts`
   e compartilhada pela casca e pelo transporte. Isso conserva um único corpo
   de implementação e a proteção após os cabeçalhos, inclusive a invalidação
   de `ok` e da leitura do corpo após aborto.
6. **Parte declarada ignorada numa exceção de destino.** `erpPartEnabled`
   conferia apenas o destino, permitindo que a combinação parte Fiscal +
   destino genérico de tags passasse com Fiscal desligado. Agora verifica
   também os requisitos da parte declarada. O agrupamento legado Resultados
   continua sem criar uma chave adicional.
7. **Objeto do modelo Assistência técnica trocado no registro.** A publicação
   criava uma cópia com versão 2; o objeto exportado ainda dizia versão 1. A
   versão publicada agora pertence à própria definição, e o catálogo registra
   a mesma referência. Nenhum tipo de trabalho ou concessão foi acrescentado.
8. **Checagem assíncrona antes do transporte.** `panelRequestAllowed` fazia
   `import()` a cada requisição, mesmo com o classificador já importado pelo
   painel. A requisição ainda não tinha chegado ao transporte quando o
   hospedeiro suspendia ou trocava de identidade. Isso explica os sinais de
   aborto ausentes e as respostas simuladas destinadas a uma geração sendo
   consumidas pela seguinte nos testes de hospedagem. A checagem agora é
   síncrona e usa o mesmo resolvedor. O sinal combinado é capturado antes de
   qualquer espera e conferido antes do envio e depois da resposta. Um 401
   cancelado não aciona a expiração. A leitura do corpo também fica vinculada
   à geração da requisição, inclusive se a suspensão ocorrer após os cabeçalhos.
   A comprovação local usa novos casos `node:test`, sem executar Vitest.
9. **Acesso à manutenção na entrada somente cadastral.** Foi incluído um
   atalho nas preferências da Base, além da entrada já existente na casa e do
   vínculo em documentos. Assim, abrir diretamente Clientes não exige conhecer
   a URL de manutenção quando a origem comercial estiver desligada.

### Alterações por arquivo

Os caminhos desta tabela são relativos à raiz do repositório. Ela descreve o
conjunto final da tarefa, inclusive o trabalho anterior a esta rodada.

| Arquivo | Alteração |
|---|---|
| `src/erp/schema/deviations.ts` | Catálogo informativo `ERP_PART_BEHAVIORS`, com condição, regra, motivo e referências a testes; separado de `ERP_DEVIATIONS`. |
| `src/erp/schema/structural.ts` | Registro estrutural das nove partes, envelope/KV, manutenção e ausência de mudança no esquema ERP. |
| `tests/erp/harness/dual-fixture.mjs` | Diferencial com as nove partes explicitamente ligadas. |
| `tests/erp/unico/f2-paridade.test.mjs` | Separação dos catálogos, ausência versus mapa completo, igualdade de DTOs/erros/tabelas e execução diferencial no Postgres local. |
| `tests/erp/unico/f2-aceite.test.mjs` | Inventário de rotas/RPCs, parâmetros camelCase, transporte/privacidade/cadastro técnico, matriz de postagem, parsers, replay e manutenção HTTP de efeitos históricos com versões. |
| `tests/f2-aceite.test.ts` | Demonstração real, navegação, batch D1/envelope/KV, aplicação, sistema e referência persistida suspensa. Escrito para a verificação externa, sem execução Vitest local. |
| `src/modules/erp/identity.ts` | Fotografia adiantada na consulta de pessoas do lote de autenticação; linha de controle independente da existência de pessoas, sem projetá-la como membro. |
| `src/modules/erp/parts-state.ts` | Decodificação compartilhada da fotografia e envelope aplicado pelo próprio RPC, conservando revisão/validade e ACK separado das entregas explícitas. |
| `src/erp/api/local-fetch.ts` | Uso da fotografia autenticada, transporte de partes e privacidade, portão obrigatório do cadastro técnico e bloqueio de partes também no armazenamento. |
| `src/erp/blocks.ts` | Famílias fiscais adicionais, aliases legados, rotas conhecidas e reconhecimento completo de parâmetros de rota. |
| `src/erp/parts-requirements.ts` | Alias `/visao-geral` na Base no resolvedor compartilhado. |
| `src/erp/engine/parts-gate.ts` | Inspeção somente de leitura com versão da origem, versões atuais dos títulos de nota e sequência da remessa. |
| `web/erp/modules.ts` | Uso do alias comum e conferência conjunta da parte declarada e do destino. |
| `web/erp/fetch-port.ts` | Comparação efetiva das nove autorizações, posse compartilhada, proteção de resposta extraída, checagem síncrona antes do envio e aborto da geração também antes de processar 401 e ao ler o corpo. |
| `web/erp/host-runtime.tsx` | Publicação/invalidação das nove partes e posse do contexto pelo hospedeiro. Este é o consumidor extraído de `mount.tsx` pela frente da casa única, cujo trecho de hospedagem é tratado em B16. |
| `web/erp/ErpArea.tsx` | Usa e reexporta a proteção compartilhada de resposta sem depender da exportação do adaptador de transporte. |
| `web/management/context-response.ts` | Implementação compartilhada da revogação de respostas já recebidas. |
| `web/erp/app/lib/origin-menu.ts` | Atalho para manutenção nas preferências da Base, sem reclassificar os itens legados. |
| `web/erp/app/components/ErpEffectMaintenance.tsx` | Consome versões dos títulos e sequência de remessa; conserva a recusa quando faltam dados obrigatórios. |
| `web/erp/test/f2-parts.test.mjs` | Aceitação de versões na manutenção, contexto encerrado, revogação/retomada, corpo de prefetch e atalho da Base; regressões novas de envio imediato, 401 antigo, troca de identidade com dois hospedeiros e suspensão após os cabeçalhos. A contagem de chamadas aguarda a revalidação de permissões terminar, mantendo a asserção de zero envio da operação suspensa. |
| `web/erp/blocks.test.mjs` | Registra as famílias fiscais na fotografia aditiva e confere sua recusa por parte desligada, preservando os cortes externos e o inventário antigo. |
| `web/erp/ORIGEM.json` | Registra as adaptações reais do painel e os arquivos novos; não altera os hashes de origem para esconder divergência. |
| `web/lib/demo.ts` | Estado explícito das cinco novas partes; catálogo de módulos com nomes, descrições e dependências reais; Fiscal/Cobrança permanecem desligados e PDV ligado. |
| `src/area-templates/index.ts` | Registra diretamente a definição publicada de Assistência técnica. |
| `src/area-templates/models/assistencia-tecnica.ts` | Versão 2 na definição publicada, correspondente à adaptação da fase 2. |
| `tests/erp-module-helper.ts` | Preparação comum `enableErpParts` e `ERP_CORE_TEST_MODULES`, equivalente à migração do núcleo antigo. |
| `tests/c-hospedagem.test.ts` | Somente preparação dos módulos de hospedagem, suspensão e retomada. |
| `tests/c-telas.test.ts` | Somente preparação do núcleo completo para as telas antigas. |
| `tests/erp-do-api.test.ts` | Somente ativação das partes usadas pela prova de leitura/escrita real. |
| `tests/erp-do-cnab-gate.test.ts` | Somente preparação das dependências do CNAB. |
| `tests/erp-do-hops.test.ts` | Somente preparação das partes usadas pela prova de uma ida ao objeto. |
| `tests/erp-do-module.test.ts` | Somente preparação da instalação antiga com núcleo completo. |
| `tests/erp-do-pdv-gate.test.ts` | Somente preparação das dependências do PDV. |
| `tests/erp-painel-rotas.test.ts` | Somente preparação das partes consumidas pelas rotas do painel. |
| `tests/erp-storage.test.ts` | Somente preparação das dependências ao ligar Cobrança; os usos antigos sem fotografia permanecem pendentes. |
| `tests/f1-erp-bridge.test.ts` | Somente o caso que consulta listas comerciais/financeiras liga essas partes; os casos do cadastro técnico continuam somente com Base. |
| `tests/management-navigation.test.ts` | Somente preparação de partes nos cenários de papéis Consulta e Financeiro. |
| `tests/management-ported.test.ts` | Somente preparação do antigo núcleo completo nos cenários de política portada. |
| `docs/ERP-FASE0.md` | Referência ao contrato final das partes e ao catálogo informativo. |
| `docs/ERP-AGENDADOR.md` | Estado explícito, TTL, revisões, entrega/ACK, cron, alarmes e limites de consistência. |
| `docs/ERP-FASE2.md` | Contrato integrado, manutenção, limites de A7/A8 e este relato consolidado. |

### Preparações alteradas em testes antigos

Não foram alteradas as asserções dos arquivos abaixo. As linhas indicam a
preparação na árvore atual; imports dos ajudantes também foram ajustados.

| Arquivo | Linhas de preparação |
|---|---|
| `tests/c-hospedagem.test.ts` | 81, 97, 117, 215, 225 |
| `tests/c-telas.test.ts` | 156 |
| `tests/erp-do-api.test.ts` | 47 |
| `tests/erp-do-cnab-gate.test.ts` | 41 |
| `tests/erp-do-hops.test.ts` | 27 |
| `tests/erp-do-module.test.ts` | 68 |
| `tests/erp-do-pdv-gate.test.ts` | 37 |
| `tests/erp-painel-rotas.test.ts` | 204 |
| `tests/erp-storage.test.ts` | 127, 301 |
| `tests/f1-erp-bridge.test.ts` | 381 — apenas o cenário de listas comerciais/financeiras |
| `tests/management-navigation.test.ts` | 175, 180 |
| `tests/management-ported.test.ts` | 75, 131, 191 |

`tests/erp-identity.test.ts`, `tests/c-fronteira-erp.test.ts` e
`tests/c-cadastro.test.ts` permanecem sem alterações. A mudança anterior em
`web/erp/blocks.test.mjs` é a exceção expressamente pedida no Acréscimo 3:
classificação fiscal passa a existir, mantendo a prova de recusa.

### Verificação desta rodada

<!-- F2_VALIDATION_RESULTS -->
| Comando | Resultado | Evidência local |
|---|---|---|
| `npm run check` | Aprovado, saída 0: marcadores, UTF-8, CSS e TypeScript. | `.f2-check-current.log` |
| `npm run build` | Aprovado, saída 0; avisos de diretivas de dependências do React Router. | `.f2-build-current.log` |
| `npm run test:erp:painel` | **2.236 aprovados, zero falhas, zero cancelados, zero pulados**, saída 0. Inclui os três novos casos, orçamento inicial, manifesto e textos de tela. | `.f2-painel-current.log` |
| `node --test tests/erp/blocks.test.mjs tests/erp/unico/f2-aceite.test.mjs tests/erp/unico/f2-paridade.test.mjs` | **17 aprovados, zero falhas, zero pulados**, saída 0, incluindo diferencial contra Postgres local. | `.f2-motor-current.log` |
| `npm run test:erp` — rodada anterior | **1.026 aprovados, zero falhas, zero pulados, 1 TODO preexistente**; 1.027 casos contabilizados. Não repetido integralmente nesta rodada: não houve mudança no motor, no oráculo ou no diferencial; o aceite focal foi repetido. | `.f2-erp-final.log` |
| `git diff --check` | Aprovado, saída vazia e código 0. | Saída local. |
| Vitest / Worker Cloudflare | **Não executado**, por instrução explícita. O último resultado externo é 278 arquivos/2.961 casos aprovados e 14 arquivos/28 casos reprovados; antecede a correção do transporte desta rodada. | `.codex-verificacao.log` |

O TODO já consta no `HEAD`, em
`tests/erp/fagoo/finance-invoice-postings-sql.test.mjs:282`, no caso
“248 pedido de compra Em aberto lança contas and still moves on to Em andamento”.
O arquivo e essa marcação não foram alterados. Não foi criado TODO para
ocultar falha nesta tarefa. O ciclo integral anterior do motor levou cerca de
16 minutos e 18 segundos, sem casos cancelados.

Na primeira execução focal desta rodada, a redução de esperas revelou uma
corrida no teste novo de contagem de chamadas: a revalidação de permissões
após a retomada ainda estava em voo. O teste agora espera essa revalidação
terminar antes de contar as chamadas da operação suspensa; conserva todas as
asserções e acrescenta a comprovação de permissões prontas. A primeira versão
do novo caso de envio imediato também tentava repetir uma verificação já
satisfeita pelo cache; sua preparação passou a iniciar a primeira verificação.
Nenhum teste Vitest antigo foi alterado nesta rodada.
<!-- /F2_VALIDATION_RESULTS -->

### Pedidos à base e decisões pendentes

Há uma correção de produção identificada **fora da matriz autorizada**:
`src/access.ts:routeAccess` devolve `erp-fiscal` como item de acesso para as
rotas do emissor/cofre. Os papéis continuam somente em `erp`, portanto uma
pessoa com `erp:consulta` é recusada antes de chegar ao leitor do emissor.
O ajuste proposto mapeia os proprietários das nove partes para o item de
acesso `erp`; o portão de ativação continua verificando a parte proprietária.
A proposta concreta está em [f2-access.patch](/private/tmp/f2-access.patch), ainda não aplicada.
Foi solicitada autorização porque a [Parte B da tarefa](/Volumes/Dev/wabotia/tarefas/f2-aceite.md:700) afirma: “Os arquivos citados como
evidência fora da matriz são somente leitura.”

O patch de acesso foi novamente conferido com `git apply --check` e a exceção
foi solicitada nesta rodada; sem resposta, não está aplicado. Essa é uma
regressão de produção, não uma expectativa obsoleta de teste.

A regra do Acréscimo do orquestrador permite nos testes antigos somente
alterar a preparação que liga módulos, para os casos que antes ligavam só
`erp` e consumiam outras partes. O [Acréscimo do orquestrador](/Volumes/Dev/wabotia/tarefas/f2-aceite.md:73) diz: “não pode alterar as asserções, nem
o que o teste confere, nem apagar caso”. Essa autorização não cobre trocar
expectativas de proprietários, cardinalidade, códigos HTTP, cron ou envelopes
internos. A exceção para adequar esses contratos, mantendo os casos e suas
proteções, foi solicitada nesta rodada e permanece sem resposta. Os casos
abaixo não foram afrouxados para apresentar a suíte verde.

### Destino das 28 falhas do último log externo

A contagem é do log recebido, não uma previsão do resultado após a correção.
A coluna final distingue regressão tratada, contrato incompatível e defeito
fora da matriz. Cada um dos 14 arquivos reprovados está representado.

| Arquivo | Casos no log | Diagnóstico e situação atual |
|---|---:|---|
| `area-template-juridico.test.ts` | 2 | Exige ausência de `juridico` em Advogados e Escritório de advocacia; A8 exige ativar Jurídico com OS. Corrigir o produto para satisfazer a asserção contrariaria o modelo contratado. Intacto. |
| `c-fronteira-erp.test.ts`, P11 | 1 | O segundo envelope direto, com `people: null`, omite `parts` e `partsControl`. A6 exige 503; o teste espera a validação de vendedor técnico dentro do motor. Precisa carregar a fotografia na preparação do envelope, conservando `people: null`, a recusa e o rollback. Isso excede a exceção atual de ligar módulos. Intacto. |
| `c-hospedagem.test.ts` | 3 | A espera no classificador foi removida: envio imediato, aborto e 401 antigo têm regressões locais aprovadas. Há ainda uma incompatibilidade posterior no terceiro caso: a linha 291 chama `/v1/cadastros/negado`, rota inexistente, esperando o 403 do transporte simulado. O portão bloqueia essa rota antes do transporte; é preciso autorizar a troca do endereço sintético por uma rota válida, preservando a asserção 403 e a revalidação. Não foi alterado. |
| `c-taxonomias.test.ts` | 3 | Exige Produtos = `erp`, Financeiro somente com Base e 403 para operação de parte desligada; A2/A4/A5 exigem proprietário específico e 409. O caso HTTP interno também omite fotografia e lê `items` do erro 503. Os cenários de recusa e de não mutação precisam permanecer ao atualizar o contrato. Intacto. |
| `erp-cron-scheduled.test.ts` | 1 | Observa `erp_blocks` e só aceita wake no início da hora. A7 usa fotografia revisionada e renovação a cada cinco minutos, inclusive desligamentos. Intacto. |
| `erp-do-emissor-route.test.ts` | 1 | Regressão confirmada em `src/access.ts`: `erp:consulta` é recusado pelo proprietário `erp-fiscal`, embora os papéis pertençam à Base. Patch pronto, fora da matriz, aguardando autorização explícita. |
| `erp-do-instance.test.ts` | 2 | Chama `/erp-wake` sem fotografia. A6 exige falhar fechado; a preparação precisa entregar estado explícito antes de provar o isolamento do D1 e os alarmes. Não foi aberto fallback. Intacto. |
| `erp-do-rpc-system.test.ts` | 1 | Envia apenas `SYSTEM_HEADER`. A6 exige também fotografia. Deve conservar a prova da marca interna, fornecendo o envelope completo no caso autorizado. Intacto. |
| `erp-storage.test.ts` | 2 | Os casos antigos de anexos não fornecem fotografia nem autorização do RPC para o objeto exato; o caso direto espera 415 antes de fornecer autorização válida e recebe 503. Não foi eliminado o portão do R2. As ativações de dependências feitas na rodada anterior foram mantidas; o restante precisa de atualização autorizada da preparação/expectativas. |
| `management-catalog.test.ts` | 5 | Exige prefixo do ID igual ao novo proprietário, todos os itens em `erp`, 43 contribuições e apenas a declaração `erp` contribuindo. A2/A5 preservam IDs, distribuem proprietários e acrescentam manutenção. A projeção legada mantém 43 destinos e a casa tem 44. Intacto. |
| `management-lifecycle.test.ts` | 3 | A revogação da leitura atrasada recebe a correção do transporte e cobertura local. Os outros dois casos exigem seletor para extensões nativas e Produtos com apenas `erp`, contrariando a entrada nativa de A5 e a separação de A2. Intacto. |
| `management-navigation.test.ts` | 1 | Exige seletor com várias extensões nativas, enquanto A5 determina abrir destino nativo elegível sem montar o portado. Intacto nesta rodada; mantém somente os ajustes anteriores de preparação dos papéis Consulta/Financeiro. |
| `management-ported.test.ts` | 2 | A espera antes do envio deixava a resposta simulada destinada à leitura anterior ser consumida pelo `/me` da nova identidade; o caso seguinte herdava a fila de respostas simuladas. O envio síncrono remove essa causa. O novo teste local cobre troca de ator, aborto, descarte do hospedeiro antigo e posse compartilhada. Ainda requer nova execução externa desses casos. |
| `os-integration.test.ts` | 1 | `os-integration-fixture.ts:282` exige `os_work_types.length` e depois OS ligado em todos os modelos. Restaurante de A8 usa `pedido`/`queue`, sem impor OS. Acrescentar OS ao modelo só para satisfazer esse ajudante mudaria o produto. Intacto. |

O log atual já não lista as falhas anteriores de `erp-identity`,
`erp-do-cnab-gate`, `f1-erp-bridge`, `f2-aceite` ou `os-area-templates`.
Isso é evidência do resultado externo recebido, não execução de Vitest
nesta rodada. Não se declara encerrado o aceite enquanto existirem as
incompatibilidades acima e a regressão de acesso não aplicada.

### Fora da entrega e dúvidas

- A aprovação integral exige nova execução externa de Vitest, depois de resolver
  as decisões acima. Não foi usado outro runner para disfarçar essa execução.
- A matriz não autoriza a correção de `src/access.ts`; a proposta não foi aplicada
  sem resposta. Não há autorização presumida pelo silêncio.
- O tratamento das asserções incompatíveis continua pendente: atualizar seus
  contratos mantendo os cenários e as proteções, ou registrar formalmente a
  incompatibilidade com o critério de suíte inteira verde.
- As limitações operacionais de A7/A8 descritas acima permanecem: sem transação
  distribuída, sem recomposição retroativa e sem ponte operacional automática
  de `os`/`pedido` para os domínios do ERP. Ligar Fiscal não instala emissor.
- Não foi feita validação visual em navegador nem chamada a serviço externo.
  Os testes do painel usam controladores, roteadores e componentes locais.

## Fechamento autorizado — f2-aceite2, 19/11/2026

Base recebida: `585bb741`. A última verificação externa desta base aprovou
`check`, `build`, `test:erp` e `test:erp:painel`; no Vitest foram **279 arquivos
e 2.966 casos aprovados, 13 arquivos e 23 casos reprovados**. Este resultado
é o ponto de partida de `f2-aceite2`, posterior ao log histórico de 28 falhas.
O retorno externo mais recente, em `.codex-verificacao.log`, já contém
**290 arquivos e 2.993 casos aprovados, dois arquivos e dois casos reprovados**:
cron e armazenamento. O recorte recebido não repete os resultados dos outros
comandos. As causas e correções dessas duas falhas estão incorporadas abaixo,
junto com todas as alterações anteriores desta tarefa.
**A suíte integral da árvore agora corrigida ainda depende de novo resultado externo.**
Não foi executado Vitest nem Wrangler, inclusive por outro runner.

As duas exceções foram aplicadas dentro dos limites concedidos. Não houve
commit, push, troca de branch, acesso à rede, migração, alteração de DDL,
semente, oráculo, teste de origem ou orçamento inicial do painel. Nenhum caso
foi apagado, pulado, marcado TODO ou esvaziado. Os três arquivos de transporte
da integração anterior (`local-fetch.ts`, `identity.ts`, `rpc-endpoint.ts`)
foram relidos; somente a recusa de armazenamento em `local-fetch.ts` precisou
de correção adicional. A fotografia convive com a restrição de privacidade
e com a capacidade técnica limitada do cadastro; não foi introduzido fallback.

### Correções de produto

- `src/access.ts`: somente o import de `ERP_MODULE_IDS` e a expressão de
  retorno de `routeAccess` autorizados. Rotas das partes exigem o acesso
  `erp`; a ativação continua verificando a parte dona. A rota nativa
  `service-orders`, cujo dono é `os`, conserva o acesso `os`.
- `src/modules/erp/panel-menu.ts`: oito `primary: true` explícitos nas
  contribuições Produtos, Contas Financeiras, Pedidos de venda, Notas fiscais
  de saída, Frente de caixa, Pedidos de compra, Lançamentos de estoque e
  Remessas e retornos. A separação dos donos deixara essas oito declarações
  sem primary. A asserção de **exatamente um primary por módulo não mudou**.
  IDs, destinos, ordem, ícones, rótulos e permissões foram conservados.
- `src/erp/engine/parts-gate.ts`: a taxonomia resolve também o pai persistido,
  o recibo do mesmo ator e a auditoria da exclusão. Antes, tipo fiscal
  explícito/presente recebia 409, mas inclusão herdada e replay após exclusão
  podiam cair na recusa legada 403. Todos esses caminhos agora identificam a
  parte Fiscal suspensa antes da operação e devolvem `module_disabled`.
  Não altera gravação, hash, recibo nem o comportamento todo ligado.
- `src/erp/api/local-fetch.ts`: a recusa das partes no armazenamento agora
  interrompe o adaptador com `ApiError`, depois de registrar `partsDenied`
  quando houver coletor. O adaptador CNAB portado aceita qualquer 400/409
  como possível duplicação de chave imutável e só verifica bytes numa leitura
  posterior. Por isso `storeFile` resolvia sem gravar ao receber
  `409 module_disabled`, contrariando a prova de recusa. A costura distingue
  `module_disabled`/`erp_parts_unavailable`/`erp_parts_stale` de `Duplicate`,
  inclusive sem coletor. `erpStorage` continua respondendo 409/503 e a API
  pública conserva esses códigos; duplicação verdadeira continua idempotente.
  O adaptador CNAB de origem, fora da matriz, permanece intacto.

### Causa do cron e do erro de I/O no retorno externo

O `scheduled` real executa tanto `wakeErpAreas` quanto
`resumeCustomerMaintenance`. Uma área recém-criada, sem checkpoint de
reconciliação, chama `erpBridge.scan` por esse segundo caminho. Isso carrega
o motor legitimamente; não é uma carga causada pela entrega da fotografia.
A preparação agora registra `erp.contacts.scan.v1` concluído e fresco antes
de :35 e :40. Assim, o caso de renovação isolada mantém **zero** cargas nas
três passagens, sem retirar nenhuma rotina do `scheduled` nem substituir a
reconciliação por mock. Desligamento pendente, ACK, TTL, revisão, ausência de
esquema e área desligada sem alarme continuam conferidos.

O mock de observação incrementava o contador antes de `importOriginal`.
Esse import usa o RPC do runner Vitest; quando disparado dentro do objeto
pela varredura, pode falhar com o `RefcountedFulfiller` registrado no log.
O próprio plugin instalado documenta a exigência de contexto do runner em
`node_modules/@cloudflare/vitest-plugin/dist/worker/lib/cloudflare/test-internal.mjs`
(`runInRunnerObject`/`importModule`). O log resumido não traz uma pilha para
atribuir cada ocorrência, portanto a confirmação em Cloudflare ainda é externa.
Após todas as provas de zero carga, o controle positivo importa o módulo
no runner, confere uma carga e faz ping no objeto real, agora também
conferindo a criação do esquema. Não se alterou o carregador de produção
nem se suprimiu erro do runtime.

Uma prova adicional `node:test` instrumenta a avaliação do módulo real:
`ErpHub.handle('/erp-parts')` persiste, renova e desliga sem avaliar o motor;
o alarme com Base desligada também não o avalia. Só o ping de controle
incrementa o contador e alcança a migração. Essa prova roda sem Cloudflare
ou Vitest e complementa o caso integrado.

### Alterações dos testes por arquivo

| Arquivo | Preparação e prova preservada/acrescentada |
|---|---|
| `tests/f2-aceite.test.ts` | Caso novo na API real: pessoa restrita com `erp:consulta` lê o emissor; Fiscal desligado dá 409; sem acesso ERP dá 403; acesso Base sem papel continua insuficiente; OS exige seu próprio item e funciona com ele. |
| `tests/area-template-juridico.test.ts` | Os dois modelos esperam OS e Jurídico. Todos os controles de tipos, menus, departamentos, bot sem operações/papéis sugeridos e passos manuais permanecem. |
| `tests/c-fronteira-erp.test.ts` | P11 conserva `people: null` e carrega o restante do envelope original. Mantém recusa dos dois IDs técnicos e rollback do contato; acrescenta status da segunda recusa. Caso novo sem fotografia verifica 503, opções ausentes, zero consultas no handler e nenhuma gravação em cadastro/vendedor/recibo. |
| `tests/c-hospedagem.test.ts` | Somente a URL sintética da chamada muda para `/v1/cadastros/contatos`; 403 e revalidação posterior continuam iguais. |
| `tests/c-taxonomias.test.ts` | Produtos explícito na preparação do painel; donos e requisitos separados; helper de recusa exige 409 e código `module_disabled`. A chamada HTTP interna recebe a identidade completa, conservando a falta das marcas combinadas; recusa e igualdade das sete tabelas são conferidas. Caso novo sem fotografia exige 503, ausência de dados/resultados, zero consultas no handler e tabelas intactas. |
| `tests/erp-cron-scheduled.test.ts` | Usa KV `erp_parts`, clock controlado e o `scheduled` real em :35/:40/:45. Prepara reconciliação cadastral concluída/fresca em :35/:40 para medir somente renovação. Confere TTL sem nova revisão, alarme futuro preservado, desligamento pendente entregue/confirmado e área desligada sem alarme nem esquema. Observa o import real: zero cargas nas passagens; controle positivo no runner ao final, seguido de ping e esquema no objeto. |
| `tests/erp-do-instance.test.ts` | Os dois casos de alarme ligam Base e entregam fotografia por `syncErpParts` antes do wake. As asserções antigas de D1, inbox/outbox, separação da área e alarmes permanecem. Caso novo sem fotografia exige 503, nenhum esquema/dado ERP e nenhum alarme, inclusive após `alarm()`. |
| `tests/erp-do-rpc-system.test.ts` | Fotografia completa nas chamadas antigas de RPC, inclusive na chamada direta do agendador; ausência da marca interna continua 403. Caso novo: marca sozinha não autoriza, 503 sem claim, alarme, leitura SQL ou R2. O nome desconhecido continua 404. |
| `tests/erp-storage.test.ts` | `ports` recebe `erpIdentity`; novas requisições após alternar Cobrança recebem fotografia nova. Anexo usa contato/documento/reserva e autorização do objeto exato por RPC real; antes dessa autorização o upload é recusado. O prazo do primeiro caso passa a 60 s por incluir inicialização do motor. A chamada direta de storage recebe fotografia fresca; MIME e assinatura usam origem válida e autorização de chave específica. Isolamento, bytes, duplicação, CNAB, links, limites e multipart permanecem; recusas preservam objetos históricos. Caso novo exige 503 antes de qualquer método R2. |
| `tests/management-catalog.test.ts` | Preserva 43 destinos da projeção legada e confere a 44ª contribuição de manutenção separadamente; distribui donos pelas nove partes. Unicidade de IDs/destinos, grupos, ordem explícita e exatamente um primary permanecem. |
| `tests/management-lifecycle.test.ts` | Várias extensões nativas resolvem Trabalhos; somente Base abre Clientes e não expõe Produtos. Conserva zero import/prefetch do portado nos estados nativos/negados. |
| `tests/management-navigation.test.ts` | Somente a expectativa de destino com OS + Agenda muda para Trabalhos; os demais controles de elegibilidade/ativação/permissão permanecem. |
| `tests/os-integration-fixture.ts` | O ajudante confere cada módulo declarado. Modelos com OS continuam conferindo quantidade, validação integral e ausência de `service_order` na lista personalizada. Restaurante exige `pedido`/`queue`, OS desligado e ausência de tipos OS; prévia sem mutação, replay e reaplicação idempotente permanecem. |
| `tests/erp/unico/f2-aceite.test.mjs` | Três casos novos executáveis sem rede: pai fiscal e recibos de inclusão/edição/exclusão recusados sem mudar sete tabelas, com replay original após religar; CNAB real recusa Cobrança/Financeiro desligados com/sem coletor, sem gravar nem mudar bytes históricos, e preserva duplicação legítima; hub real persiste/renova/desliga antes de avaliar o motor, com ping de controle positivo. A costura/hub são compilados por esbuild em diretório temporário removido ao final; não é runner alternativo de Vitest. Nenhuma asserção antiga foi alterada. |
| `docs/ERP-FASE2.md` | Preserva o relato anterior como histórico e registra o diff, cada asserção alterada e os limites desta verificação. |

`tests/erp-do-emissor-route.test.ts` permanece intacto: sua falha é tratada no
produto. `tests/erp-identity.test.ts`, testes de fase 1 não citados acima,
oráculo e diferencial existente permanecem intactos.

Referências da preparação dos casos antigos nesta árvore (as linhas do relato
histórico correspondem à rodada anterior):

| Arquivo | Linhas e preparação |
|---|---|
| `tests/c-fronteira-erp.test.ts` | 207: conserva a fotografia no envelope com `people: null`. |
| `tests/c-hospedagem.test.ts` | 291: URL válida na mesma operação cuja recusa 403 é conferida. |
| `tests/c-taxonomias.test.ts` | 56: Produtos no contexto; 331: identidade completa na fronteira HTTP. |
| `tests/erp-cron-scheduled.test.ts` | 46: checkpoint; 63 e 80: reconciliação fresca; 103: controle de import somente após as provas de zero carga. |
| `tests/erp-do-instance.test.ts` | 13: ajudante que entrega a fotografia antes dos dois wakes. |
| `tests/erp-do-rpc-system.test.ts` | 30–33: fotografia e cabeçalho comum; 84–85: fotografia do RPC comum. |
| `tests/erp-storage.test.ts` | 59: `ports` com identidade; 82: storage direto com fotografia; 103–104: partes; 108–129: contato/documento/reserva/autorização real; 162 e 201: nova requisição após alternar Cobrança; 332 e 435: origens válidas para MIME e assinatura. |

### Registro de cada asserção antiga alterada

As linhas abaixo incluem mudança de argumento ou do conjunto percorrido,
mesmo quando o matcher e o valor esperado permanecem. Casos novos e
asserções somente acrescentadas estão registrados na tabela seguinte.

| Arquivo | Caso | O que conferia | O que confere agora | Cláusula |
|---|---|---|---|---|
| `tests/area-template-juridico.test.ts` | Referências locais dos menus, Advogados e Escritório de advocacia (dois casos) | `modules` não contém `juridico`. | `modules.juridico === true`; `os === true` permanece. O nome dos casos foi atualizado. | A8 |
| `tests/c-hospedagem.test.ts` | Ignora permissão atrasada após suspensão/área trocada e revalida após 403 | Chamada a `/v1/cadastros/negado` rejeita com status 403. | Chamada à rota válida `/v1/cadastros/contatos` rejeita com o mesmo status 403; revalidação intacta. | A4; autorização 2.6 |
| `tests/c-taxonomias.test.ts` | Produtos, contatos, listas mistas e exceções de destino conservam seu acesso | Todo alias/tipo tem dono `erp`. | Tipo `produtos` tem dono `erp-produtos`; contatos e lista mista conservam `erp`. | A2/A5 |
| `tests/c-taxonomias.test.ts` | Mesmo caso, borderôs | Base sozinha permite destino Financeiro. | Base sozinha não permite borderôs; caso adicional confirma com Financeiro. | A2/A5 |
| `tests/c-taxonomias.test.ts` | Mesmo caso, meu contador | Base sozinha permite preferência contábil. | Exige Financeiro, com prova positiva adicional. | A5, preferências |
| `tests/c-taxonomias.test.ts` | Omite notas, recusa tipo explícito/herdado e operações por ID… (`denied`, em todas as chamadas) | Status 403. | Status 409 e código `module_disabled`; ausência de item/deleted/replayed e igualdade das sete tabelas permanecem. | A4/A6 |
| `tests/c-taxonomias.test.ts` | Recibos fiscais de inclusão, edição e exclusão não vazam… (`denied`, três chamadas) | Status 403 para replay fiscal suspenso. | Status 409 e código `module_disabled`; replay de produtos/contatos, restauração fiscal e não mutação permanecem. | A4/A6 |
| `tests/erp-cron-scheduled.test.ts` | Antigo “acorda só no primeiro disparo da hora…” — estado inicial | `erp_blocks` ausente após ping. | `erp_parts` ausente nos dois objetos antes da primeira passagem, sem ping que carregaria motor. | A6/A7 |
| `tests/erp-cron-scheduled.test.ts` | Mesmo caso — disparo fora de :00 | `erp_blocks` continua ausente em :35. | :35 entrega fotografia e alarme apenas à área ligada; :40 renova validade, conserva revisão e alarme futuro, sem carregar motor. | A7 |
| `tests/erp-cron-scheduled.test.ts` | Mesmo caso — entrega à área ligada | `erp_blocks` truthy em :00. | Fotografia completa com Base ligada e validade exata; confirma ACK, renova em cinco minutos e depois entrega revisão maior com Base desligada. | A7 |
| `tests/erp-cron-scheduled.test.ts` | Mesmo caso — área desligada | `erp_blocks` sempre ausente. | Recebe seu desligamento pendente, permanece sem alarme/esquema/trabalho e não é renovada após ACK; desligamento posterior da outra área também cancela o alarme. | A7 |
| `tests/erp-storage.test.ts` | Anexos e CNAB… — outra área | Download do mesmo caminho em outra área retorna 404. | Retorna 403 por falta de autorização do objeto exato; também confere ausência física na outra área. | A4/A6 |
| `tests/erp-storage.test.ts` | Anexos e CNAB… — Cobrança desligada | GET direto de CNAB retorna 403. | Retorna 409; adaptador continua rejeitando e bytes anteriores permanecem iguais. | A4/A6 |
| `tests/erp-storage.test.ts` | Recusa bucket/caminho/tipo/tamanho… — MIME | Caminho `erp-attachments/a.html` retorna 415. | Origem válida `erp-attachments/company/a.html`, fotografia e autorização exata retornam o mesmo 415; objeto não é criado. | A4/A6 |
| `tests/erp-storage.test.ts` | Mesmo caso — POST nos dois buckets fiscais | Status 403 com Fiscal desligado. | Status 409; objeto ausente continua ausente. | A4/A6 |
| `tests/erp-storage.test.ts` | Mesmo caso — GET nos dois buckets fiscais | Status 403 com Fiscal desligado. | Status 409; não entrega dados. | A4/A6 |
| `tests/erp-storage.test.ts` | Mesmo caso — DELETE nos dois buckets fiscais | Status 403 com Fiscal desligado. | Status 409; provas adicionais verificam preservação de objetos históricos em GET/PUT/DELETE. | A4/A6 |
| `tests/erp-storage.test.ts` | Mesmo caso — assinatura de anexo | `sign("erp-attachments/nada.pdf", 120)` retorna 403. | Origem válida `company/nada.pdf` com autorização exata retorna o mesmo 403; assinatura continua exclusiva de exportações. | A4/A6 |
| `tests/management-catalog.test.ts` | IDs/destinos únicos, grupos consistentes e ordem explícita | Prefixo do ID coincide com `item.module` em todos os itens. | Prefixo portado permanece `erp.` apesar do novo dono; nativos conservam prefixo do módulo. | A2/A5, preservar IDs |
| `tests/management-catalog.test.ts` | Preserva todos os destinos portados… — quantidade | Catálogo tem exatamente os 43 itens legados. | Tem os 43 legados mais uma contribuição de manutenção, explicitamente conferida. | A4/A5 |
| `tests/management-catalog.test.ts` | Mesmo caso — sequência de destinos | Todos os destinos equivalem à sequência legada. | Os 43 destinos legados continuam exatamente na mesma sequência; manutenção é conferida à parte. | A4/A5 |
| `tests/management-catalog.test.ts` | Mesmo caso — dono de cada contribuição | Todo `item.module` é `erp`. | Dono corresponde ao mapa comum `ERP_PART_OWNERS[item.part]`; manutenção pertence à Base. | A2/A5 |
| `tests/management-catalog.test.ts` | Mesmo caso — rótulo | Comparação de rótulo com a entrada legada, percorrendo todo o catálogo. | Mesma comparação em todos os 43 itens legados; o item novo não tem equivalente legado. | A5 |
| `tests/management-catalog.test.ts` | Mesmo caso — permissão | Comparação exata com papéis/recurso legado, percorrendo todo o catálogo. | Mesma comparação nos 43 legados; permissão da manutenção é explicitamente `kind: erp`. | A4/A5 |
| `tests/management-catalog.test.ts` | Mesmo caso — parte válida | Lista de partes admitidas aplicada a todo o catálogo. | Mesma conferência nos 43 legados; manutenção confere especificamente `part: sistema`. | A5 |
| `tests/management-catalog.test.ts` | Classifica explicitamente sem depender do rótulo apresentado | Todo item precisa aparecer no menu de compatibilidade com seu grupo. | Os 43 itens de compatibilidade conservam grupo mesmo com rótulo traduzido; manutenção tem grupo Sistema próprio, conferido separadamente. | A4/A5 |
| `tests/management-catalog.test.ts` | Vincula cada contribuição à declaração… | Contribuintes são nativos + `erp`. | Contribuintes são nativos + os nove IDs ERP; igualdade por dono e exatamente um primary permanecem sem alteração. | A2/A5 |
| `tests/management-catalog.test.ts` | GET /modules acrescenta management… | `erp` desligado contém o catálogo ERP inteiro. | Cada uma das nove partes desligadas contém exatamente suas contribuições. | A2/A5 |
| `tests/management-lifecycle.test.ts` | Administrador vazio… só Agenda… e vários módulos… | Com OS + Agenda, markup mostra “Escolha um módulo”. | Resolve `/app/erp/modulos/trabalhos` e markup de redirecionamento “Abrindo a gestão”; zero import/prefetch permanece. | A5, entrada nativa |
| `tests/management-lifecycle.test.ts` | Antigo “só Cadastro é contribuição isolada futura…” | Base sozinha inclui `erp.products`. | Base sozinha não inclui Produtos e abre Clientes; caso positivo adicional liga Produtos. | A2/A5 |
| `tests/management-navigation.test.ts` | Conta módulos, incluindo configurações e tipos… | Landing com OS + Agenda é `null`. | Landing é `/app/erp/modulos/trabalhos`; os demais destinos/configurações continuam conferidos. | A5 |
| `tests/os-integration-fixture.ts` | `applyRegisteredTemplate`, quantidade de tipos | Todo modelo tem `os_work_types.length === work_types.length`. | Mesma igualdade para todos os modelos com OS; Restaurante declara zero tipos e não grava `os_work_types`. | A8 |
| `tests/os-integration-fixture.ts` | Mesmo ajudante, validação dos tipos | `validateWorkType(type)` é idêntico a cada tipo de todo modelo. | Mesma validação integral dos modelos com OS; Restaurante confere ausência de tipos. | A8 |
| `tests/os-integration-fixture.ts` | Mesmo ajudante, tipo embutido | Nenhum modelo grava `service_order` na coleção personalizada. | Mesma prova para OS; Restaurante não cria sequer a coleção personalizada. | A8 |
| `tests/os-integration-fixture.ts` | Mesmo ajudante, módulos | Todo modelo termina com `os === true`. | Todos os módulos declarados coincidem com o manifesto; OS continua true nos modelos OS, Restaurante mantém OS false e Pedido/Fila true. | A8 |

### Asserções adicionais, sem substituição das antigas

| Arquivo/caso | Novas conferências | Contrato |
|---|---|---|
| `tests/f2-aceite.test.ts`, papel da Base | 200/configuração ausente no emissor, 409/código ao desligar Fiscal, 403/códigos sem acesso ou sem papel, dono/acesso OS independente e 200 com acesso OS. | A2/A4/A6; autorização 1 |
| `tests/c-fronteira-erp.test.ts`, P11 existente | Status 400 na segunda recusa técnica. | A6 e preservação da fase 1 |
| `tests/c-fronteira-erp.test.ts`, novo caso sem fotografia | 503/código em leitura e escrita, `users` ausente, zero leitura SQL no handler, tabelas de cadastro/vendedor/comando vazias. | A6 |
| `tests/c-taxonomias.test.ts`, destinos | Produtos desligado impede só o destino de produtos; Financeiro ligado permite borderôs e contador. | A2/A5 |
| `tests/c-taxonomias.test.ts`, `denied` | Código público `module_disabled`, além do status e das provas antigas de não mutação. | A4/A6 |
| `tests/c-taxonomias.test.ts`, fronteira HTTP sem marcas combinadas | Status 400 do RPC com `42501` (a API pública traduz para 403) e igualdade das sete tabelas após cada tentativa. | A6; marca interna preservada |
| `tests/c-taxonomias.test.ts`, novo caso sem fotografia | 503/código, ausência de items/deleted, igualdade das sete tabelas, zero leitura SQL no handler. | A6 |
| `tests/erp-cron-scheduled.test.ts`, cron | TTL, revisões, alarmes, ACK pendente/aplicado, esquema vazio, igualdade da área desligada e contador de import com controle positivo. Nesta continuação acrescentou a contagem após import explícito no runner e a presença de esquema após ping; todas as asserções anteriores, inclusive zero cargas nas passagens, permanecem. | A7 |
| `tests/erp-do-instance.test.ts`, preparação dos dois alarmes | Entrega confirmada (`applied`) antes do wake. | A6/A7 |
| `tests/erp-do-instance.test.ts`, novo caso sem fotografia | 503/código, fotografia ausente, alarme nulo e esquema vazio após wake e alarm. | A6/A7 |
| `tests/erp-do-rpc-system.test.ts`, novo caso sem fotografia | 503/código mesmo com marca, nenhuma tarefa/fotografia/alarme e zero métodos SQL/R2 chamados por export_chunk. | A6 |
| `tests/erp-storage.test.ts`, preparação por RPC | Cada RPC real retorna 200; upload antes da autorização falha sem objeto; chave autorizada é a reservada. | A4/A6 |
| `tests/erp-storage.test.ts`, anexos/CNAB | Outra área sem objeto; CNAB anterior conserva todos os bytes após desligar. | A4/A6 |
| `tests/erp-storage.test.ts`, recusas de armazenamento | MIME/tamanho inválidos não criam objeto; Fiscal desligado não cria nem altera/remove objeto histórico (409/código e bytes iguais). | A4/A6 |
| `tests/erp-storage.test.ts`, novo caso sem fotografia | GET/POST/DELETE dão 503/código e nenhum método R2 é chamado. | A6 |
| `tests/management-catalog.test.ts`, manutenção | Contribuição explícita Base/Sistema, ordem 440, destino `/manutencao-efeitos` e permissão ERP. | A4/A5 |
| `tests/management-lifecycle.test.ts`, entradas | Landing nativa explícita; catálogo inteiro da Base abre Clientes; ligar Produtos expõe sua contribuição. | A5 |
| `tests/os-integration-fixture.ts`, módulos/modelo sem OS | Cada chave corresponde ao manifesto; ramo sem OS é Restaurante, sem tipos, com Pedido e Fila ligados. | A8 |
| `tests/erp/unico/f2-aceite.test.mjs`, taxonomias fiscais | Pai e três recibos recusados em 409/código sem mutação das sete tabelas; após religar, 200/replay sem mutação. | A4/A6/A9 |
| `tests/erp/unico/f2-aceite.test.mjs`, CNAB na costura real | 409/código no armazenamento direto; rejeição do adaptador e do fetch local sem coletor, `partsDenied` preservado com coletor, zero acesso ao D1, nenhuma gravação indevida e bytes históricos iguais com Cobrança ou Financeiro desligados; duplicação verdadeira grava uma vez e permite ler os mesmos bytes. | A4/A6/A9 |
| `tests/erp/unico/f2-aceite.test.mjs`, hub real | Fotografia persistida, TTL renovado sem adiantar alarme, revisão de desligamento preservada, alarme cancelado; contador zero até o ping, depois um e migração alcançada. | A7/A9 |

### Verificação local e limites

<!-- F2_ACEITE2_VALIDATION -->
| Comando/evidência | Resultado na árvore corrigida |
|---|---|
| `npm run check` | Aprovado, saída 0: marcadores, codificação, CSS e TypeScript. `.f2-aceite2-check.log`. O tsconfig verifica produto/painel, não os arquivos Vitest. |
| `npm run build` | Aprovado, saída 0; somente avisos sobre diretivas de dependências React Router. `.f2-aceite2-build.log`. |
| `node --no-warnings --test --test-name-pattern='CNAB na costura real\|hub real persiste' tests/erp/unico/f2-aceite.test.mjs` | Dois aprovados, zero falhas/cancelamentos/pulos/TODO. `.f2-aceite2-regressions.log`. |
| `npm run test:erp` | **1.029 aprovados, zero falhas/cancelamentos/pulos e um TODO preexistente**; 1.030 casos contabilizados, saída 0. Inclui diferencial inteiro contra Postgres local e os três casos novos de aceite. `.f2-aceite2-erp.log`. |
| `npm run test:erp:painel` | **2.236 aprovados, zero falhas/cancelamentos/pulos/TODO**, saída 0; inclui manifesto de origem, orçamento inicial e textos. `.f2-aceite2-painel.log`. |
| `git diff --check` | Aprovado, sem problemas de whitespace. |
| Vitest / Cloudflare | Não executado, por instrução explícita. O retorno externo recebido tem 2.993 casos aprovados e dois reprovados, **antes** destas correções. |
<!-- /F2_ACEITE2_VALIDATION -->

Antes da correção de produto, a nova prova de CNAB falhou com
`Missing expected rejection`, reproduzindo o defeito sem Vitest. O primeiro
ensaio do harness precisou ajustar a compilação ESM e a duração dos arquivos
temporários; isso não mudou as expectativas da regressão. O log de reprodução
é `.f2-aceite2-repro.log`; o de aprovação está na tabela. A rodada anterior
de `f2-aceite2` tinha 40 casos distintos focais aprovados (aceite, taxonomias,
paridade, Base e anexos), além de TypeScript e verificações textuais. Essas
contagens anteriores não são somadas às execuções completas atuais.
O único TODO continua sendo o caso “248 pedido de compra Em aberto lança
contas and still moves on to Em andamento”, em
`tests/erp/fagoo/finance-invoice-postings-sql.test.mjs:282`, já presente no
commit base. Nem esse arquivo nem sua marcação foram alterados. A suíte
completa do motor terminou em aproximadamente 12 minutos e 7 segundos.

Cada caso alterado foi relido contra os resolvedores, o transporte, os RPCs,
o armazenamento e a casca que exercita. O novo teste de cron observa o import
do motor com um controle positivo, além da ausência do esquema; sua nova
preparação e o isolamento de I/O no ambiente Cloudflare ainda precisam ser
confirmados externamente. O caso de armazenamento que falhou mantém todas
as asserções: a correção desta continuação está no produto.

Não há pedido adicional de autorização nem pendência de decisão de produto
identificada. As exceções de acesso e testes foram concedidas e aplicadas;
não há novo pedido à base. Fica de fora a execução do Vitest e a confirmação
final do runtime Cloudflare, conforme a regra da tarefa. Não se declara
aceite integral antes do retorno externo verde. Permanecem os limites de
A7/A8 já descritos: sem transação distribuída, recomposição retroativa ou
ponte operacional automática de OS/Pedido para o ERP.

## Correções das revisões

Esta seção registra a integração de `f2-corr-fundo`, `f2-corr-partes` e
`f2-corr-painel` sobre o aceite anterior. As verificações históricas acima
não certificam esta junção; o fechamento depende da cadeia externa inteira.

| Revisão | Correções integradas |
|---|---|
| `f2-corr-fundo` | Cron entrega durante a leitura, com concorrência 4, limite de 100 áreas, orçamento de 45 segundos e continuidade durável no D1. Fotografias têm emissão e margem de relógio; renovação evita gravações redundantes. O hub confere autorização antes de importar/migrar o motor. Fixtures do cron limpam somente suas áreas. |
| `f2-corr-partes` | Atividades são classificadas antes da contagem/paginação. Cadastros, produtos, documentos, fotografias aninhadas e replays omitem campos de partes suspensas e preservam valores, hashes e efeitos armazenados. Adaptadores aceitam apenas ausências declaradas. Financeiro sem Cobrança não consulta nem devolve os detalhes de boleto/remessa. |
| `f2-corr-painel` | Resumo invalida dados antigos quando as partes mudam; demonstração corrige Trabalhos, rotas e coleções; Fiscal começa desmarcado nos cinco modelos. Painel envia os dependentes confirmados e recarrega após conflito. Registro e configurações sincronizam o ERP apenas com revisão pendente. |

Decisões aplicadas neste fechamento:

1. As expectativas dos nove casos de catálogo/documentos passam a exigir
   ausência dos campos suspensos e `unavailable_parts`, com leitura das tabelas
   do motor comprovando preservação integral. Cada caso prova o reaparecimento
   dos valores ao religar. Guardas, recusas de troca/limpeza, histórico,
   idempotência e efeitos anteriores permanecem. O contrato da prévia de cópia,
   que já limpava referências para `null`, foi mantido.
2. `cascade: true` sem `confirmed_dependents` continua desligando os dependentes
   atuais. Com a lista, o conjunto deve coincidir exatamente, sem duplicatas e
   independentemente da ordem; falta, sobra ou tipo inválido retorna
   `409 module_cascade_conflict` antes de qualquer escrita/entrega/evento.
   O campo é opcional na documentação e no OpenAPI; o painel continua enviando-o.
   Nenhum patch que adiciona a lista às chamadas antigas foi aplicado.
3. `erp_document_conversion_preview` classifica a origem por `p_proposal_id`
   como proposta e trata `p_kind` como destino. Ambos os requisitos são
   conferidos, sem comparar o destino com o tipo da origem. O teste percorre
   rota e operação HTTP, portão RPC, leitor e parser para venda e OS; recusa
   parte suspensa/origem incompatível e comprova que a prévia não grava.
4. A janela da atualização foi fechada na própria `0133`, ainda não publicada.
   A tabela D1 `profile_erp_parts_managed` marca áreas geridas pela versão nova.
   `moduleCommand` e `commitSettingsPlan` inserem a marca antes de alterar
   módulos, no mesmo batch; erro reverte ambos. INSERT ligado ou transição
   desligado→ligado do ERP antigo sem marca completa Produtos, Vendas, Compras,
   Estoque e Financeiro, usando os gatilhos de revisão existentes. Fiscal,
   Cobrança e PDV não são ligados. A marca protege escolhas explícitas contra
   reativação antiga e contra reexecução da migração. A preparação compartilhada
   dos testes marca as escolhas novas; os casos de compatibilidade optam pela
   preparação antiga. Não houve migração nova nem alteração no SQLite do ERP.

### Asserções alteradas nos nove casos autorizados

Nos caminhos abaixo, `C` significa `tests/erp/unico/f2-catalogo.test.mjs`
e `D`, `tests/erp/unico/f2-documentos.test.mjs`. “Ausente” usa `Object.hasOwn`,
não igualdade a `undefined`. Toda ausência é acompanhada da indisponibilidade
da parte no registro/documento e da comparação dos valores persistidos;
os dados visíveis que não pertencem à parte continuam sendo conferidos.

| Arquivo / caso | Antes | Agora |
|---|---|---|
| C — produto existente | `p.suppliers[0].supplier_id === supplier.id` | `suppliers` ausente; fornecedores completos iguais no SQLite e após religar. |
| C — produto existente | `page.items[0].cost_price === null` | `cost_price` ausente; custo e histórico preservados. |
| C — produto existente | `exported.items[0].cost_price === null` | `cost_price` ausente; custo e histórico preservados. |
| C — produto existente | `exported.items[0].supplier === null` | `supplier` ausente; fornecedores preservados. |
| C — contato comum | `c.finance_category_id === cat.id` | Campo ausente; perfil integral igual no SQLite e valores iguais após religar. |
| C — contato comum | `c.credit_limit === "100.00"` | Campo ausente; limite e modo preservados e reapresentados. |
| C — contato comum | Novo contato: `finance_category_id === null` | Campo ausente; `null` conferido no SQLite e após religar. |
| C — contato comum | Leitura: `finance_category_name === null` | Campo ausente; nome original reaparece após religar. |
| C — forma comum | Nova forma: `account_id === null` | Campo ausente; `null` conferido no SQLite e após religar. |
| C — forma comum | Forma editada: `account_id === a.id` | Campo ausente; conta preservada no SQLite e após religar. |
| C — forma comum | Forma editada: `fee_rate === "2.0000"` | Campo ausente; todos os campos financeiros preservados e reapresentados. |
| C — forma comum | Leitura: `account_name === null` | Campo ausente; nome original reaparece após religar. |
| C — vendedor | `commission_rate === "3.0000"` | Campo ausente; regra, modo, taxa e faixas preservados no SQLite e após religar. |
| C — vendedor | Novo vendedor: `commission_rate === null` | Campo ausente; `null` conferido no SQLite e após religar. |
| C — reajuste em massa | `items[0].cost_price === null`, para Estoque/Compras suspensos | Campo ausente; linhas completas dos fornecedores/custos e histórico iguais; fornecedores e `cost_price` reaparecem iguais. |
| D — proposta, compra e OS | `document.warehouse_id === null`, nos três tipos | Campo ausente; `null` no SQLite e após religar; corpo persistido igual. |
| D — campos suspensos | `warehouse_id === warehouse.id` | Campo ausente; coluna e referência no corpo preservadas; valor reaparece. |
| D — campos suspensos | `category_id === category.id` | Campo ausente; valor no corpo preservado e reapresentado. |
| D — campos suspensos | `payment_account_id === account.id` | Campo ausente; valor no corpo preservado e reapresentado. |
| D — campos suspensos | `installments[0].details === details(account.id)` após omitir campos | Três campos financeiros ausentes; demais detalhes iguais; detalhes integrais preservados no SQLite e após religar. |
| D — campos suspensos | Mesma igualdade após omitir o plano de parcelas | Mesma projeção, com detalhes integrais preservados no SQLite. |
| D — campos suspensos | Mesma igualdade após reduzir o total | Mesma projeção, com detalhes integrais preservados no SQLite. |
| D — cópia | `copied.warehouse_id === null` | Campo ausente; cópia persiste `null` e o reapresenta; documento original integral inalterado. |
| D — cópia | `copied.category_id === null` | Campo ausente; cópia persiste `null` e o reapresenta; vínculos originais reaparecem iguais. |
| D — lotes antigos | `items[0].lots` contém o lote e quantidade `1.000000` após omissão | Campo ausente; lista integral igual no SQLite e após religar. |
| D — lotes antigos | Mesma lista após aumentar a quantidade do item | Campo ausente; lista integral igual no SQLite e após religar. |

### Arquivos do fechamento e limites

| Arquivo | Mudança desta integração |
|---|---|
| `src/modules/registry.ts` | Lista da cascata opcional e marca transacional antes da alteração dos módulos. |
| `src/service.ts` | Marca no lote dos planos que alteram módulos. |
| `migrations/0133_erp_parts.sql` | Marca, dois gatilhos de compatibilidade e preservação da escolha nova na reexecução. |
| `src/erp/engine/parts-gate.ts` | Separa origem e destino da prévia de conversão. |
| `src/modules/openapi.ts`, `docs/MODULOS.md` | Contrato opcional de `confirmed_dependents`. |
| `tests/erp/unico/f2-catalogo.test.mjs`, `tests/erp/unico/f2-documentos.test.mjs` | Nove casos autorizados, detalhados na tabela acima. |
| `tests/erp/unico/f2-corr-partes.test.mjs` | Prévia de conversão atravessa o portão real e ambos os adaptadores. |
| `tests/f2-corr-painel.test.ts` | Compatibilidade sem lista; mantém recusas e acrescenta tipos inválidos. |
| `tests/erp/unico/f2-fecha.test.mjs` | Nove testes Node: cinco da migração, escolhas persistidas e rollback; quatro com Hub/produtor/motor reais, cobrindo objetos novos e instalados, autorização antes da classificação de RPC, renovação de emissão/vencimento e o ciclo completo do cron com seleção SQL, entrega e ACK reais. |
| `tests/f2-fecha.test.ts` | Oito cenários D1 dos escritores antigo/novo, entrega exata e atomicidade nos dois caminhos novos. |
| `tests/service-center-fixture.ts` | Apenas preparação: marca escolhas da versão nova, com opção explícita para simular o escritor antigo. |
| `tests/c-fronteira-erp.test.ts` | Apenas preparação do caso sem fotografia: ping instala o esquema antes das recusas; todas as asserções existentes permanecem. |
| `tests/erp-do-rpc-system.test.ts` | Apenas preparação: ping no objeto que deve manter tabelas vazias e fotografia válida para alcançar a classificação de nome desconhecido. |
| `tests/erp-cron-scheduled.test.ts` | Ajuste já aplicado antes desta rodada: confere emissão inicial e atualiza emissão e vencimento juntos na igualdade integral da renovação. Todas as demais asserções permanecem. O último Vitest externo ainda executou a versão anterior, conforme diagnóstico abaixo. |
| `web/erp/app/components/RealHome.tsx` | Invalidação do resumo considera as sete partes que alimentam suas fontes, em ordem estável; Cobrança/PDV continuam atualizando os atalhos sem repetir a consulta. |
| `web/erp/test/f2-corr-painel.test.mjs` | Acrescenta dois casos: mudança de Cobrança/PDV mantém uma única consulta, aceita sua resposta em voo e atualiza os atalhos. Os nove casos existentes permanecem. |
| `web/erp/ORIGEM.json` | Registra a adaptação de RealHome e as duas regressões novas. |
| `docs/ERP-FASE2.md` | Decisões, rastreabilidade das asserções, verificações e limites da junção. |

A exportação administrativa continua **completa por decisão do orquestrador**.
Backup/restauração permanecem exceções internas; não há nova rota pública.
Papéis do emissor/cofre e acesso Fiscal permanecem com as correções de
`f2-aceite2`. Não foram criados recursos Cloudflare, classes de Durable Object,
migrações adicionais. A alteração de `web/erp/app/components/RealHome.tsx`
está registrada na seção `local` de `web/erp/ORIGEM.json`.
Continuam sem medição local o custo faturado e a carga no runtime Cloudflare,
e não há transação distribuída nem recomposição retroativa de efeitos.
Não resta decisão de produto pendente. O ajuste do cron já está aplicado;
o último retorno externo executou a expectativa anterior. `check`, `build`,
`test:erp` e `test:erp:painel` passaram externamente. A aceitação final ainda
depende de uma nova execução externa do Vitest completo sobre o arquivo atual,
sem editar os fontes enquanto a verificação estiver em andamento.

### Verificação desta integração — rodada inicial

| Comando/evidência | Resultado local |
|---|---|
| `npx tsc --noEmit` | Passou na junção e após as mudanças de produção; `.f2-fecha-tsc.log`. |
| `node --no-warnings --test` com `f2-base`, `f2-catalogo`, `f2-documentos`, `f2-corr-partes` e `f2-fecha` de `tests/erp/unico/` | Cinco arquivos aprovados, zero falhas; `.f2-fecha-focais.log`. Inclui a migração D1 em SQLite, sem alterar o teste diferencial. |
| `node --no-warnings --test tests/erp/unico/f2-paridade.test.mjs` | Passou, incluindo o diferencial contra Postgres local; `.f2-fecha-paridade.log`. |
| `node --no-warnings --test --test-concurrency=3 'tests/erp/**/*.test.mjs'` (comando de `test:erp`) | **234 de 235 arquivos aprovados**, saída 1, em aproximadamente 15 min 45 s. Única falha: preparo de `schema-upgrade.test.mjs` por `spawnSync git EPERM`; `.f2-fecha-erp.log`. Todos os arquivos da fase 2, incluindo a paridade, passaram. |
| Diagnóstico sem isolamento de processos (`--experimental-test-isolation=none --test`) | Catálogo: 13 casos aprovados. Documentos e correções das partes: 35 casos aprovados. O runner isolado desta máquina resume por arquivo; o modo sem isolamento permite ver cada asserção. |
| `node --no-warnings --experimental-test-isolation=none --test tests/erp/schema-upgrade.test.mjs` | Dois casos bloqueados no preparo por `spawnSync git EPERM`, antes das asserções; `.f2-fecha-schema.log`. Arquivo original intacto. |
| Marcadores de conflito, CSS, `git diff --check` e busca por CR nos arquivos alterados | Passaram. |
| `node scripts/check-encoding.mjs` | Bloqueado por `spawnSync git EPERM`. A mesma guarda, em cópia temporária recebendo a lista de arquivos pelo shell, aprovou 4.333 arquivos de texto; a cópia foi removida. |
| `check` completo, `build`, `test:erp:painel` e Vitest completo | Não executados localmente. Permanecem na verificação externa; Vitest e Wrangler não foram chamados. Os oito novos testes D1 aguardam essa execução. |

Na rodada inicial, as falhas locais remanescentes foram as duas chamadas a Git por
`spawnSync`: a guarda de codificação e a preparação dos dois casos de subida
do esquema. A guarda equivalente passou via lista fornecida pelo shell; o
teste original de subida permanece aguardando a execução externa. Não se
declara a cadeia externa verde com base nesses resultados locais.


### Primeiro retorno externo e correções da continuação (histórico)

O arquivo `.codex-verificacao.log` fornecido na primeira continuação registrava
**291 arquivos e 3.022 testes aprovados; quatro arquivos e cinco testes
reprovados no Vitest**. É o resultado anterior às correções abaixo; o trecho
não informa o resultado individual dos outros comandos da cadeia externa.

| Falha externa | Causa comprovada e tratamento |
|---|---|
| `c-fronteira-erp`, P11 sem fotografia: tabela `erp_catalog__record` inexistente | A recusa do Hub passou a acontecer antes de importar/migrar o motor. O teste consultava tabelas que sua própria preparação não criava. Um ping prepara o objeto instalado; as recusas e a igualdade das três tabelas vazias permanecem. O novo teste Node cobre também o objeto novo, exigindo esquema vazio e zero SQL/import/R2 na recusa. |
| `erp-do-rpc-system`, marca sem fotografia: tabela `erp_platform__task` inexistente | Mesma causa. O ping prepara somente o esquema; nenhuma fotografia ou alarme é criado. Preservadas as provas de 503, nenhuma tarefa, fotografia ausente, alarme nulo e zero acesso no handler. |
| `erp-do-rpc-system`, nome desconhecido: 503 em vez de 404 | O pedido não trazia fotografia e era corretamente barrado antes de chegar à classificação. A preparação passa a enviar fotografia válida. O novo teste Node prova ambos os caminhos: sem fotografia → 503; com fotografia → 404 completo; RPC válida de tarefa → 200. |
| `c-telas`, Dashboard: duas chamadas em vez de uma | A geração do resumo incluía Cobrança e PDV, embora essas partes não alimentem suas fontes. RealHome passa a invalidar pelas sete fontes efetivas; os atalhos continuam sendo filtrados pela ativação atual. O teste antigo ficou intacto. As duas novas regressões Node falharam antes da correção (`2 !== 1`) e passaram depois. |
| `erp-cron-scheduled`, igualdade da renovação | O produtor agora envia `issued_at`; renovar exige atualizar emissão e vencimento juntos. A igualdade antiga copia a emissão inicial e troca apenas o vencimento, exigindo uma concessão de onze minutos, inválida pelo contrato de seis minutos. A prova Node com produtor e Hub reais passou com ambos os horários atualizados. Naquela rodada, o patch estrito ficou em `/tmp/f2-fecha-cron-issued-at.patch`; já está aplicado no estado atual. |

A regra da tarefa diz: “Fora das exceções das decisões 1 e 2, teste antigo
só muda na preparação”. Por isso, naquela rodada o ajuste do cron ficou
pendente da exceção solicitada. A continuação atual já recebeu o patch aplicado.
Ele acrescenta a prova
`first.snapshot.issued_at === start` e conserva a igualdade integral da
renovação, agora exigindo `issued_at === start + 300_000` junto de
`expires_at === start + 660_000`. Nenhuma asserção é removida ou relaxada;
todas as demais provas de TTL, revisão, ACK, esquema, motor, alarme e área
desligada permanecem. `git apply --check` havia aprovado o patch.

Outras mudanças de expectativas autorizadas, além dos nove casos da tabela:

| Arquivo / caso | Antes | Agora |
|---|---|---|
| `tests/f2-corr-painel.test.ts`, cascata com `confirmed_dependents: undefined` | Recusa com `module_cascade_conflict`. | Sucesso compatível, Base e dependente desligados, `also_disabled` exato e uma entrega. |
| Mesmo arquivo, listas inválidas | Conferia código de conflito e preservação do estado. | Conserva essas provas e exige também status 409; acrescenta `null`, membro numérico e igualdade após remoção do dependente. |
| `tests/erp/unico/f2-corr-partes.test.mjs`, prévia de conversão | Leitor direto e parser omitiam os três vínculos. | Mesmas ausências pelo adaptador e portão reais nos dois destinos, com indisponibilidade, origem, destino, recusa de partes/origem inválidas, reaparecimento ao religar e quatro tabelas intactas. |
| `tests/erp-cron-scheduled.test.ts`, renovação (patch já recebido aplicado) | Igualdade integral copiava `issued_at` inicial e atualizava só `expires_at`. | Mesma igualdade integral exige `issued_at: start + 300_000` e `expires_at: start + 660_000`; acrescenta emissão inicial igual a `start`. Não remove nem relaxa nenhuma prova. |

### Verificação local da primeira continuação (histórico)

| Comando/evidência | Resultado |
|---|---|
| `npm run check` | Parou na guarda de codificação por `spawnSync git EPERM`; `.f2-fecha-retorno-check.log`. Nenhuma guarda foi alterada. |
| `npm run build` | Passou, saída 0; somente avisos de diretivas `use client` do React Router. `.f2-fecha-retorno-build.log`. |
| `./node_modules/.bin/tsc --noEmit` | Passou, saída 0; `.f2-fecha-retorno-tsc.log`. O tsconfig não inclui os arquivos Vitest. |
| `npm run test:erp` | **234 de 235 arquivos aprovados**, saída 1, em 17 min 06 s; `.f2-fecha-retorno-erp.log`. Única falha: preparação de `schema-upgrade.test.mjs` por `spawnSync git EPERM`. Todos os arquivos da fase 2 e o diferencial passaram, sem alterar o oráculo. |
| `schema-upgrade.test.mjs` original sem isolamento | Os dois casos param no hook de preparação por `spawnSync git EPERM`, antes das asserções; `.f2-fecha-retorno-schema.log`. |
| `npm run test:erp:painel` | **375 arquivos aprovados**, zero falhas, cancelamentos, pulos ou TODO; `.f2-fecha-retorno-painel.log`. |
| `f2-corr-painel.test.mjs` e `origem.test.mjs` sem isolamento | **15 casos aprovados**, zero falhas; `.f2-fecha-retorno-painel-focal.log`. Inclui as duas novas regressões que falharam antes da correção, em `.f2-fecha-retorno-painel-repro.log`. |
| `tests/erp/unico/f2-fecha.test.mjs` sem isolamento | **8 casos aprovados**, zero falhas; `.f2-fecha-retorno-hub.log`. Usa Hub, produtor de fotografias, migração e RPC reais sobre SQLite local, sem substituir a lógica de produção. |
| Catálogo, documentos, correções das partes e rotinas de fundo sem isolamento | **57 casos aprovados**, zero falhas, cancelamentos, pulos ou TODO; `.f2-fecha-retorno-focais.log`. O caso de reajuste foi repetido após acrescentar a igualdade direta do `cost_price` reapresentado: **1 aprovado**, `.f2-fecha-retorno-custo.log`; a suíte completa também passou com essa asserção. |
| Transformação dos cinco arquivos TypeScript de teste alterados/novos | Sintaxe aprovada com esbuild, sem importar nem executar Vitest; `.f2-fecha-retorno-testes-sintaxe.log`. Não substitui a execução externa. |
| Subida do esquema em cópia temporária | **2 casos aprovados**, com todas as asserções originais e os mesmos quatro arquivos do commit `4748b75`, obtidos pelo shell; `.f2-fecha-retorno-schema-equivalente.log`. Apenas a obtenção dos arquivos históricos foi adaptada; a cópia foi removida e o teste original permanece intacto. Não equivale a declarar o comando original verde. |
| Codificação com lista obtida pelo shell | Mesma guarda aprovou **4.333 arquivos de texto**, incluindo arquivos novos; `.f2-fecha-retorno-encoding.log`. A cópia temporária da guarda foi removida. |
| Marcadores de conflito, CSS e `git diff --check` | Passaram. |
| Vitest completo | Não executado localmente, conforme a instrução. As correções ainda precisam do novo retorno externo. |

Sem commit, acesso à rede, execução de Vitest ou enfraquecimento de testes.
A exportação administrativa permanece completa por decisão. Não houve
alteração no diferencial, no esquema do ERP ou criação de migração/classe
de Durable Object. A janela de atualização foi resolvida na `0133`; não
ficou adiada. Permanecem fora desta execução as medições de custo/carga em
Cloudflare e a validação externa integral. Naquele encerramento, a aceitação
continuava aberta, inclusive pela expectativa do cron ainda pendente.


Falhas e pendências ao encerrar a primeira continuação, superadas em parte
pelo retorno externo detalhado na seção seguinte:

- `check`: a guarda original não consegue concluir a chamada de Git por
  `spawnSync git EPERM`; a validação equivalente de codificação passou.
- `test:erp`: somente `schema-upgrade.test.mjs` falha, com o mesmo erro de
  permissão no preparo dos dois casos; a execução equivalente passou sem
  mudar nenhuma asserção.
- Vitest: o último retorno externo ainda é o log com cinco falhas. Quatro
  receberam correção no produto/preparação; a quinta, do cron, tem patch
  pronto e validado para aplicação, pendente da exceção solicitada. Nenhum
  novo resultado externo havia sido recebido naquela rodada.

### Segundo retorno externo: causa da falha e estado atual

O resumo atual `.codex-verificacao.log` informa **294 arquivos e 3.026 testes
aprovados; um arquivo e um teste reprovados** no Vitest. O script externo
`/home/bruno/wabotia/tarefas/f2-fecha.verifica.sh` preservou os logs completos
em `/tmp/tmp.VGaQp2yuzK/`. Eles foram lidos, sem executar o script nem Vitest,
e copiados para `.f2-fecha-externo2-{check,build,erp,painel,vitest}.log` nesta
área de trabalho. Isso permitiu verificar também os quatro comandos verdes,
omitidos pelo resumo de falhas.

A única falha ainda executou **a expectativa antiga do cron**. O diff externo
mostra estes valores exatos:

| Campo da renovação | Esperado pelo teste executado | Recebido |
|---|---:|---:|
| `issued_at` | `1795188900000` (emissão inicial) | `1795189200000` (cinco minutos depois) |
| `expires_at` | `1795189560000` | `1795189560000` |

O recebido concede seis minutos; a expectativa antiga combinava emissão e
vencimento distantes onze minutos. O Vitest começou às **12:55:09 de
19/11/2026**, horário de São Paulo; a alteração do arquivo está registrada
às **12:56:57**, depois do início. O erro aponta a linha 83 da versão
executada, enquanto o trecho de fonte exibido no fim já mostra a versão
atual, com a asserção na linha 84 e o `issued_at` corrigido. Portanto, esse
retorno não testa o ajuste que já estava no arquivo ao iniciar esta rodada.
Não houve motivo para mudar o produto nem relaxar a igualdade do teste.

Foi acrescentado um nono teste em `tests/erp/unico/f2-fecha.test.mjs`, que
percorre `wakeErpAreas`, leitura/seleção SQL, produtor, Hub, KV e ACK reais,
adaptando apenas D1 para SQLite local e o armazenamento do objeto para
memória. Confere a entrega inicial de duas áreas, a renovação exata aos
cinco minutos, a preservação do alarme já planejado, a entrega do desligamento
com revisão nova e ACK, nenhuma entrega repetida após o ACK e a área já
desligada intacta. Exige zero SQL no ERP e zero novas cargas do motor durante
todo esse ciclo. A reprodução em cópia temporária com a expectativa antiga
falhou exatamente em `issued_at` por 300.000 ms; o arquivo atual passou.
A cópia temporária foi removida, sem alterar as asserções de nenhum teste antigo.

### Verificação consolidada mais recente

| Comando/evidência | Resultado e alcance |
|---|---|
| `npm run check`, externo | **Passou**; codificação de 4.331 arquivos versionados, conflitos, CSS e TypeScript. `.f2-fecha-externo2-check.log`. |
| `npm run build`, externo | **Passou**; avisos de `use client` do React Router, sem erro. `.f2-fecha-externo2-build.log`. |
| `npm run test:erp`, externo | **1.065 aprovados, zero falhas e um TODO preexistente**, em 15 min 31 s. Inclui subida do esquema e diferencial contra Postgres intactos. O TODO é o caso 248 da ponte de pedido de compra com Documentos; não foi criado ou alterado neste fechamento. `.f2-fecha-externo2-erp.log`. |
| `npm run test:erp:painel`, externo | **2.247 aprovados**, zero falhas, cancelamentos, pulos ou TODO. `.f2-fecha-externo2-painel.log`. |
| Vitest completo, externo | **294/295 arquivos e 3.026/3.027 testes aprovados**. Única falha: expectativa antiga de emissão no cron, detalhada acima. Os testes de fronteira, RPC de sistema, Dashboard, cascata e os oito cenários D1 de `f2-fecha` passaram. `.f2-fecha-externo2-vitest.log`. |
| Seis arquivos Node focais, nesta rodada | **81 casos aprovados**, zero falhas/cancelamentos/pulos/TODO: `f2-base`, `f2-catalogo`, `f2-documentos`, `f2-corr-partes`, `f2-corr-fundo` e `f2-fecha`, com `--experimental-test-isolation=none`. `.f2-fecha-final-focais.log`. |
| `tests/erp/unico/f2-fecha.test.mjs`, nesta rodada | **9/9 casos aprovados** sem isolamento; também aprovado com o isolamento padrão usado por `test:erp`. `.f2-fecha-cron-hub.log` e `.f2-fecha-final-isolado.log`. |
| Controle negativo do cron | **Falha esperada reproduzida** em cópia temporária, mudando somente a expectativa de emissão para a antiga; diferença exata de 300.000 ms. `.f2-fecha-final-cron-antigo.log`. Cópia removida. |
| `npm run check`, repetição local | Continua bloqueado por `spawnSync git EPERM` na guarda de codificação; nenhuma guarda foi alterada. `.f2-fecha-final-check.log`. O resultado externo verde acima é independente dessa restrição local. |
| TypeScript direto e sintaxe dos seis arquivos de teste TS alterados/novos | **Passaram**, sem importar/executar Vitest. `.f2-fecha-final-tsc.log` e `.f2-fecha-final-sintaxe.log`. |
| Codificação incluindo arquivos novos, conflitos, CSS e `git diff --check` | **Passaram** nas verificações separadas. A guarda de codificação foi executada com a lista obtida pelo shell em cópia temporária; a cópia foi removida. `.f2-fecha-final-guardas.log`. |

Nesta rodada não foram repetidos build, motor inteiro ou painel inteiro:
os logs externos completos já comprovam aprovação e não houve alteração
adicional de produção/painel. As mudanças novas se limitam à regressão Node
do cron e a este relato. Vitest e o script de verificação externa não foram
executados localmente. Não houve commit, rede, alteração do oráculo,
enfraquecimento de testes, migração nova ou alteração no esquema do ERP.

**Pendência final:** reexecutar externamente o Vitest completo sobre o estado
atual, sem editar fontes durante a execução. Não se declara aceite integral
enquanto esse resultado não chegar. A exportação administrativa continua
completa por decisão; custo/carga em Cloudflare, transação distribuída e
recomposição retroativa continuam fora do escopo. Não há dúvida de produto
ou autorização pendente nesta continuação.
