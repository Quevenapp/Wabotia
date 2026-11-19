# Integração da fase 1 e da casa única — relato completo

Atualizado em 19/11/2026. Tarefa: `/Volumes/Dev/wabotia/tarefas/c-integra.md`.
Base Git: `fefbdf08`. Este documento reúne as correções da integração já
presentes na área de trabalho e a investigação da última verificação externa.
O relato antigo `UN-CASA-BASE-RELATO.md` pertence à tarefa anterior da Base.

## Estado da entrega

As correções descritas abaixo estão aplicadas, sem commit. `npm run check` e
`npm run test:erp:painel` passaram nesta rodada: **2.213 testes do painel
aprovados, zero falhas**, incluindo orçamento do pacote inicial, isolamento dos
chunks, demonstração, manifesto de origem e guarda dos textos de tela.

A validação global continua pendente. O arquivo `.codex-verificacao.log` tem
somente 200 linhas e agora registra **17 arquivos com falha, 269 aprovados;
50 testes com falha, 2.835 aprovados e 33 ignorados**, de 2.918. O trecho
identifica falhas em `os-tasks.test.ts` e `os-work-types.test.ts`; começa no
fim de outra falha de tarefas. Não contém os nomes nem os erros dos outros
15 arquivos. Foi preservado e o caminho do log completo foi solicitado.

Duas causas de OS foram reproduzidas e corrigidas nesta rodada. Isso não
comprova a resolução de todas as 50 falhas. A verificação externa anterior
registrava 115 falhas; suas correções de Pedido e detalhe do contato continuam
aplicadas e foram novamente verificadas no diagnóstico offline. A redução dos
totais não permite afirmar quais casos passaram sem o log completo.

## Causas e correções dos itens originais

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
do ERP. O carregamento efetivo desse arquivo no Worker depende da nova
verificação externa.

### 3. Leituras excessivas com checkpoint de identidade completo

Na consulta de candidatos, a subconsulta que recupera os telefones de um
contato podia usar o índice por namespace/telefone e percorrer candidatos da
área inteira. O checkpoint já dispensava a página de legado, mas não essa
subconsulta. Ela agora usa explicitamente
`INDEXED BY customer_phone_candidates_contact`.

O teste E7 de `tests/c-identidade.test.ts` permaneceu intacto, inclusive os
limites de 600 linhas, 25.000 caracteres de resposta e 40.000 de plano. O
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

O diagnóstico offline usando as funções reais reproduziu o erro na versão
anterior desta rodada e aprovou a versão corrigida, com fila livre e cheia,
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
| `tests/c-ficha.test.ts` | Importa a função pura de título sem o grafo de UI; mantém vocabulário e acrescenta a mensagem de cadastro automático. |
| `tests/c-fronteira-erp.test.ts` | Confirma registro e encaminhamento de `authorizeProfile`, além da presença de `list` e `maintain`. |
| `tests/c-cadastro.test.ts` | O caso S3 mantém a proteção contra reassociação e leituras sem permissão. Acrescenta respostas no detalhe autorizado e verifica a ausência de dados privados no histórico. A asserção sem respostas passou à interface para a qual o contrato exige essa projeção. |
| `tests/c-integracao.test.ts` | Nove casos com identidade real: os dois cenários de pedido/fila; aprovação da OS com telefone administrativo diferente e veto após restrição/troca de titular; dez lembretes de OS anterior à conversa com teto de 200 instruções e deduplicação; cinco cenários negativos de origem/identidade. Os casos anteriores foram preservados. |

Nenhum teste antigo foi alterado, removido ou marcado para pular. Os testes
modificados pertencem às famílias permitidas `c-*` e `management-*`. Os
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

## Verificação realizada e limites

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

**Ainda não exercitado nesta rodada:** Vitest completo ou parcial; execução
dos novos testes dentro do Worker; métricas `rows_read` e limites reais de D1;
fluxos HTTP/Coordinator/ERP/R2; pagamentos externos; inspeção em navegador;
`npm run build` com emissão de artefatos. O build exercitado aqui é o build em
memória exigido pela suíte Node.

O aceite global depende da nova execução externa de
`npm run check && npm run build && npm run test:erp:painel && npx vitest run`.
Caso falhe, é necessário o log completo para identificar também os erros que
não aparecem nas 200 linhas recebidas. Este relato não declara resolvidas
falhas cujo nome ou causa ainda não está disponível.
