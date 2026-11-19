# Cadastro único — contrato da fase 1

Referência do levantamento: `integra/unico`, commit `d017b957`, versão 0.22.0.
Este documento fixa as portas, migrações, rotas e responsabilidades da fase 1.
Não afirma que as funcionalidades das tarefas paralelas já estejam implementadas.

## A1. Autoridade e limites

- O identificador canônico é `contacts.id`. O ID ERP é associado, único por área,
  sem exigir igualdade de IDs. O ERP gera seu UUID.
- O D1 contém atendimento, identidade telefônica, fila de comandos e espelho curto.
  A ficha completa fica no SQLite do `Coordinator` existente, instância `erp:<área>`.
  O objeto ERP não lê D1; não há transação entre D1 e ERP.
- Não criar classe de Durable Object, recurso Cloudflare, tabela, gatilho, diário
  ou alias no esquema ERP. Reconciliação usa versões e varredura retomável.
- Histórico consulta fontes autorizadas; não copia mensagens para uma cronologia.
- Resolver ambiguidade escolhe um contato com versão e auditoria, sem fundir
  fichas nem reapontar registros antigos. Fusão integral fica fora desta fase.
- Tipos de extensão pertencem à extensão. As declarações cadastrais não habilitam
  módulos nem concedem acesso.
- Exclusão registra intenção durável, restringe leitura e impede reconstrução.
  Enquanto faltarem inventário de cópias e retenções, retorna `retained` com motivo.
  Os impedimentos de retenção da Saúde continuam valendo.

## A2. Migrações congeladas

Somente a base escreve migrações; não renumerar antigas, reconstruir tabelas nem
consumir 0120–0129. SQL normativo:

| Migração | Conteúdo |
| --- | --- |
| [0130_customer_identity.sql](../migrations/0130_customer_identity.sql) | Campos do contato e conversa, índice de identidade, candidatos e progresso |
| [0131_customer_workflow.sql](../migrations/0131_customer_workflow.sql) | Jobs, vínculos de registros, versões das seções e guardião de lote |
| [0132_customer_relations.sql](../migrations/0132_customer_relations.sql) | Vínculos administrativos das extensões e relações do Condomínio |

A inicialização copia somente telefones já compostos por 8–15 dígitos. Não altera
contatos, duplicados, namespaces de aplicações ou vínculos existentes. Os demais
formatos são tratados pelo preenchimento TypeScript. O SQL foi mantido exatamente
como contratado: seu `CHECK` não recusa zero inicial; o normalizador e as leituras
de identidade devem recusar esse valor como telefone canônico/prova.

`customer_records` serve somente a fontes sem `contact_id` próprio: sessões de
conversa, protocolos, fila e registros do Suporte. Não duplicar vínculos de Agenda,
OS, Pedido, Reserva, formulários ou assinaturas. Sessão usa `conversationId:session`
como `recordId`.

`customerRecordStatements` deve entrar inteiro no mesmo lote D1 da origem. Repetir
o vínculo preserva todos os metadados originais. Outro contato faz o `CHECK` do
guardião falhar e reverte o lote: a resolução explícita pertence ao comando
autorizado, nunca a este helper. A chave do guardião usa a origem estável e a etapa
`contact`; não há `commandId` em `CustomerRecordLink`. Nos comandos de atualização
condicionada, derivar o guardião de `commandId` + etapa e conferir `changes()=1`
imediatamente depois do `UPDATE`. Não usar `INSERT OR IGNORE` para o guardião.

As atribuições a `mensalidade_payers.contact_id`, `cond_people.contact_id`,
`ensino_guardians.contact_id`, `ensino_enrollments.billing_contact_id` e
`cond_unit_subscriptions` conferem também a área no comando. A FK simples não
substitui essa verificação. O `CHECK` original de `cond_memberships` fica intacto.

## A3. Tipos, fachadas e registros permanentes

Os contratos TypeScript normativos estão em
[contracts.ts](../src/customer/contracts.ts) e
[profile-contracts.ts](../src/customer/profile-contracts.ts).
As implementações registram objetos em [ports.ts](../src/customer/ports.ts):

| Implementação | Registro | Fachada |
| --- | --- | --- |
| Identidade | `installIdentityPort` | `identityPort`, `resolveCustomer` |
| Escrita | `installWritePort` | `writePort`, `enrichCustomer` |
| Histórico | `installHistoryPort` | `historyPort` |
| Ficha | `installProfilePort` | `profilePort` |
| Ponte ERP | `installErpBridge` | `erpBridge` |
| Extensão | `registerCustomerProvider(moduleId, provider)` | `customerProvider(moduleId)` |

O registro é explícito no ponto de entrada que pertence à tarefa. As fachadas não
importam implementações e mantêm sua referência depois da instalação. O mesmo
objeto pode ser registrado novamente; outro objeto no mesmo registro é erro.
Não registrar a própria fachada como implementação. Não há reset de produção
das portas; testes isolados podem recarregar o módulo e registrar uma simulação.

Sem implementação, `resolve` e `prepareInbound` ficam `pending`, sem ID, telefone
comprovado ou instruções. `indexContact` falha com `503 dependency_unavailable`.
A manutenção de identidade informa pendência e consumo zero. Escrita, histórico
(inclusive memória) e perfil falham com `503 dependency_unavailable`, nunca
produzem cadastro salvo, histórico vazio completo ou contadores inventados.
A ponte `apply` retorna `{status:"paused",reason:"awaiting_proof"}`; suas leituras
e varreduras falham com `dependency_unavailable`.

`resolveCustomer` delega exclusivamente à identidade D1. Reutiliza promessas
somente no `Env` de invocação criado por `withReadCache`, com chave incluindo o
estado da conversa; falhas não ficam em cache. As operações de identidade e
escrita invalidam esse cache. Não persistir esse `Env` entre invocações. A
implementação de identidade também deve respeitar o cache quando chamada
diretamente. Uma tarefa que grava índice/vínculo deve passar pela porta de
identidade e atualizar os marcadores da conversa no mesmo lote.

`ModuleContext` estende `CustomerModuleApi`. `customer()` resolve a referência;
`enrichCustomer()` exige contexto do Coordinator, área correspondente e acesso
de escrita, além da autorização da implementação. `contact()` continua aceitando
conversa ou ID, resolve uma vez e projeta os campos antigos por ID/área/namespace,
somente para vínculo `ready` e contato ativo; não consulta um segundo índice.

[feature.ts](../src/customer/feature.ts) contém a única decisão do cadastro
completo: `isFullCustomerEnabled(env, profileId)` usa
`moduleEnabled(env, profileId, "erp")`, com a leitura compartilhada já existente.
Nenhum consumidor testa `"erp"` diretamente para essa finalidade.

[host-port.ts](../web/contact-profile/host-port.ts) registra um carregador tardio
de `FullCustomerHost`, sem importar componentes portados. Mesmo carregador é
idempotente; outro carregador simultâneo é recusado. `null` remove o registro no
descarte da área. Sem registro, `loadFullCustomerHost` falha com
`dependency_unavailable`, sem abrir outro editor. Falha de carregamento permite
nova tentativa. O hospedeiro monta na área recebida e entrega `dispose()`.

`maintainCustomers` chama sequencialmente identidade, escrita, histórico e os
provedores com manutenção, estes em ordem de ID. Cada participante recebe uma
cópia do saldo e retorna consumo efetivo; o orquestrador debita uma vez, sem
modificar o orçamento original. Limite total: 40 instruções/20 itens. O
participante deve limitar seu trabalho **antes** de executar SQL, respeitar
ativação/autorização pertinente e informar pendência. Consumo inválido ou acima
do saldo é erro. Portas principais ausentes deixam o agregado pendente, sem
impedir as instaladas de trabalhar. Esgotamento deixa os demais para a próxima
invocação. O orquestrador não chama a ponte por conta própria.

## A4. Catálogo compilado da ficha

[declarations.ts](../src/customer/declarations.ts) complementa os `definition.ts`
reservados. `moduleView` prefere `ModuleDefinition.customer_profile`, depois o
catálogo, depois `null`, preservando todos os campos anteriores, inclusive
`management` e `erp_role`. Exibir declaração no catálogo não habilita a contribuição
na ficha: a ficha e seus endpoints verificam estado e autorização.

| Módulo | IDs locais |
| --- | --- |
| `os` | `works`, com `titleKey: "works"` e vocabulário do tipo |
| `agenda` | `appointments` |
| `pedido` | `orders` |
| `reserva` | `bookings`, incluindo `checkinStatus` |
| `mensalidade` | `subscriptions`, `installments` |
| `suporte` | `sessions`, `purchases`, `releases` |
| `queue` | `tickets` |
| `forms` | `submissions`, sem respostas |
| `condominio` | seção `units`; `deliveries`, `visits`, `occurrences`, `dues` |
| `saude`, `ensino`, `juridico` | seção `private`, apenas navegação autorizada |
| `erp` | `sales`, `open_titles`, `ledger`, com autorização ERP própria |

`source` é a chave lógica `<módulo>.<id>` do provedor, não uma tabela consultável.
As tabelas usam `cells.id` (referência), `cells.status` e `cells.occurredAt` (instante
em ms); Reserva acrescenta `cells.checkinStatus`. Ausência de dado usa `null`.
`policy` é uma declaração, nunca uma permissão conferida pelo cliente:

- `module`: autorização específica do módulo e do registro no provedor.
- `private`: acesso especializado, sem conteúdo privado no agregador.
- `erp`: sessão, papéis e permissões granulares ERP próprias.
- `condominio.dues`: autorização do Condomínio e da Mensalidade, esta ligada
  (`enabledWith: ["mensalidade"]`), com relação explícita unidade–assinatura.
  Nunca inferir débitos ou direitos eleitorais por telefone.

Condomínio declara `morador`, `proprietario`, `inquilino`, `dependente`, `sindico`,
`zelador`, `porteiro`, `prestador`, `empregado_unidade`, `visitante_recorrente`.
Derivar morador e subtipos dos vínculos existentes; `funcionario` do vínculo pode
ser projetado como `empregado_unidade`, sem alterar o `CHECK`. Funções adicionais
ficam na tabela aditiva. `dependente` tem projeção `private`; menores continuam
exclusivamente no domínio protegido, sem enriquecimento ou promoção.

As listas D1 usam os vínculos próprios de Agenda, OS, Pedido, Reserva e
Mensalidade. Saúde, Ensino e Jurídico não exportam nomes de menores, diagnósticos,
contadores ou resumos privados. Seus vínculos por IDs são escritos no contexto
autorizado da extensão.

## A5. Rotas

Prefixo `P = /api/v1/profiles/:profile`. Respostas novas usam os nomes camelCase
dos contratos; campos antigos permanecem no formato atual.

Escritas usam o Coordinator e `Idempotency-Key`. O `commandId` interno deriva do
identificador estável já calculado pelo Coordinator, **não** de `X-Request-Id`.

| Método e caminho | Entrada | Resposta |
| --- | --- | --- |
| `GET P/contacts` | Filtros existentes; `identity=identified\|phone_only\|all`; `review=inactive180` | Envelope existente, `incomplete` e projeção explícita dos contatos |
| `GET P/contacts/:id` | — | Envelope existente; acrescentar referência, estado e sincronização |
| `PATCH P/contacts/:id` | Campos simples existentes, `expected_version`; aceitar `customer: CustomerWrite` | `200` local ou `202` pendente; preservar campos antigos e acrescentar resultado |
| `POST P/contacts/:id/promote` | `CustomerWrite` | `202 CustomerWriteResult` |
| `POST P/contacts/from-erp` | `{erpId}` | `200` vínculo existente ou `202` job de associação; não cria pessoa no ERP |
| `GET P/contact-conflicts` | Cursor, limite | Identidades ambíguas e jobs em conflito, somente candidatos autorizados |
| `POST P/contact-identities/resolve` | `{namespace,phone,expectedVersion,contactId,reason}` | `200`, nova versão; não funde históricos |
| `GET P/contact-jobs/:id` | — | `CustomerJobView`, sem payload cifrado |
| `POST P/contacts/:id/erasure` | `{expectedVersion,reason,confirm:true}` | `202 CustomerJobView`; administrador humano |
| `GET P/contacts/:id/history` | `limit=20`, máximo 50; cursor | `HistoryPage` |
| `GET P/conversations/:id/customer-history` | Mesma consulta | `HistoryPage`, com projeção limitada à autorização da conversa |
| `GET P/contacts/:id/profile` | — | `ContactProfileView` |
| `GET P/contacts/:id/modules/:module/collections/:collection` | `limit=25`, máximo 100; cursor | `ContactPage` |
| `GET P/contacts/:id/modules/:module/sections/:section` | — | `SectionView` |
| `PUT P/contacts/:id/modules/:module/sections/:section` | `SectionWrite` | `SectionView & {replayed:boolean}` |

O detalhe legado (`GET P/contacts/:id`) conserva `web_steps[].answers` dos
formulários vinculados ao contato para quem pode ler Contatos, a conversa e o
módulo habilitado. A associação histórica prevalece sobre uma reassociação
posterior da conversa; os módulos privados permanecem excluídos. Isso não altera
a projeção administrativa de `history` e das coleções da ficha única, que segue
sem respostas, esquema de formulário ou notas privadas.

Erros comuns:

- `400 invalid_request`, `invalid_cursor` ou `invalid_customer_patch`.
- `401 unauthorized`; `403 forbidden`.
- `404 not_found` também para contato, job ou candidato de área/namespace alheio.
- `409 contact_conflict`, `customer_ambiguous`, `idempotency_conflict`,
  `namespace_conflict`, `customer_erasing`, `module_disabled` ou `sync_pending`.
- `422 contact_required`, com campos faltantes.
- `503 dependency_unavailable` para implementação ausente ou indisponível;
  falha transitória após job persistido aparece como pendência, sem perder o pedido.

A API antiga mantém `identity=all` quando não enviado. A interface de clientes
envia `identified` por padrão. A ficha exige pessoa autenticada. Aplicações
conservam APIs simples e seus namespaces; `contacts:read` sozinho não libera ficha
completa. Rotas sob `contacts` verificam explicitamente o estado do módulo, pois o
portão existente considera o primeiro segmento.

## A6. Comportamento obrigatório

### Identidade e entrada

- Telefone canônico: 8–15 dígitos, primeiro diferente de zero. Aceitar somente
  separadores conhecidos e `+` inicial. Nunca extrair dígitos de texto, JID LID ou
  nome. `normalizeCustomerPhone` aceita strings e recusa JIDs e extensões.
- `international` não acrescenta DDI nem altera nono dígito. `human_br`, escolhido
  explicitamente pelo formulário/importação, acrescenta 55 a 10/11 dígitos com DDD;
  aceita 12/13 dígitos já iniciados por 55. `+` explícito conserva o internacional.
  Sem DDD, prefixo zero ou código de operadora, retorna `null`; não adivinha região.
- Variantes antigas servem somente à revisão. Não reutilizar a função legada que
  acrescenta DDI/nono dígito como autorização.
- `team` reúne canais autenticados da área. `app:<id>` é isolado; entrada de
  aplicação não comprova telefone.
- QR só fornece telefone de JID telefônico comprovado. Não separar qualquer
  identificador em `@` e chamá-lo de telefone. Zernio não usa `sender.id` arbitrário
  como fallback telefônico.
- Novo número autenticado cria contato com `name=''`, origem `automatic`, sem ERP.
  O painel usa telefone como rótulo. Isso funciona com todos os módulos desligados.
- Dois candidatos deixam identidade `ambiguous`; número e conversa permanecem
  salvos. Não criar terceira ficha, fusão ou histórico cruzado.
- `pending`: falta prova/resolução; `blocked`: desvinculação humana; `excluded`:
  grupo, origem inelegível ou contato restrito para aquela leitura. Nenhum desses
  estados libera busca ampliada por telefone.
- Mudança do telefone observado revalida identidade. Mudança no índice invalida
  marcadores das conversas afetadas no mesmo lote.
- Contato, índice, vínculo e marcador entram no lote que confirma a inbox, depois
  de deduplicá-la. Mesmo telefone já resolvido e webhook repetido têm meta de zero
  instrução adicional de identidade. Não consultar cadastro/ERP a cada mensagem.

### Legado e preenchimento

A migração inicializa candidatos canônicos. O preenchimento trata formatos
restantes e vínculos em lotes de até 20 registros, com checkpoint atômico. Antes de
criar contato durante preenchimento incompleto, consultar candidatos legados
normalizados daquele namespace; índice incompleto não comprova ausência.

Relação preenchida não muda por nova associação da conversa. Sessões novas recebem
vínculo próprio em `customer_records`, origem `conversationId:session`. Identidade
inequívoca ausente permanece pendente. Fallback legado limita-se à conversa
original autorizada; não reintroduzir busca ampla por telefone.

Na OS, o telefone informado na ordem é um snapshot administrativo: quando o
contato persistido e o titular comprovado da conversa destinatária concordam,
esse telefone pode diferir do número do canal. A autorização relê o proprietário,
a conversa e o telefone persistidos, inclusive em repetições; uma linha antiga em
memória não concede acesso após mudança do proprietário.

Uma OS de balcão pode existir antes da primeira conversa vinculada pela equipe.
Para esse legado sem proprietário, a sessão inicial da conversa também serve
como limite temporal da origem. Permanecem obrigatórios o índice original
inequívoco, telefone sem edição e ausência de histórico de outro titular. Uma
sessão posterior de uma conversa já existente não transfere a ordem. A leitura
ou o envio não grava nem substitui o proprietário.

### Autoridade e enriquecimento

- `resolveCustomer` é leitura D1 com cache por invocação, sem promoção ou acesso ERP.
- Cadastro desligado: nome, telefones, e-mail e documento administrativo podem ser
  completados no D1. `company` e `notes` continuam locais.
- Endereço cadastral não vira espelho permanente. Para promoção, fica apenas na
  intenção cifrada até entrega ao ERP. Endereço de entrega não vira endereço
  pessoal automaticamente.
- Cadastro ligado: ERP é autoridade dos dados completos; D1 recebe apenas
  `CustomerMirror`, ID e versão. Notas do atendimento não vão às observações ERP.
- `fill_empty` preenche vazios; divergência gera revisão. `replace_confirmed` exige
  pessoa com permissão correspondente e versões atuais.
- Abrir ficha, ligar ERP ou executar preenchimento não promove contatos em massa.
- Ao desligar ERP depois da associação, preservar vínculo e último espelho;
  alterações locais ficam separadas. Ao religar, comparar espelho anterior,
  alteração local e ERP atual. Mesmo campo alterado dos dois lados gera conflito.
- Documento exige validade e candidato único para correspondência. Documento
  digitado não prova titularidade nem concede acesso. Pagador e telefone
  autorizado continuam separados.

### Ponte, repetição e queda

Persistir toda intenção antes de chamar ERP. Após timeout, repetir comando, ator e
corpo imutáveis. O recibo ERP já confere ator e hash.

Uma fila por contato, ordenada por criação e ID; conflito bloqueia os comandos
posteriores daquele contato. Lease vencida permite retomada. Confirmação de
espelho, índice telefônico e conclusão do job formam lote D1 condicionado à versão.

A ponte revalida ativação antes da chamada e antes de aplicar retorno. Retorno
atrasado não sobrescreve edição local. Desligamento pausa jobs ERP; manutenção D1
continua.

Sem diário ERP, reconciliar com varreduras retomáveis por ID e comparação de
versões. Antes de gravações ERP pelo Worker, marcar reconciliação duravelmente;
depois, tentar leitura direcionada. A varredura cobre importações, falhas
intermediárias e caminhos desconhecidos da leitura direcionada. Falha de leitura
nunca significa cadastro vazio.

Somente após a prova, o adaptador decide identidade executora e requisitos mínimos.
Não atribuir antecipadamente papel `vendas` ao atendimento nem contornar MFA. O RPC
atual exige nome e admite requisitos configuráveis.

### Ficha, listas e privacidade

- Vocabulário: configuração explícita da área, depois modelo, depois
  Cliente/Clientes; ler mesmo com OS desligado. Reutilizar contrato e validação OS.
- Seção tem autorização, versão e salvamento próprios, fora do formulário
  cadastral. Papel de extensão edita só sua seção; escrita completa preserva
  autorização ERP e permissão granular.
- Módulo desligado: contribuição desaparece, endpoint direto retorna 409, dados
  permanecem.
- Autorizar histórico/listas antes de paginar. Cursores opacos autenticados incluem
  área, namespace, contato, contribuição, filtros, corte temporal e última chave.
  D1 usa data imutável + ID, sem `OFFSET`.
- Histórico inclui sessões, protocolos, fila, conclusão de formulário e check-in
  da Reserva. Exclui mensagens, respostas, notas internas e `checkin_answers`.
- IA recebe exclusivamente `CustomerMemory`, por leitura solicitada e limitada.
  Não criar consulta obrigatória a cada execução do motor. Projetar antes de
  aplicar máscara.
- Prontuário, dados de menores, identidade cifrada e conteúdo escolar/processual
  privado nunca entram em contato, espelho, job cadastral, WhatsApp, IA, ERP ou
  exportação comum.
- Número técnico não autoriza enriquecimento de menores. Extensões protegidas
  vinculam responsável adulto por ID e recusam exportar dados do dependente.
- Respostas privadas usam `Cache-Control: no-store`. Troca de área, pessoa, sessão
  ou módulos cancela leituras e descarta respostas atrasadas.
- Contato só telefônico, sem relação comercial nem interação há 180 dias entra em
  revisão. Fila e formulário contam como interação. Não há exclusão automática.

### Orçamento e publicação

Manutenção roda em invocação dedicada do Coordinator existente, com orçamento
total compartilhado de 40 instruções e 20 itens. Não acrescentar esse lote ao
alarme de mensagens.

O teto atual do primeiro inbound é 20 instruções (`tests/d1-budget.test.ts`).
Qualquer aumento exige medição antes/depois, instruções e viagens, justificativa e
registro por `f1-identidade`. Nenhum valor deste contrato é medição realizada.

## A7. Integrações reservadas da casa

| Dono/arquivo | Integração solicitada |
| --- | --- |
| Casca — `web/erp/ErpArea.tsx` | Instalar carregador dinâmico de `host-port.ts` e limpar no descarte; não carregar para ficha simples/contato não promovido |
| Portado — `web/erp/mount.tsx` | Exportar hospedeiro que reutiliza sessão, controlador, autorização e portas, monta `ErpContactBody` em raiz `.fagoo-root` exclusiva e entrega `dispose()` |
| Portado — `web/erp/ports.ts` | Callback opcional para abrir ficha por ID D1 no contexto da área; não deduzir ID D1 do ERP |
| Verificação — `docs/MODULOS.md` | Referenciar este contrato; declarações cadastrais não habilitam módulos nem concedem acesso |

A ficha pode ser diálogo, sem editar rotas de navegação, Shell ou catálogo da casa.

## B. Propriedade dos arquivos

As tarefas seguintes partem desta base e são juntadas por merge automático. Nenhuma
delas reescreve fachadas, tipos, migrações ou catálogo da base. Dependências usam
portas e simulações nos testes. Erros/omissões devem ser relatados em **Pedidos à
base**, sem editar arquivos de outro dono. Todos os arquivos não atribuídos são
reservados, especialmente `definition.ts`, navegação, esquema ERP e testes
`management-*`. O texto da matriz abaixo usa `{a,b}` para enumerar arquivos exatos.

| Dono | Arquivos |
| --- | --- |
| `f1-base` | `migrations/0130_customer_identity.sql`, `0131_customer_workflow.sql`, `0132_customer_relations.sql`; `src/customer/{contracts,profile-contracts,ports,phone,feature,declarations}.ts`; `web/contact-profile/host-port.ts`; este documento; `src/modules/{api,types,registry}.ts`; `src/types.ts`; `tests/f1-base.test.ts`, `tests/f1-base-migrations.test.ts` |
| `f1-identidade` | `src/customer/{identity,backfill}.ts`; `src/{service,coordinator,protocol-lookup,zernio}.ts`; `connectors/qr/features.mjs`; `tests/f1-identity.test.ts`, `tests/f1-inbound.test.ts`, `tests/d1-budget.test.ts`; `docs/FASE1-CUSTO-D1.md` |
| `f1-cadastro` | `src/customer/{local,jobs,http}.ts`; `src/{contacts,contact-csv,index}.ts`; `tests/f1-cadastro.test.ts`, `tests/contacts.test.ts` |
| `f1-historico` | `src/customer/history.ts`; `src/{engine,queue,queue-flow,web-steps}.ts`; `src/bot-actions/customer.ts`; `src/modules/queue-tools.ts`; `tests/f1-history.test.ts`, `tests/f1-history-privacy.test.ts` |
| `f1-rotinas` | `src/modules/{agenda,pedido,reserva}/customer-provider.ts`; `src/modules/agenda/{agenda,appointments}.ts`; `src/modules/pedido/{pedido,orders,bot,chat}.ts`; `src/modules/reserva/{reserva,bookings,checkin}.ts`; `tests/f1-rotinas.test.ts` |
| `f1-trabalhos` | `src/modules/os/customer-provider.ts`; `src/modules/os/{os,store,public,stage-replies}.ts`; `src/modules/os/documents/{access,delivery}.ts`; `src/modules/os/tasks/reminders.ts`; `tests/f1-work.test.ts` |
| `f1-pagadores` | `src/modules/{mensalidade,suporte}/customer-provider.ts`; `src/modules/mensalidade/{mensalidade,payers,store,chat,public}.ts`; `src/modules/suporte/{suporte,store,customer,flow,handoff}.ts`; `tests/f1-payers.test.ts` |
| `f1-condominio` | `src/modules/condominio/customer-provider.ts`; `src/modules/condominio/{cadastro,common,condominio,works,notices}.ts`; `tests/f1-condominio.test.ts` |
| `f1-privados` | `src/modules/{saude,ensino,juridico}/customer-provider.ts`; `src/modules/saude/saude.ts`; `src/modules/ensino/{ensino,access,customer,notices}.ts`; `src/modules/juridico/juridico.ts`; `tests/f1-private.test.ts` |
| `f1-ficha` | `src/customer/profile.ts`; `src/modules/runtime.ts`; `web/contact-profile/{ContactProfile,ErpContactBody}.tsx`, `{model,registry}.ts`, `profile.css`; `web/ContactsPanel.tsx`, `web/conversations/InfoPanel.tsx`; `web/erp/app/components/{ContactEditor,ContactList}.tsx`; `web/erp/ORIGEM.json`; `tests/f1-profile.test.ts`, `tests/f1-profile-ui.test.ts` |
| `f1-ponte-erp` | `src/customer/{erp-bridge,sync}.ts`; `src/modules/erp/customer-provider.ts`; `src/erp/api/local-fetch.ts`; `src/modules/erp/identity.ts`; `src/erp/engine/{identity,rpc-endpoint}.ts`; `tests/f1-erp-bridge.test.ts`; `docs/FASE1-PROVA-CADASTRO.md` |

Nos arquivos existentes da base, alterações limitam-se aos tipos de conversa,
`ModuleDefinition`, `ModuleContext`, montagem de contexto e projeção `moduleView`.
Preservar `management` e o módulo `erp`. A base não implementa entrada automática,
promoção, histórico, rotas HTTP, provedores ou editor completo.
