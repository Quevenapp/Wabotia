# Integração da fase 1 e da casa única — relato completo

Atualizado em 19/11/2026. Tarefa: `/Volumes/Dev/wabotia/tarefas/c-integra.md`.
Base da junção: `fefbdf08`; HEAD recebido nesta rodada: `836cacbc`.
Este documento reúne toda a integração já presente na área de trabalho e a
investigação da última verificação externa. Nenhum commit foi feito nesta execução.
O relato antigo `UN-CASA-BASE-RELATO.md` pertence à tarefa anterior da Base.

## Estado atual — última falha localizada no setup de M10

A verificação externa mais recente, em `.codex-verificacao.log`, terminou com
**1 teste falhando e 2.926 passando**, em **1 arquivo com falha e 285
aprovados**. Ela substitui os resultados anteriores de 14 e de 25 falhas:

```text
FAIL tests/c-rotinas.test.ts > M10: duas linhas autorizadas compartilham uma senha sem mudar origem
Error: Implementação de identidade já registrada.
src/customer/ports.ts:17:11
```

O arquivo recebido contém somente esse resumo do Vitest; não contém os
resultados individuais de check, build e painel da execução externa. Os
outros grupos de falhas anteriores não aparecem mais no log recebido.

A causa foi corrigida em `tests/c-rotinas.test.ts`, sem alteração de produção
nesta rodada. Todas as asserções, negativas de autorização e limites foram
preservados. O aceite global **continua dependendo da nova verificação
externa**: não foi executado Vitest nesta área, nem `npm run build` com emissão
de artefatos, Wrangler, rede, instalação de dependências ou commit.

## Correção desta rodada — registro de identidade em M10

O `beforeEach` instala a porta simulada `identity` como implementação
explícita. A rodada anterior passou M10 a usar provas reais, mas tentou fazê-lo
com `installIdentityPort(customerIdentity)`, registrando uma segunda
implementação explícita no mesmo módulo. `registration` corretamente rejeita
essa substituição. A falha ocorria antes da preparação das provas e antes das
asserções da senha. O contrato de registro único também é exigido por
`tests/f1-base.test.ts` e não foi alterado.

M10 agora usa
`vi.spyOn(identity, "resolve").mockImplementation(customerIdentity.resolve)`:
a porta instalada continua sendo o mesmo objeto, e apenas o resolvedor desse
caso passa a executar a implementação real. Um `afterEach` chama
`vi.restoreAllMocks()`, restaurando o resolvedor simulado inclusive quando uma
asserção falha. Os demais casos continuam usando seu Map de referências.
`prepareInbound` continua sendo chamado diretamente na implementação real,
com evidência QR e gravação atômica das provas.

Permanecem todas as verificações de M10: ambas as linhas comprovadas, uma única
senha, segunda emissão sem criação, conversa de origem intacta, acesso pela
segunda linha, troca persistida de titular, recusa ao novo titular e recibo
histórico com contato/conversa originais. Nenhuma expectativa foi reduzida,
removida ou convertida em pulo. A única mudança adicional no arquivo é a
importação e instalação do hook de restauração.

O diagnóstico offline anterior já executava M10 com a identidade real desde
a inicialização, sem o `beforeEach` que instala a porta simulada. Por isso ele
validou o SQL e a autorização, mas não exercitou esse conflito de registro.
Essa limitação explica a diferença entre os 18 cenários locais aprovados e a
falha externa. A correção foi conferida contra o fluxo de registro e de
resolução; o ciclo real de hooks do Vitest ainda depende da execução externa.

## Verificação local desta rodada

- `npm run check`: aprovado, incluindo `tsc --noEmit`, codificação, marcadores
  de conflito e CSS do ERP.
- TypeScript dos **14 testes alterados** desde `fefbdf08`: aprovado, incluindo
  o spy e o hook de M10. Foi usada configuração temporária com os tipos
  Cloudflare e as declarações do projeto; o arquivo foi removido ao terminar.
  Essa checagem apenas lê os tipos, sem executar Vitest.
- `node --no-warnings scripts/c-integra-diagnostico.mjs`: **18 cenários
  aprovados**, incluindo provas reais das duas linhas, consulta da senha em
  **uma instrução**, troca de titular e integridade do recibo. Também passaram
  navegação/permissões, histórico/privacidade, máscara nas três opções,
  projeção panel, identidade com 1.000 contatos, OS/documentos/lembretes e
  recuperação da ponte em **38 instruções**, dentro do teto de 40.
- `npm run test:erp:painel`: **2.213 aprovados, zero falhas, zero pulos**, em
  aproximadamente **103 segundos**. Inclui o build Vite em memória, os tetos
  intactos de 1.208 KiB e 352 KiB gzip, manifesto de origem e guarda de textos.
- Auditoria desde `fefbdf08`: os **14 arquivos de teste alterados** pertencem
  às famílias permitidas; `web/erp/test/**` e migrações permanecem intactos.
  Há **90 migrações**, sem números duplicados; todas foram aplicadas ao SQLite
  vazio do diagnóstico.
- `git diff --check`: aprovado.

Logs: `/tmp/c-integra-check-m10.log`,
`/tmp/c-integra-tests-types-m10.log`, `/tmp/c-integra-diag-m10.log` e
`/tmp/c-integra-erp-painel-m10.log`.

O diagnóstico usa funções reais e SQLite em memória, bloqueia `fetch` e simula
IA, RPC ERP e armazenamento R2. Não substitui Worker/D1 nem o ciclo de hooks do
Vitest. Não foram exercitados localmente: Vitest completo ou parcial,
`npm run build` com emissão de artefatos, métricas reais `rows_read` do D1,
Coordinator/ERP/R2 reais, provedores externos, pagamentos ou navegador.
Nenhum resultado local é apresentado como aprovação da suíte externa.

## Rodada anterior — correções do log com 14 falhas

A verificação externa daquela rodada mostrava **14 falhas e 2.913 aprovações**,
em cinco arquivos com falhas. As quatro causas e as correções recebidas já
aplicadas continuam descritas abaixo. O log atual deixou apenas o conflito de
registro de M10, corrigido acima.

### Casa — 10 casos de `c-entrada`

Ao restaurar a elegibilidade legada de navegação para administrador/acesso
nulo, `accessAllows` passou a retornar antes da verificação de papel privado.
O registro da casa usava apenas `canOpenPage`, de modo que também liberava
menu e destino de Ensino/Jurídico sem aqueles papéis. Isso explica os quatro
casos de Ensino e seis de Jurídico do log.

`web/management/registry.ts` agora aplica `nativeReadAllows` dentro de
`permits`, antes da elegibilidade geral. Menu, destino direto e entrada usam
essa mesma decisão. Ensino exige secretaria/professor; Jurídico exige
`os:sensitive` e advogado/curador; prazos continuam exclusivos do advogado.
O estado anterior ao status continua sendo loading, preservando os aliases e
os casos publicados de `admin-extension-route`. Não houve nova alteração nas
expectativas de `c-entrada` naquela rodada.

### Histórico — um caso de `c-privacidade` e um de `f1-history-privacy`

`authorize` tratava toda recusa de `customerTextScope.allowed` como motivo
para limpar `incomplete`. Essa recusa inclui ambiguidade, cuja resposta deve
continuar vazia, mas informar a pendência de identidade. A correção separa
`restricted`, calculado com o estado já lido do titular, de `allowed`.
Somente a restrição encerra a pendência nesse ponto. Bloqueado/excluído seguem
vazios sem pendência; ambíguo segue vazio com pendência; a restrição do contato
prevalece também sobre a ambiguidade. Nenhuma consulta foi acrescentada e
nenhuma expectativa desses dois testes foi relaxada.

### Senha entre linhas — M10 de `c-rotinas`

A fixture declarava o contato ready em um Map do resolvedor simulado e em
`customer_phones`, mas não gravava `customer_phone_proofs`. A consulta de senha
em uma instrução, necessária aos tetos publicados, verifica essa prova no
banco e corretamente recusava a identidade incompleta. A troca de titular
negativa do teste também só existia naquele Map.

Somente M10 passou a usar `customerIdentity` real: cada linha obtém a prova por
`prepareInbound` com evidência QR e aplica seu lote. A troca posterior revoga
a prova anterior e instala o novo titular no banco, conferido pelo resolvedor
real. Permanecem as expectativas de uma única senha, segunda emissão sem
criação, origem preservada e recusa ao novo titular. Foram acrescentadas
verificações de que a segunda linha conserva acesso e de que o recibo
histórico mantém o contato e a conversa originais. Os demais casos continuam
com suas portas simuladas. O código da fila não mudou naquela rodada. A
instalação da porta real introduziu o conflito corrigido na rodada atual,
descrito no início deste relato.

### Projeção de contato — um caso de `f1-base`

A expectativa textual de SQL proibia `conversation_contacts`, contrariando o
contrato publicado de `modules-api`: `ctx.contact` precisa projetar o cadastro
`panel` explicitamente associado, mesmo havendo contato automático. O teste
novo agora exige os parâmetros e filtros de área, namespace e conversa, além
da prioridade desse cadastro vinculado. Conserva a recusa a contatos
restritos/automáticos sem nome, o resolvedor compartilhado, as três consultas
da projeção, a negativa entre áreas e a ausência de chamada ao ERP. Não houve
mudança adicional no código da projeção. O diagnóstico também verifica que a
projeção panel não muda `ctx.customer`, não aparece em outra conversa e não
aceita namespace de aplicação ou contato restrito.

## Verificação local da rodada anterior (14 falhas)

- `npm run check`: aprovado, incluindo TypeScript, codificação, marcadores de
  conflito e CSS do ERP.
- Diagnóstico offline: **18 cenários aprovados**. Antes da correção, a matriz
  da casa e o caso de ambiguidade reproduziram as falhas; depois, ambos passaram.
  Foram exercitados 48 combinações de módulo/papel/acesso e seis combinações
  de estado/vínculo explícito no histórico, além de M10 com prova real.
- Os cenários anteriores continuam presentes: motor/máscara nas três opções,
  histórico público e sessão antiga, contato panel, fila e variantes de
  telefone, identidade em base de 1.000 contatos, OS/documentos/lembretes e
  recuperação da ponte. Consulta de senha: **uma instrução**. Ponte: **38
  instruções**, dentro de 40, sem duplicar a criação simulada.
- TypeScript dos sete testes alterados na área de trabalho (`c-cadastro`,
  `c-entrada`, `c-ficha`, `c-identidade`, `c-privacidade`, `c-rotinas` e
  `f1-base`): aprovado com configuração temporária, removida ao terminar.
  A primeira configuração omitia a declaração existente `web/voice.d.ts`;
  incluir as declarações do projeto resolveu a checagem, sem alterar código.
- `npm run test:erp:painel`: **2.213 aprovados, zero falhas, zero pulos**, em
  aproximadamente 98 segundos. Inclui build Vite em memória, tetos intactos
  de 1.208 KiB e 352 KiB gzip, manifesto de origem e guarda de textos do ERP.
- Auditoria desde `fefbdf08`: os 14 arquivos de teste alterados pertencem às
  famílias permitidas. `web/erp/test/**` e migrações permanecem intactos.
  As 90 migrações não têm números duplicados.
- `git diff --check`: aprovado.

O diagnóstico usa as funções reais empacotadas localmente e SQLite em memória
com as 90 migrações. `fetch` é bloqueado; IA, RPC ERP e armazenamento R2 têm
adaptadores locais. Isso não executa Vitest nem substitui o Worker/D1.
O build Vite em memória faz parte da suíte Node autorizada.

Logs daquela rodada: `/tmp/c-integra-diag-before.log`,
`/tmp/c-integra-diag-after.log`, `/tmp/c-integra-check-atual.log`,
`/tmp/c-integra-tests-types-atual.log` e `/tmp/c-integra-erp-painel-atual.log`.

## Rodada das 25 falhas — causas e correções

A verificação externa então disponível aprovava `npm run check`, 2.213 testes
do painel (inclusive o teto inicial) e 2.867 testes do Vitest, deixando 25
casos e a falha de carregamento de `c-ficha` em 14 arquivos. As correções a
seguir foram recebidas já aplicadas e continuam integrantes da entrega. No
log externo atual, `c-ficha`, os testes antigos e os demais grupos abaixo já
não aparecem como falhas; os problemas restantes estão tratados acima.

### Histórico e privacidade — `bot-actions-ai`, `c-privacidade`

`src/customer/history.ts` filtrava mensagens somente pelas direções `in/out`,
enquanto a entrada real grava `customer` e as respostas usam `agent/bot`.
Por isso o texto público desaparecia antes da máscara. O filtro agora admite
também as direções publicadas, mantendo os vetos a notas, formulários e domínios
privados antes do LIMIT e conservando o corte e a marca da sessão.

A leitura também exigia identidade telefônica completamente reconciliada
para uma sessão histórica já persistida. Isso esvaziava as fixtures legadas
de E1/S4. A sessão válida agora autoriza o próprio histórico durante o
preenchimento pendente, desde que o canal, telefone, namespace, contato ativo
e eventual vínculo explícito concordem. Não cria prova telefônica nem muda o
titular. As chaves `core/conversation` e `conversations/session` continuam
deduplicadas pela data original; conflitos continuam recusados. O titular
da sessão também é consultado quando não há `conversation_contacts`, para
que restrição e namespace sejam respeitados nesse caso.

O diagnóstico executou o motor real com duas chamadas simuladas ao provedor,
com máscara `true`, `false` e omitida: histórico presente, máscara preservada
em cada chamada e CPF restaurado na resposta. Verificou também texto público
anterior a 16 mensagens privadas, sessão antiga e troca/restrição do titular.

### Fila e orçamento — `f1-history`, `f1-integration`, `d1-budget`, `os-i3-integration`

`src/queue.ts`, em `activeTicketForConversation`, fazia três consultas
(conversa, identidade, senha), embora o contrato novo e o caminho publicado
exijam uma. Também lançava “Conversa não encontrada” para ID inexistente,
em vez de retornar ausência de senha.

Canal, prova não revogada, contato ativo e senha são relidos em uma instrução
SQL. O predicado de titularidade da fila é compartilhado com a emissão; o
resultado não exporta os campos auxiliares. A validação de telefone mantém
a gramática existente. O diagnóstico confirmou **uma instrução e uma chamada**,
variantes do nono dígito, inexistência, recusa de aplicação, bloqueio,
transferência para outra conversa e cupom de totem sem associação.

Essa retirada de duas instruções corrige a regressão no caminho de mensagens
que participa dos tetos gerais e do alarme (o log recebido media 72 contra
71). **O alarme completo e todos os fluxos de `d1-budget` não foram medidos
novamente no Worker**; seus tetos não foram alterados.

### Contato publicado dos módulos — `modules-api`

`src/modules/api.ts` resolvia o contato automático e perdia a associação
explícita antiga no namespace `panel`. `ctx.contact` volta a priorizar esse
cadastro explicitamente ligado à conversa, sem usá-lo como prova telefônica.
Preserva a recusa a estados restritos e a omissão do contato automático ainda
sem nome. A reprodução do contrato antigo passou no diagnóstico.

### OS, documentos e lembretes — `f1-integration`, `os-document-privacy`, `os-i2-integration`

`src/modules/os/public.ts` usava a mesma autorização para avisos e documentos.
A exceção necessária aos avisos do titular comprovado acabava permitindo
documentos com telefone divergente. Agora os avisos usam o modo `notice`
(`store.ts` e `tasks/reminders.ts`); documentos exigem o telefone atual.
`documents/access.ts` pede essa conferência já na autorização da ordem.
Sem titular persistido na OS legada, o documento continua acompanhando o
telefone corrigido pela equipe, conforme o teste publicado. Uma OS com
titular persistido não ganha esse fallback. A recusa explícita do adaptador
`verifiedPhone` também prevalece sobre o número no cadastro.

Em `src/modules/os/store.ts`, um recibo de aviso já concluído impedia a
repetição de lembrete cuja marca na OS havia sido limpa. O lembrete agora
revalida o destinatário e chama o transporte com a mesma chave idempotente;
falha de um item não marca seu lembrete nem impede o seguinte. As duas
reproduções de OS passaram localmente, sem relaxar os testes publicados.

### Recuperação da ponte — `f1-erp-bridge`

`src/customer/erp-bridge.ts` repetia a consulta de ativação antes de cada RPC,
além da conferência obrigatória na fronteira. A montagem de uma identidade
técnica também relia as mesmas configurações várias vezes. O orçamento de
40 acabava antes do lote que confirma espelho e recibo; o job ficava pending.

A ponte usa o cache somente durante a montagem do envelope técnico e deixa
`localFetch` conferir ativação e privacidade sem cache antes e depois de
cada tentativa. O diagnóstico com resposta perdida, lease vencida e porta
real de índice concluiu em **38 instruções**, sem duplicar a criação remota
simulada. A rodada de cinco instruções continua respeitando seu limite.

### Casa e testes novos — `admin-extension-route`, `c-entrada`, `c-cadastro`, `c-ficha`, `c-identidade`

| Arquivo | Causa e ajuste |
| --- | --- |
| `web/workspace-navigation.ts` e `tests/c-entrada.test.ts` | O teste novo exigia que a elegibilidade geral de navegação negasse o administrador sem papel privado, contrariando os quatro casos publicados de Ensino/Jurídico. A navegação conserva administrador/acesso legado. Faltava reaplicar o papel privado no registro da casa; essa lacuna foi corrigida na rodada das 14 falhas, como descrito acima. O servidor manteve sua autorização. Só as expectativas novas da navegação geral foram ajustadas; as negativas de leitura privada permaneceram. |
| `tests/c-cadastro.test.ts` | S1 tentava fabricar `observed` por `indexContact`, que deliberadamente converte essa origem administrativa em `local`. A fixture agora obtém prova e sessão por `prepareInbound` com canal autenticado. A expectativa de conservar a titularidade permanece. |
| `tests/c-ficha.test.ts` | Ensino já chegava registrado por outro caminho do grafo, apesar do mock de runtime; o setup tentava registrá-lo novamente. Conserva o registro existente e espiona somente `section`, restaurando a função após cada caso. A recusa real a registros duplicados continua intacta e testada para ERP. O log externo mais recente já não aponta falha de carregamento nesse arquivo. |
| `tests/c-identidade.test.ts` | Os dois casos de E7 inseriam os mesmos IDs globais `complete-0001` etc.; o segundo colidia na chave primária de `contacts` antes da medição. Os IDs agora incluem o perfil da fixture. Os tetos de linhas lidas, bytes e tamanho do plano não mudaram. As duas bases de 1.000 contatos foram exercitadas localmente. A fixture local tipa o canal como string, pois também testa IDs de 32 caracteres. |
| `tests/c-privacidade.test.ts` | Dois testes adicionais cobrem direções reais do motor e restrição/namespace de sessão sem vínculo explícito. O helper tipa sessão como string para admitir os identificadores legados já testados. Nenhuma expectativa anterior foi retirada. |

Nenhum teste antigo foi editado. Nenhum arquivo portado em `web/erp/app/**`
foi alterado na rodada das 25 falhas nem nas duas seguintes, portanto não há
nova entrada no manifesto de origem. Nenhuma migração, esquema ERP, recurso Cloudflare ou classe de Durable
Object foi criada ou alterada.

## Verificação local da rodada das 25 falhas

- `npx tsc --noEmit`: aprovado.
- Checagem TypeScript dos cinco arquivos `c-*` alterados, com configuração
  temporária e tipos Cloudflare/DOM: aprovada. A configuração foi removida.
- `node scripts/check-conflict-markers.mjs`, `check-encoding.mjs` e
  `erp-scope-css.mjs --check`: aprovados; UTF-8 sem BOM e LF.
- `node scripts/c-integra-diagnostico.mjs`: **15 cenários aprovados**. O script
  usa as funções reais em bundle local e SQLite em memória com as migrações;
  bloqueia rede e simula somente as respostas de IA/ERP e o armazenamento R2.
  O bundle temporário é removido ao terminar.
- `node --no-warnings --test tests/erp/access/identity.test.mjs`: **2 aprovados**.
- `node --no-warnings --test tests/erp/fagoo/catalog-contacts-lane.test.mjs`:
  **15 aprovados**, incluindo ACL, replay, CAS e importação atômica.
- `git diff --check`: aprovado.

Naquela rodada não foram executados Vitest, Wrangler, build com emissão de
artefatos, suíte completa do painel, métricas reais `rows_read` do D1, alarme
real do Coordinator, R2/ERP em Durable Object, provedores externos ou navegador.
O log externo seguinte foi o de 14 falhas descrito na seção daquela rodada. Os
erros brutos de triggers e de `Event.returnValue` não identificavam por si só
outros casos; os testes de injeção de falha que os geram foram preservados.

## Rodadas anteriores — causas e correções dos itens originais

### 1. Componentes portados traziam o React do painel

`ContactEditor.tsx` importava estaticamente a entrada da ficha única. Esse
caminho chegava às telas do painel e a `lucide-react`, enquanto os testes
portados usam uma implementação de React própria, sem `forwardRef` e
`createElement`. O erro de empacotamento se propagava por listas, documentos,
catálogos e demonstração.

A entrada da ficha passou a ser instalada pelo hospedeiro em
`ErpPorts.contactProfileEditor`. `host-runtime.tsx` registra
`ContactProfileEntry`, que carrega `ContactProfile.tsx` sob demanda. O componente
portado consulta a porta em tempo de execução; sem hospedeiro, em demonstração
ou na inclusão de contato, conserva o formulário legado.

O corpo completo monta `RawContactEditor`, com `embeddedProfile` e vocabulário
da área. Assim não reabre a entrada da ficha nem duplica o histórico comercial
embutido. A adaptação preserva escopo de sessão, fechamento, aviso de alteração
e callback de salvamento. `ContactList.tsx` não precisou ser alterado nesta
integração. Nenhum teste em `web/erp/test/**` foi editado.

### 2. Importação de `tests/c-ficha.test.ts`

O teste importava o componente ERP inteiro para conferir apenas o título da
ficha, levando o grafo de componentes portados ao ambiente de teste do Worker.
A função pura foi extraída para `web/erp/contact-editor-labels.ts`; o formulário
a importa e reexporta, e o teste importa diretamente esse contrato. As
asserções de vocabulário foram mantidas; a UI continua coberta pela suíte Node
do ERP. A falha de registro duplicado descoberta depois foi corrigida na
rodada das 25 falhas; o log externo atual não volta a apontar `c-ficha`.

### 3. Leituras excessivas com checkpoint de identidade completo

Na consulta de candidatos, a subconsulta que recupera os telefones de um
contato podia usar o índice por namespace/telefone e percorrer candidatos da
área inteira. O checkpoint já dispensava a página de legado, mas não essa
subconsulta. Ela agora usa explicitamente
`INDEXED BY customer_phone_candidates_contact`.

As asserções de E7 de `tests/c-identidade.test.ts` foram preservadas, inclusive
os limites de 600 linhas, 25.000 caracteres de resposta e 40.000 de plano. Os
IDs da fixture foram isolados por perfil na rodada seguinte, descrita acima. O
diagnóstico SQLite confirmou o índice no plano de execução e os cenários com
1.000 contatos, com e sem candidato: somente o candidato pertinente é lido,
não se cria duplicata nem prova para candidato cadastral, e o checkpoint é
preservado. A métrica `rows_read` do D1 exige a execução externa.

### 4. Costura das duas frentes no ERP

A revisão de `src/erp/api/local-fetch.ts` preservou as opções de rastreamento de
contatos, estado dos módulos, portão de metadados e revalidação de privacidade.
O registro do provedor ERP encaminhava `list` e `maintain`, mas omitia
`authorizeProfile`. O encaminhamento foi acrescentado, com teste específico em
`tests/c-fronteira-erp.test.ts`, para que a ficha use a autorização do provedor.
Não houve mudança no esquema do ERP.

## Entrada, navegação e textos

- A entrada mostra um cartão por **grupo do menu**, com o nome do grupo:
  Resultados, Comercial, Compras, Catálogo, Estoque, Financeiro, Fiscal, Pessoas
  e os grupos nativos habilitados. Trabalhos usa o vocabulário da área.
- Cada cartão mostra até cinco destinos. Se houver mais, **Ver todos** abre o
  primeiro destino do grupo.
- Módulos nativos vêm antes dos grupos portados na entrada e no menu lateral.
  O resolvedor e a montagem final em `ErpArea` usam a mesma ordenação.
- Com apenas o ERP acessível, a entrada aponta para
  `/app/erp/visao-geral`, destino canônico do Dashboard geral. O alias
  `/app/erp/acesso` faz `replace`, preservando consulta e fragmento. A rota
  canônica renderiza o painel diretamente e suporta recarga/link copiado.
- A projeção do menu legado conserva `/acesso`, exigido pelos testes antigos,
  e sua classificação em Resultados. A casa publica a URL canônica; o roteador
  resolve o alias.
- Contatos informa: “Todo número que envia uma mensagem vira contato
  automaticamente. O nome e os demais dados podem ser completados depois na
  ficha.”

As duas correções já juntadas ganharam testes: o status real de `demoApi`
habilita Agenda, Pedidos, Mesas, Reservas, Trabalhos e Mensalidades; a URL
antiga de Ordens de Serviço abre a tela clássica quando `work` não tem tipo nem
registro. Respostas de catálogo sem uma lista válida são tratadas como vazias,
incluindo os casos `{}`, `data: null` e `data: {}`.

## Falhas confirmadas nas verificações externas recebidas

### Pedido confirmado sem gravação

O carrinho de um contato comprovado prepara, no lote do pedido, uma intenção
para completar o nome. `selfCustomerStatements` acrescenta
`ON CONFLICT(profile_id,command_id) DO NOTHING` ao `INSERT ... SELECT` produzido
por `jobInsert`. Sem `WHERE` no SELECT externo, SQLite interpreta `ON` como
parte de um JOIN e falha com **`near "DO": syntax error`**.

Isso desfazia o lote com pedido e histórico. O passo web já estava concluído;
seu gancho captura erros, então a página podia mostrar “Pedido enviado!” sem
existir pedido. Pagamento e acompanhamento falhavam em sequência por não
encontrarem o registro.

`jobInsert` agora termina o SELECT externo com `WHERE 1`, eliminando a
ambiguidade. Permanecem a atomicidade do lote, a chave de idempotência e o teto
da fila. Com a fila cheia, o pedido é salvo e a intenção fica `retained`, sem
payload, com `customer_queue_full`. O nome do contato não é alterado
antecipadamente.

O diagnóstico offline daquela rodada, usando as funções reais, reproduziu o
erro anterior e aprovou a versão corrigida, com fila livre e cheia,
repetição do pedido, repetição do INSERT da intenção e acompanhamento.

### Respostas ausentes no detalhe legado do contato

`contactDetail` selecionava somente metadados dos passos concluídos e retirava
`answers`, contrariando `tests/web-steps.test.ts`. A regra de minimização do
histórico novo havia sido aplicada também ao envelope publicado do detalhe.

O detalhe voltou a projetar `answers` a partir de `result`. A consulta mantém o
proprietário histórico persistido, os limites de área/namespace e as permissões
de Contatos, Conversas e módulo habilitado. Saúde, Ensino e Jurídico continuam
excluídos. `result` bruto e esquema do formulário não são expostos.

O histórico e as coleções novas continuam administrativos, sem respostas.
O diagnóstico confirmou as respostas para o administrador autorizado, a
negativa sem as permissões necessárias, a negativa com o módulo desligado e a
ausência das respostas tanto no histórico quanto no contato que recebeu a
conversa posteriormente. Essa distinção foi registrada em `FASE1-CONTRATO.md`.

### OS com contato confirmado e telefone administrativo diferente

`conversationOf` delega a `workCustomerAllows`. A autorização reconhecia o
contato dono da ordem, mas a verificação adicional de destinatário exigia que
o telefone informado na OS coincidisse com o da conversa ou estivesse no
índice telefônico do contato. Os testes antigos criam uma ordem com conversa
confirmada e outro telefone no snapshot administrativo. A nova exigência
recusava a conversa original, impedindo aprovações de etapa, notificações de
transição e lembretes. A aprovação falhava com `no_conversation` na linha 80
de `stages.ts`, apresentada ao usuário como ação indisponível.

A autorização agora consulta uma vez o escopo de identidade e relê
`contact_id`, `conversation_id` e `phone` da ordem. Quando a conversa persistida
e seu titular comprovado coincidem com o contato persistido na ordem, o
snapshot de telefone não impede o envio. Outros destinatários continuam
exigindo as provas telefônicas anteriores. Grupos, aplicações sem credencial
de canal, estados restritos, conflitos e outro proprietário continuam recusados.
A linha antiga que um chamador tenha em memória não substitui a leitura atual.
Nenhum telefone ou vínculo é reescrito por essa autorização.

### OS de balcão anterior à primeira conversa

Os testes de tarefas abrem a OS pelo painel antes de o cliente escrever e,
depois, vinculam a conversa à ordem. O contato automático e o registro da
sessão surgem nessa primeira mensagem. `legacyRoutineOwner` exigia que essa
sessão fosse anterior à OS; o fallback local também exigia que a ordem fosse
posterior à criação da conversa. Ambos recusavam a origem legítima, deixando
`processed=0` e todos os avisos ao cliente pendentes.

Somente para OS de origem `panel`, `staff` ou `agent`, o limite de origem
considera também a criação da conversa persistida. Isso admite a primeira
sessão de uma conversa criada depois da ordem. Continuam obrigatórios:
índice original na versão 1, ausência de colisão/candidato cadastral, telefone
sem edição, conversa permitida e nenhum histórico de outro titular. Sessão
posterior de uma conversa já existente continua insuficiente. A alteração
não muda o corte temporal de Agenda, Pedido, Reserva ou Mensalidade.

As duas reproduções falhavam antes da correção e passam depois dela. O
agendador real enviou dez lembretes com **95 instruções SQL**, dentro do
orçamento inalterado de 200; a repetição consumiu quatro instruções e não
duplicou mensagens. Os diagnósticos negativos preservaram a recusa de estados
restritos, índice revisado, candidato cadastral, telefone editado, sessão
posterior, histórico de outro titular e proprietário alterado no banco.

## Testes acrescentados e ajustes dos testes desta frente

| Arquivo | Cobertura ou motivo do ajuste |
| --- | --- |
| `tests/management-demo.test.ts` | Resposta real de status da demonstração; seis módulos nativos resolvidos; Agenda permitida; nativos antes dos portados. |
| `tests/management-work-entry.test.ts` | Alias antigo para a tela clássica; catálogo ausente ou inválido; tipo desconhecido e abertura de registro. |
| `tests/management-navigation.test.ts` | Cartões por grupo, nomes/vocabulário, limite de cinco, destino de Ver todos e ordenação também na montagem final; expectativa de landing atualizada para a rota canônica. |
| `tests/management-ported.test.ts` | Redirecionamento por replace, consulta/fragmento e publicação na ponte; porta da ficha e corpo bruto; fixture completada com os campos de `CatalogRecord` e comparação de papéis tipada com a mesma semântica. |
| `tests/management-catalog.test.ts` | Confere separadamente URL canônica da casa e alias publicado do menu legado, mantendo cobertura de todos os destinos, grupos e permissões. |
| `tests/c-ficha.test.ts` | Importa a função pura de título sem o grafo de UI; mantém vocabulário e acrescenta a mensagem de cadastro automático. Usa o provedor Ensino já registrado e restaura o spy de `section` após cada caso. |
| `tests/c-fronteira-erp.test.ts` | Confirma registro e encaminhamento de `authorizeProfile`, além da presença de `list` e `maintain`. |
| `tests/c-cadastro.test.ts` | O caso S3 mantém a proteção contra reassociação e leituras sem permissão. Acrescenta respostas no detalhe autorizado e verifica a ausência de dados privados no histórico. A asserção sem respostas passou à interface para a qual o contrato exige essa projeção. |
| `tests/c-integracao.test.ts` | Nove casos com identidade real: os dois cenários de pedido/fila; aprovação da OS com telefone administrativo diferente e veto após restrição/troca de titular; dez lembretes de OS anterior à conversa com teto de 200 instruções e deduplicação; cinco cenários negativos de origem/identidade. Os casos anteriores foram preservados. |
| `tests/c-entrada.test.ts` | Compatibiliza somente a elegibilidade geral de navegação com a versão publicada. Conserva todas as negativas de menu/destino privado; a correção no registro da casa atende a essas expectativas. |
| `tests/c-identidade.test.ts` | Isola os IDs de E7 por perfil, mantendo as medições e os tetos; canal tipado como string para testar identificadores legados. |
| `tests/c-privacidade.test.ts` | Acrescenta as direções reais do motor e a proteção de sessão sem vínculo explícito; mantém integralmente os casos de ambiguidade/restrição. |
| `tests/c-rotinas.test.ts` | M10 usa resolução real e provas persistidas, inclusive na troca de titular; preserva as expectativas anteriores e acrescenta a integridade do recibo histórico e o acesso da segunda linha. Nesta rodada, substitui o segundo registro explícito por um spy do resolvedor da porta já instalada, restaurado em `afterEach`, sem alterar as asserções. |
| `tests/f1-base.test.ts` | Substitui a proibição textual incompatível com `modules-api` por exigências de escopo da associação panel; mantém o cache, os custos, as recusas e a ausência de ERP. |

Nenhum teste antigo foi alterado, removido ou marcado para pular. Os testes
modificados pertencem às famílias permitidas `c-*`, `f1-*` e `management-*`. Os
limites de custo e de pacote foram mantidos.

## Origem, migrações e escopo

`web/erp/ORIGEM.json` registra os quatro arquivos portados alterados:
`App.tsx`, `components/ContactEditor.tsx`, `components/RealAccess.tsx` e
`lib/fagoo-menu.ts`. A conferência automática do manifesto passou.

Há 90 migrações D1, sem numeração duplicada. As migrações da frente são
`0130`, `0131`, `0132` e `0133_customer_identity_proof.sql`; a `0133` já veio
da junção e é aditiva. Nenhuma migração foi criada ou editada nesta integração.
Todas foram aplicadas a um SQLite vazio no diagnóstico. Não houve alteração
nas migrações/esquema do ERP.

Não houve commit, acesso à rede nem execução de Vitest. Nenhuma nova
dependência foi instalada. A guarda de textos do ERP passou.

## Verificação das rodadas iniciais e limites

| Verificação | Resultado |
| --- | --- |
| `tsc --noEmit` (via `npm run check`) | Aprovado. |
| `npm run check` | Aprovado: geração de informações de build, marcadores de conflito, codificação, CSS do ERP e TypeScript. |
| TypeScript dos nove arquivos de teste novos/ajustados | Aprovado com configuração temporária que inclui os tipos Cloudflare e as declarações DOM do projeto, sem executar testes. A checagem revelou a fixture incompleta do contato, corrigida em `management-ported.test.ts`. |
| `npm run test:erp:painel` completo | **2.213 aprovados, zero falhas**, em aproximadamente 189 segundos. |
| Build Vite em memória de `web/erp/build.test.mjs` | Aprovado dentro da suíte anterior; orçamento inalterado, inclusive tetos de 1.208 KiB e 352 KiB gzip. |
| Diagnóstico Node/SQLite com funções reais | 17 cenários aprovados: os cinco anteriores de Pedido, detalhe/histórico e identidade, mais 12 de OS (duas reproduções, lote de dez lembretes, oito recusas e leitura do proprietário atual). Não substitui o Worker/D1. |
| Migrações | 90 aplicadas em SQLite vazio; nenhuma numeração duplicada ou alteração local. |
| `git diff --check` | Aprovado. |

Artefatos locais de apoio: `/tmp/c-integra-check.log`,
`/tmp/c-integra-erp-painel.log` e `/tmp/c-integra-diagnostico/` (bundles offline,
reprodutores `probe.mjs` e `probe-os.mjs`, comparação `os-before.log` /
`os-after.log`, configurações de checagem de tipos e logs). O diagnóstico bloqueia qualquer tentativa de
`fetch`; os adaptadores de teste não implementam HTTP, R2 ou Durable Objects.

**Não exercitado nas rodadas anteriores:** Vitest completo ou parcial; execução
dos novos testes dentro do Worker; métricas `rows_read` e limites reais de D1;
fluxos HTTP/Coordinator/ERP/R2; pagamentos externos; inspeção em navegador;
`npm run build` com emissão de artefatos. O build exercitado aqui é o build em
memória exigido pela suíte Node.

O aceite global depende da nova execução externa de
`npm run check && npm run build && npm run test:erp:painel && npx vitest run`.
O estado atual e seus resultados locais estão no início deste relato. O
aceite não é inferido dos diagnósticos locais. Nesta rodada, continuam fora
do exercício local: execução Vitest/Worker, `npm run build` com emissão de
artefatos, métricas reais de D1, Coordinator/ERP/R2 reais, provedores externos,
pagamentos e navegador. Não há alteração funcional aguardando decisão do usuário.
