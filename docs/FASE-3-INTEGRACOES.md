# Fase 3 — integração dos módulos com o ERP

Estado em 19/11/2026: **correções da segunda revisão implementadas; `check`,
`build`, painel (2.247/2.247) e Vitest externo (3.390/3.390) aprovados**.
O motor externo teve um falso positivo de privacidade no teste protegido de
contatos (1.214 aprovações, duas falhas contando o subteste e seu pai, um TODO).
A causa foi reproduzida e a correção validada em cópia temporária; aplicá-la
depende da exceção à regra que proíbe editar o diferencial. O aceite completo
permanece pendente; ver a última retomada na seção “Segunda revisão”.
A base desta segunda revisão tinha a verificação externa inteira verde,
conforme o orquestrador. A seção “Segunda revisão” registra as novas correções
e prevalece sobre “Correções das revisões” e os registros históricos abaixo.
O fechamento já inclui a F2 e permite integrar os arquivos da F3; as antigas
pendências de autorização entre donos não se aplicam a esta tarefa.
Esta rodada não declara os três marcos aprovados. O verificador externo precisa concluir
`check`, `build`, `test:erp`, `test:erp:painel` e o Vitest integrado com
**TUDO VERDE**. Os adiamentos funcionais permanecem explícitos na seção final.

## Evidência e ordem de liberação

| Marco | Cobertura acrescentada | Situação |
|---|---|---|
| 1 — assistência técnica | Trabalho real até entrega; preço fixo/manual; catálogo com CAS; queda do lote e do recibo; desligamento; concorrência; permissões e privacidade | Motor verificado localmente; Worker/painel aguardam Vitest externo |
| 2 — restaurante e Mensalidade | Pedido e Mesas sem segunda venda no fechamento; recebimento repetido; parcela pelo líquido contratado | Transporte/motor verificados; produtores aguardam Vitest externo |
| 3 — Agenda, Reserva, Suporte, Entrega | Cobrança explícita/conclusão única; sinal separado do saldo; entrega como venda; compra de Suporte como recebível; origem bloqueada não paralisa outras | Transporte/motor verificados; produtores aguardam Vitest externo |

Liberar nesta ordem, começando por assistência técnica completa, incluindo tela,
operação manual, cancelamento e recuperação. Um teste do motor de um módulo não
libera seu fluxo operacional. Não houve ativação de módulos em instalação real
nesta revisão.

`tests/f3-aceitacao.test.ts` usa D1, produtores, adaptador, identidade e o SQLite
do Coordinator reais; substitui notificações externas e pontos de falha
controlados. Suporte usa sua projeção real junto da persistência da compra,
sem repetir a compra pelo provedor já coberta pela suíte do produtor. O arquivo
não foi executado nesta máquina. Os testes de tela acrescentados a
`tests/f3-painel.test.ts` também aguardam o verificador externo.

`tests/erp/unico/f3-aceitacao.test.mjs` executa o endpoint HTTP do motor com SQLite
real e evidência D1 em SQLite. Suas 19 provas passaram e cobrem também recebimento
local de venda com Financeiro desligado. As provas adicionais executam o SQL real da saída em SQLite e verificam CAS,
predecessor ausente, sequência, alias conflitante, queda e replay; também conferem
leitura consistente dos cortes, épocas após religamento, preservação da política explícita
e retomada da conciliação periódica ao religar a Base. Também cobrem inicialização
concorrente dos cortes, recibos e alocações imutáveis, limite de alocação,
rollback da evidência de pagamento e fluxos operacionais reais em runtime local. A suíte de
capacidade contém outras 37 provas, aprovadas na rodada anterior. A classificação da fase 2
e o diferencial de assinaturas acrescentaram **20 testes aprovados**, sem editar
seus arquivos. A confirmação completa de `npm run test:erp` desta rodada terminou
com 1.082 aprovações, zero falhas, zero pulados e um TODO preexistente (1.083 casos, saída 0); nenhum teste do diferencial foi alterado.

| Fronteira A10 | Evidência disponível |
|---|---|
| Partes, épocas, fechamento disputado, replay | Aceitação Node e capacidade aprovadas; queda entre ERP e confirmação D1 também especificada no Vitest |
| Lote operacional, dois consumidores, concessão vencida, sequência | Vitest novo; Node comprova rollback/replay do lote comercial antes/depois do commit, sequência, salto local sem pedido e inicialização concorrente dos cortes; concessão no runtime Cloudflare aguarda verificador |
| Migração em instalação usada | Todas as migrações anteriores mais 0135 em SQLite; comparação de todas as colunas antigas de OS/Agenda/Entrega e preservação de `profile_modules`; nenhuma obrigação histórica criada |
| Cliente/padrões/total e isolamento de área | Capacidade aprovada; cliente e categoria ausentes, HTTP e erro sanitizado também no Vitest novo |
| Privacidade | Capacidade recusa projeção sensível; Vitest verifica eventos, pedidos, títulos, auditoria e logs com marcadores privados |
| Poder mínimo | Sistema com `vendas`, sem pessoa/MFA, só opera sua origem; falsificações e RPCs genéricos recusados; destino manual separado; escopo revogado após sucesso, erro e rollback na suíte de capacidade |
| Backup e restauração | Dump/restauração real conserva âncoras e recibos; replay não duplica; ERP atrasado diante do D1 recusa a sequência |
| Caminho anterior sem F3 | `npm run test:erp` completo aprovado localmente, incluindo diferencial; ainda integra a próxima verificação externa |

## Autoridade e persistência

O módulo mantém a autoridade operacional no D1. O ERP mantém documentos,
títulos, baixas e movimentos no SQLite de `erp:<área>`, usando a classe existente
`Coordinator`. Não há transação distribuída. A alteração operacional e a saída
comercial pertencem ao mesmo lote D1; a chamada posterior ao motor tem sua
própria transação. O atendimento não aguarda o consumidor ERP.

| Origem | Destino comercial |
|---|---|
| Trabalho `os` | `service_orders`; aprovação prepara, primeira execução autorizada lança |
| Pedido sem mesa | `sales_orders`, com itens, adicionais e frete contratados |
| Mesas | Documento por componente `order:<id>`; taxa separada; fechar conta não cria venda |
| Entrega de Pedido | Delega à origem do pedido, inclusive frete |
| Entrega avulsa com preço autorizado | `sales_orders` com serviço de entrega |
| Mensalidade | Recebível da parcela; primeira parcela pode usar alias `contract:<id>` |
| Agenda | Recebível no gatilho explícito ou conclusão com preço; agendamento não cria dívida |
| Reserva | Recebíveis de sinal e saldo, somando o total contratado |
| Suporte avulso | Recebível da compra; mensalidade continua sendo de Mensalidade |

Esses são os caminhos implementados; a tabela de evidências distingue o que já
foi executado daquilo que aguarda aceite. Cancelamento operacional não confirma
devolução de dinheiro. Baixa e estorno exigem evidência persistida e alocação.

Na junção com a NF-e, a política `on_authorization` adia estoque e títulos dos
pedidos de venda de módulo, mesmo com seu lançamento automático habilitado.
A projeção e o recibo continuam gravados, com efeitos `skipped` e motivo
`awaiting_fiscal_authorization`; não há nova postagem no replay nem após mera
troca da política. A intenção manual existente continua disponível quando a
política permite. Pedido vinculado a módulo não recebe preparo/acompanhamento
de NF-e nesta junção, inclusive pelo RPC; emitir para essa origem e retomar
seus efeitos fiscais permanece decisão pendente. Uma emissão já enviada não
pode ter seus efeitos estornados por um cancelamento do módulo, mesmo com a
parte Fiscal desligada.

Eventos e pedidos são imutáveis. `command_id` é derivado da área, módulo,
origem e sequência; os componentes compartilham a sequência da origem.
`event_key` identifica o fato comercial. Repetir corpo/ator/chave conserva o
resultado; mudar conteúdo sob a mesma identidade é conflito. A propriedade
vem das âncoras em `erp_documents__command.result`, nunca de
`source_reference`, de um UUID informado pelo navegador ou de um papel técnico.

O salto de um evento concluído apenas no D1 exige inelegibilidade integral,
recibo local exato e ausência de pedido preparado. O motor recusa o salto se
houver recibo remoto para aquela sequência. Isso permite abrir uma OS sem
preço e acrescentar seu conteúdo comercial depois, sem ignorar efeito incerto.

## Configuração e permissões

A política comercial é por área, versionada, com `auto_post.stock` e
`auto_post.finance` inicialmente **desligados**. Cada opção só tem efeito se sua parte
estiver ligada e se um administrador autorizar a automação. O painel explica a
autoria “Sistema · módulo” e que a escolha vale somente para fatos novos, por
destino. Fatos anteriores permanecem `skipped/automation_off`, com indicação do
lançamento manual. A escolha explícita permanece nos religamentos.
Não se escolhe o primeiro depósito, categoria, forma ou conta:
os padrões precisam ser explicitamente válidos. Financeiro exige categoria
para reconhecer e conta ativa para baixar; Estoque físico exige depósito.

O cadastro é o da fase 1. Contato identificado incompleto não vira Consumidor.
Promoção ainda pode exigir pessoa autorizada; a automação sem pessoa comprovada
usa cliente já confirmado e padrões existentes. Saúde/Ensino usam responsável
financeiro e projeção comercial genérica, sem dados do menor ou prontuário.

O sistema do módulo conserva `vendas`, `is_agent=true`, sem sessão e sem fator.
A capacidade verificada autoriza operações enumeradas da própria origem, sem
conceder leitura financeira genérica, administração ou papel `financeiro`.
Os quatro RPCs F3 pertencem à Base; essa classificação não é uma autorização.

Na leitura da política, Estoque recebe somente seus padrões e sua automação;
Financeiro recebe seus campos; administrador recebe ambos. Configuração e
inicialização continuam exigindo administrador humano e a verificação de
autenticação existente. Lançamento manual conserva pessoa, papel e MFA:
Financeiro não ganha Estoque nem escrita geral no trabalho; lançamento conjunto
exige ambas as autorizações. Bots não executam essas ações.

## Rotas

Prefixo `P = /api/v1/profiles/:profile`. Escritas exigem `Idempotency-Key`.
Os RPCs `erp_module_apply`, `erp_module_origin_get`, `erp_module_command_close`
e `erp_module_manual_apply` são internos, com prova persistida; não são uma API
para o navegador montar evidência ou escolher RPC arbitrário.

| Método e caminho após P | Corpo/resultado principal |
|---|---|
| `GET /integrations/:module/status?limit=50&after=…` | Página de origens, até 100; épocas, cortes e contadores da página (`scope:page`), `next_cursor`; inclui espera manual efetiva |
| `GET /integrations/:module/sources/:id` | Estado, revisão, confirmação, entregas e vínculos permitidos ao solicitante |
| `POST /integrations/:module/sources/:id/retry` | `{event_id}` remoto (`seq` numérico); preserva pedido e comando; fato local é recusado sem apagar seu motivo |
| `POST /integrations/:module/sources/:id/replace` | `{event_id,reason_code}`; recupera/fecha antes de nova projeção |
| `POST /integrations/:module/sources/:id/post` | `{event_id,version,destinations:["finance"]}` ou Estoque/ambos; versão é revisão comercial |
| `GET/PATCH /integrations/commercial-policy` | Leitura por permissão; patch com `version` e campos explícitos |
| `POST /integrations/commercial-policy/initialize` | Padrões concretos apresentados à pessoa; usa RPCs humanos |
| `PUT/DELETE /integrations/:module/catalog/:kind/:id/:component` | `version`, e `erp_item_id` no PUT; produto existente |
| `GET /integrations/document-origins?ids=…` | Até 50 IDs; documento legível vinculado retorna `readonly:true`; origem não autorizada retorna `source:null` |
| `GET/PATCH /service-orders/:id/commercial` | Leitura plana com `version`, `revision`, `frozen`, `items`, `installments`, `authorization`; patch usa a **version pública**, não a revisão comercial |
| `POST /agenda/appointments/:id/charge` e `/complete` | Cobrança explícita/conclusão local |
| `POST /agenda/appointments/:id/receipts` | Recebimento manual idempotente |
| `POST /reserva/bookings/:id/receipts` | Recebimento de sinal/saldo |
| `PATCH /entrega/deliveries/:id/commercial` | `version`, `price_cents`, `authorize` |
| `POST /entrega/deliveries/:id/receipts` | Recebimento da entrega avulsa |
| `POST /integrations/receipts/:id/reverse` | Referência ao recebimento original e motivo; anulação humana autorizada |

Na OS, a autorização de preço fixo usa `{version,authorize_fixed_price:true}`.
O vínculo de peça usa `kind=quote_item`, ID da OS e UUID estável da linha. Vínculo,
recibo, histórico, revisão e projeção comercial agora são gravados juntos,
protegidos pelo CAS da OS e da origem. Congelamento concorrente rejeita o lote.

As rotas revalidam área e proprietário. Erros públicos são sanitizados: 400
validação, 403 autorização, 404 registro/área inacessível, 409 conflito ou parte
desligada, 422 informação comercial obrigatória e 503 indisponibilidade.
O ERP humano legado conserva seus próprios códigos HTTP; não se alterou esse
contrato para adaptar testes F3.

## Operação e recuperação

O consumidor roda após a resposta via `waitUntil` e é retomado pela manutenção
dos módulos. A concessão dura 60 segundos; apenas seu token confirma ou renova.
Uma origem bloqueada não paralisa as demais. Timeout, 429 e 5xx têm atraso de
5 segundos até uma hora, limitado a 12 envios. Parte desligada e espera manual
não gastam tentativa de envio.

Para uma pendência, consultar código, origem, revisão e última confirmação.
`customer_required`, `category_required`, `warehouse_required` e
`settlement_account_required` pedem correção cadastral/configuração.
`stock_unavailable` identifica insuficiência de quantidade ou lote; a operação
local permanece válida. O texto bruto do provedor ou do SQL não deve ser exposto.

“Tentar novamente” reenvia o pedido já persistido. Se a correção mudar o corpo,
usar o fechamento e a nova projeção. Nunca editar SQL de eventos/pedidos,
apagar entrada ou mudar a versão esperada para resolver comando incerto. Se a
aplicação venceu a disputa, o fechamento devolve o recibo aplicado; ela não pode
ser tratada como ausência de efeito.

Cada fato conserva elegibilidade e época. Desligar e religar não torna fato
antigo elegível. Recuperar recibo remoto vem antes da decisão de corte.
Comando preparado ainda não aplicado de época encerrada é fechado. Base
desligada impede nova chamada ERP e conserva a pendência. Cancelamentos e
reversões de efeitos próprios seguem o acesso de manutenção e seus bloqueadores.
Obrigação antiga sem vínculo paga depois fica `historical_origin_unlinked`;
não se inventa dívida retroativa para baixá-la.

O resumo mostra pendência comercial mesmo quando a entrega automática terminou
e falta lançamento manual. Documentos vinculados continuam somente leitura,
inclusive quando a origem operacional não pode ser revelada. Esconder um botão
não substitui as proteções do servidor.

## Backup e restauração

Preservar todas as tabelas de integração D1, os registros operacionais e o
cadastro, além de `events` com `kind='payment.evidence'` e `receipts` de
escopo `f3-sale:*` (fotografias por componente). Não incluir essas evidências em
limpeza genérica. O dump ERP inclui `erp_documents__command`, inclusive âncoras,
âncoras reversas e recibos F3, e os comandos/lançamentos financeiros e de estoque.

Antes de restaurar, suspender escritas/consumo pelos mecanismos operacionais
existentes e guardar os dois retratos. Restaurar o par D1/ERP correspondente,
conferir manifestos, contagens e integridade, e testar recuperação de recibo
antes da retomada. Este procedimento é orientação de operação; o teste local
cobre dump/restauração SQL, não upload R2 nem recuperação real de desastre.

Restauração independente pode produzir D1 adiantado e ERP atrasado ou o inverso.
A prova Node recusa predecessor ausente (`module_sequence_conflict`) e também
recusa D1 que tenta esconder recibo remoto como salto local. Isso vira pendência;
não autoriza reconstituir âncora, adotar documento por texto ou lançar de novo.
Não existe nesta fase reconciliador automático geral de backups incompatíveis.

## Pedidos à base e aos donos

| Dono | Pendência e motivo | Tratamento atual |
|---|---|---|
| Pagamentos | `ProviderPayment`/Mercado Pago não devolvem `verified_method` nem `refunded_at`; esses arquivos não estão em B1–B9. O núcleo não recebe os campos brutos para apenas lê-los | Evidência usa `unknown` e instante observado quando faltam; não inferir meio da cobrança ou inventar instante do provedor. Preservar `payment.evidence` |
| Base/capacidade/trabalho | DTO A2 não transporta prazo, validade, metadados estruturados de tipo/etapa, ator/canal da aprovação, embora parte exista localmente | Sem extensão parcial do DTO/validação/recibo. Esses campos não estão comprovados no documento ERP; mantidos na operação quando existentes |
| Base/comércio | Fotografia por componente está em recibos `f3-sale:*`, fora da fotografia única de `module_erp_sources.state_json` | Preservar os recibos no backup; formalizar contrato de armazenamento/retenção antes de limpeza |
| Comércio/capacidade | Desempate de alocações em Mesas usa ID provisório quando o título ainda não existe; a consulta agora filtra o componente do vínculo | Não afirmar ordenação integral por ID ERP antes da resposta. Rever protocolo de alocação sem dependência síncrona do atendimento |
| Mensalidade | `createContract` cancela contrato anterior fora do lote de seu evento comercial; reconciliação posterior reduz, mas não elimina a janela | Não declarar atomicidade da substituição. Corrigir mutação, replay após queda e publicação juntos; não há conserto parcial nesta revisão |
| Mensalidade | Desconto posterior em `requests.ts` não integra o título já congelado; arquivo fora da matriz | Divergência bloqueia baixa; exige procedimento humano, sem reescrever obrigação histórica |
| Painel/produtores | Projeções dos cadastros ainda não oferecem `catalog_link` uniformemente | Conferir contrato de leitura por produtor e retorno de versão; não declarar todos os seletores de vínculo aceitos |
| Base/comércio | Lançamento manual da origem usa o último evento; a escolha de um componente anterior em Mesas precisa de protocolo explícito | Não declarar lançamento manual de qualquer pedido de conta composta aceito; revisão por componente antes da liberação desse fluxo |
| Operação | Sem reconciliador geral para restaurações D1/ERP incompatíveis | Interromper consumo e reconciliar com pessoa; não recriar efeitos automaticamente |
| Verificação | O resumo externo mais recente contém três casos Vitest e 218 provas de painel com falha; não contém `TUDO VERDE` | Revalidar o estado corrigido externamente; nenhum Vitest executado nesta sessão |
| Matriz/painel/OpenAPI | O harness Node, `web/erp/ORIGEM.json` e `src/modules/entrega/openapi.ts` não constam em B1–B10 | Duas propostas concretas verificadas em separado, aguardando autorização para aplicar os três arquivos; nenhuma asserção do painel foi alterada. Sem aplicação, essas falhas permanecem na árvore |
| Desempenho | Os tetos D1 falharam e precisam de nova medição Worker/Coordinator externa | Sondagem Node passou em todos os 12 fluxos medidos, incluindo os quatro excessos reproduzidos; nenhum teto foi aumentado. Falta confirmar no runtime Cloudflare externo |

Não há promessa nesta fase de contas a pagar, emissão fiscal, importação de
saldos, lançamentos retroativos, criação automática de produtos, suficiência
tributária ou transação distribuída. Catálogo não recalcula preço contratado;
preço e confirmação de pagamento nunca são escolhidos por IA.

## Arquivos de outros donos alterados nesta integração

| Arquivo(s) | Motivo |
|---|---|
| `src/erp/engine/parts-gate.ts` | Classificação explícita dos quatro RPCs F3 em Base |
| `src/erp/engine/module-origin.ts`; `src/erp/domains/documents/rpc/erp_module_apply.ts` | Predecessor remoto após eventos locais sem pedido/efeito; conferência de incompatibilidade; recebimento com destino desligado conserva `part_disabled` sem exigir título inexistente |
| `src/integrations/catalog.ts`; `src/modules/os/mutations.ts`; `src/modules/os/commercial/{mutations,projection,routes}.ts` | Vínculo de catálogo da OS no mesmo lote da revisão, histórico, recibo e saída; proteção contra congelamento concorrente |
| `src/integrations/erp-adapter.ts`; `src/integrations/privacy.ts` | Código sanitizado `stock_unavailable` para erros enumerados de estoque |
| `src/integrations/policy.ts`; `src/integrations/routes.ts` | Política por permissão; origem oculta com somente leitura; contagem de espera manual por origem |
| `src/index.ts` | Delega somente rotas F3 enumeradas aos autorizadores específicos, sem mexer em `src/access.ts`; captura somente comandos F3, preservando `integration.delete` do roteador |
| `web/modules/integrations/{api,contracts,visibility}.ts` | DTO comercial real, projeção da política e mensagem de estoque |
| `web/modules/integrations/LegacyServiceOrders.tsx`; `web/modules/os/work/WorkCommercialPanel.tsx` | Origem nullable protegida e versão pública na autorização de preço fixo |
| `tests/helpers/f3-fixtures.ts`; `tests/f3-base.test.ts` | Preparação compatível com produtores já registrados; ausência de produtor provada com registro isolado; casos novos de pendência por componente |
| `tests/f3-painel.test.ts` | Casos novos para DTO, origem oculta e política Estoque |

Nenhum teste foi removido, pulado ou desativado. As mudanças de preparação e
as expectativas ajustadas ao contrato estão discriminadas abaixo. Os arquivos da tarefa paralela `f2-aceite2` ficaram
intactos. Não foram criados esquema, migração, recurso Cloudflare ou classe de
Durable Object.

Verificações locais adicionais: `npx tsc --noEmit`, guarda de conflitos,
codificação e `erp-scope-css --check` passaram. A guarda de codificação examina
arquivos versionados; os novos arquivos foram escritos em UTF-8 sem BOM e LF.


## Diagnóstico acumulado dos logs e correções

O arquivo `.codex-verificacao.log` fornecido é um resumo, não o log completo.
O log atual registra painel Node com 2.018 aprovações e 218 falhas (2.236 provas)
e Vitest com **3.100 aprovações e três falhas em três arquivos**, de 289 arquivos
e 3.103 casos executados. As falhas são orçamento D1, rotas Entrega no OpenAPI
e visibilidade da nota legada em M6. A rodada anterior tinha 26 falhas Vitest;
as correções daquela rodada continuam descritas abaixo. Ausência de um caso no
resumo não é prova de aprovação isolada. Vitest não foi executado nesta sessão.

| Falha / causa | Correção e limite da evidência |
|---|---|
| Painel: compilação de centenas de casos falha porque o React simulado não exporta `forwardRef`/`createElement`, agora importados por `lucide-react` pela ponte F3 | Preparação proposta para o harness fornece essas duas primitivas; sem simular a autorização ou os componentes F3 |
| Painel: renderizadores rasos não atravessam os novos `DocumentEditorBody` e `DocumentListBody` | Preparação Vitest de `c-telas` atualizada; proposta Node renderiza esses corpos reais e preserva os testes/asserções existentes |
| Manifesto de origem: `DocumentSalesToService.tsx` já tinha mudança F3 sem registro | Proposta registra o motivo em `local`, junto do harness modificado; hashes de origem e teste de integridade preservados |
| OS: vincular a conversa incrementa `row_version`, deixando o aviso da versão anterior sem retomada | A mesma transação da vinculação move somente o aviso pendente da versão corrente, preservando sua chave e revalidando o destinatário |
| OS: recibo comercial retornava antes da publicação pendente | Replay chama a publicação do histórico persistido; não repete a mutação |
| OS: CAS comercial ocultava `os_conflict` da transição legada | Restaura o código público, mantendo rollback e ausência de intenção/notificação na alteração recusada |
| Mensalidade: cancelar uma cobrança entrega gancho e muda o contrato antes do CAS da próxima cobrança | Releitura após cancelar; pagamento confirmado ou troca concorrente impedem sobrescrita |
| Mensalidade: pagamento já estornado impedia entregar o gancho pago que estava pendente | Aceita essa progressão de estado somente com a evidência persistida do recebimento, preservando ordem e deduplicação |
| Suporte: cancelamento do provedor já alterava a compra, e o CAS ainda exigia `pending` | Releitura da compra, comparação de cobrança/sequência e CAS do estado efetivo antes do cancelamento comercial por substituição |
| Agenda/Reserva: a simulação de corrida interceptava `.run`, mas a mutação agora usa `.batch` | A fixture intercepta também o lote, injeta a disputa antes da transação e entrega os statements reais ao D1 |
| Agenda/Reserva: guardas transacionais passaram a ocultar erros operacionais | Mantém recusa atômica e códigos de horário ocupado, agendamento alterado/encerrado e unidade ocupada; cancelar Reserva com outro motivo mantém `booking_closed` |
| Identidade técnica: papel proibido em declaração de módulo era silenciosamente substituído | Valida o papel declarado antes de atribuir a identidade F3 `vendas`; `admin` e `financeiro` continuam recusados |
| Eventos de Reserva/M6: a projeção F3 corretamente não exporta notas; a fixture legada da primeira rodada omitia `conversation_id`, exigido pela autorização | Evento legado explícito com a conversa real. Mantidas as expectativas que negam a nota sem `notes:read` e a mostram com esse escopo; prova Node adicional executa `visibleEvent` real nos dois casos |
| Upload: o marcador privado `abc` podia aparecer por acaso em UUID hexadecimal | Fixture usa `X&Z`, com o mesmo tamanho e SHA-256 literal correspondente; ausência no comando, integridade, replay e download continuam verificados |
| Contratos aditivos: Entrega ganhou duas rotas e `moduleView` ganhou integração/exclusão do menu OS | Asserções novas validam os campos/rotas adicionais; campos anteriores continuam comparados exatamente |
| Pagamento de Pedido: F3 confirma entrada em `received` e saída comercial na mesma transação | Expectativa do estado intermediário atualizada; mantém falha de publicação, retomada e evento único, e acrescenta comparação da fotografia/saída antes e depois do replay |
| D1: inicialização repetida de cortes/política, guardas separadas e saída acordada em comandos alheios | Cortes e partes lidos numa fotografia SQL; inicialização em inserção única; política com `RETURNING`; fonte com UPSERT condicionado; alias com recusa atômica; estado/eventos da OS em uma leitura; guardas combinadas; agendador reutiliza ativação e comandos sem fato comercial não acordam a fila |
| OpenAPI de Entrega: duas rotas registradas não estavam no documento público | Proposta para `src/modules/entrega/openapi.ts` inclui operações, schemas de entrada/retorno, preço autorizado, delegação e recebimento idempotente. Validação local reproduz duas ausências e passa nas 18 rotas com a proposta; aplicação depende da matriz |
| D1: carrinho, pagamento, envio e fechamento de mesa repetiam leituras e guardas | Leituras conjuntas, reutilização limitada ao plano de uma mutação e escritas compactas, conservando CAS, evidência, recibos, históricos e rollback. Os quatro fluxos ficam nos tetos na sondagem Node |
| Cortes: a inicialização concorrente podia devolver somente as linhas inseridas pela própria chamada | UPSERT retorna também as linhas já inicializadas pela concorrente, sem mudar época/instantes; prova Node verifica igualdade integral do retorno |
| SQL imutável: UPSERT de replay não pode executar UPDATE, mesmo sem mudança de valor | Comparação fica no WHERE do conflito; replay exato não dispara o trigger e divergência rejeita o lote. Testes usam todas as migrações reais, sem remover triggers |
| Alarme legado: conciliação comercial da Mensalidade fazia uma leitura adicional mesmo com Base desligada | O gancho periódico aguarda a Base ligada; contratos cancelados continuam persistidos e são retomados no religamento. Prova Node confere ausência da consulta quando desligada e sua retomada quando ligada |

As otimizações conservam o cache de configuração por invocação já existente e
limitam as leituras comerciais reaproveitadas ao plano de uma mutação. Nenhuma
guarda foi removida: a comparação passa para a escrita que precisa dela.
Não houve alteração de migração, trigger ou teto. O lote continua recusando
revisão, predecessor, proprietário, corpo de recibo ou alocação incompatível.
A compactação de recibos usa JSON e respeita o limite de 100 parâmetros por
statement; a prova acrescentada inclui mais de 20 componentes.

### Medição local dos fluxos D1

As funções de produção do Worker/Coordinator foram empacotadas com esbuild e
executadas contra SQLite com todas as migrações. Apenas a base de DurableObject,
KV/alarmes e respostas do provedor são locais/sintéticas; nenhuma chamada de
rede é permitida. A sondagem não importa nem executa testes Vitest e não substitui
a medição externa no runtime Cloudflare. Os limites abaixo são os já existentes.

| Fluxo | Antes desta rodada | Agora | Teto existente |
|---|---:|---:|---:|
| Primeira mensagem — inbound | 20 | 20 | 20 |
| Primeira mensagem — motor | 28 | 28 | 30 |
| Cardápio — motor | 41 | 38 | 43 |
| Encaminhamento ao Suporte | 34 | 34 | 37 |
| Carrinho Pix | 64 | 57 | 59 |
| Pagamento — Coordinator | 64 | 30 | 30 |
| Rodada periódica | 23 | 23 | 24 |
| Fila — emitir | 17 | 14 | 17 |
| Fila — chamar | 18 | 15 | 18 |
| Mesa — enviar pedido | 51 | 26 | 27 |
| Mesa — fechar conta | 51 | 21 | 21 |
| Alarme completo | 71 | 71 | 71 |

A suíte Node também confirma que pagamento repetido não duplica recibo,
fechamento repetido devolve o mesmo resultado, Financeiro desligado não gera
lançamento, religamento não reconhece passado, falha antes do commit desfaz o
lote e perda da resposta depois do commit não duplica pedido/evento no replay.
O recebimento de mesa conserva o total e a alocação de 1.760 centavos.

## Arquivos adicionais alterados e responsabilidade

Esta tabela complementa a tabela anterior: juntas descrevem todas as alterações
de produção e testes acumuladas desde a largada, além dos três documentos de
referência e dos dois arquivos novos de aceitação.

| Arquivo | Responsabilidade / alteração |
|---|---|
| `src/coordinator.ts` | B1: reunir quatro leituras iniciais de configuração em uma, abastecendo as mesmas chaves do cache por invocação; despertar o consumidor somente após comandos capazes de produzir fatos comerciais ou alterar elegibilidade; estado já lido na abertura evita despertares com Base desligada, sem substituir a revalidação do consumidor |
| `src/modules/schedule.ts` | B1: reaproveitar leitura de módulos e evitar consultar o consumidor com Base desligada |
| `src/integrations/activation.ts` | B1: leitura consistente conjunta de cortes/partes; inicialização/retorno em um UPSERT sem alterar épocas existentes, inclusive diante de inicialização concorrente; escrita não invalida configuração apenas lida |
| `src/integrations/outbox.ts` | B1: CAS da fonte e validação do alias incorporados à escrita; compactação de recibos locais no mesmo lote, mantendo revisão/predecessor e rollback integral |
| `src/integrations/policy.ts` | B1: além da projeção por papel já descrita, inicialização/retorno em um statement; conserva a configuração existente e seu cache por invocação |
| `src/integrations/receipts.ts` | B1: validação e replay em uma escrita, conservando triggers imutáveis; estorno exige origem/valor originais; alocação não excede o recibo |
| `src/integrations/payment-evidence.ts` | B8: parser único para evidência lida junto do pagamento/gancho; guarda do CAS e comparação imutável incorporadas à inserção |
| `src/payments.ts` | B8: transição retorna linha persistida; leituras conjuntas de conta/evidência/configuração; reserva e remoção do gancho com RETURNING, preservando token, expiração, replay e ordem |
| `src/modules/pedido/menu.ts` | B4: fotografia conjunta do cardápio, conservando ordenação, DTOs e invalidação do cache |
| `src/modules/pedido/integration.ts` | B4: plano reutiliza cortes/política e leitura de fonte/fotografia/saldo/título por componente; consulta agrupada e recibos compactos; pagamento relido e validado contra origem persistida |
| `src/modules/pedido/orders.ts` | B4: INSERT/UPDATE e históricos com guarda integrada; aproveita retorno persistido e histórico já lido; mantém publicação/retomada e fotografia no mesmo lote |
| `src/modules/pedido/public.ts` | B4: porta de leitura conjunta dos pedidos de uma conta; quitação preserva a distinção entre pedidos cancelados e pagos |
| `src/modules/mesas/integration.ts` | B4: aliases e componentes agrupados, planos com leituras compartilhadas; consulta de título filtra componente; recibo de fechamento construído para confirmação no lote |
| `src/modules/mesas/tabs.ts` | B4: estado de conta/pedidos/pagamentos/recibo em leitura conjunta; CAS, históricos individuais, recebimentos e saída comercial no mesmo lote compacto; replay do fechamento preservado |
| `src/modules/os/commercial/projection.ts` | B3: além do catálogo, leitura conjunta de fonte/eventos e ausência de consulta de vínculos quando não há itens |
| `src/modules/os/commercial/mutations.ts` | B3: além do lote de catálogo, recuperação da publicação e combinação das guardas equivalentes |
| `src/modules/os/store.ts` | B3: retomada do aviso após vincular cliente e preservação do erro público da OS legada |
| `src/modules/erp/identity.ts` | B2: recusa de papel técnico proibido antes da atribuição F3 |
| `src/modules/mensalidade/contracts.ts` | B5: releitura após o gancho de cancelamento da cobrança, antes de substituí-la |
| `src/modules/mensalidade/integration.ts` | B5: evidência de recebimento em gancho pago pendente após estorno |
| `src/modules/mensalidade/mensalidade.ts` | B5: conciliação periódica comercial somente com Base ligada; recuperação dos contratos persistidos no religamento |
| `src/modules/suporte/store.ts` | B7: substituição conserva CAS após o cancelamento do provedor |
| `src/modules/agenda/integration.ts` | B6: tradução de conflitos atômicos para os erros públicos da operação |
| `src/modules/reserva/integration.ts` | B6: dupla reserva concorrente retorna `unit_unavailable` |
| `src/modules/reserva/bookings.ts` | B6: cancelamento já encerrado com outro motivo retorna `booking_closed` |
| `tests/c-telas.test.ts` | Preparação: atravessar `DocumentListBody` real |
| `tests/module-races.test.ts` | Preparação: injetar corrida também antes de batches reais |
| `tests/m6-conferencia.test.ts` | Preparação: evento legado explícito, com `conversation_id` real, para provar notas privadas sem mudar expectativas |
| `tests/os-documents.test.ts` | Preparação: marcador binário não hexadecimal, com hash/download correspondentes |
| `tests/entrega.test.ts` | Contrato A9: contar e verificar as 18 rotas atuais |
| `tests/f1-base.test.ts` | Contrato A2/A9: verificar metadados novos e manter comparação exata dos campos antigos |
| `tests/payment-hook-module-retry.test.ts` | Contrato A7: estado operacional e fotografia comercial confirmados juntos; replay conserva ambos |
| `tests/erp/unico/f3-aceitacao.test.mjs` | B10: 19 provas, incluindo SQL compacto com CAS, sequência, recibos/alocações imutáveis, rollback, épocas, inicialização concorrente, política explícita e custos dos fluxos operacionais |
| `tests/f3-aceitacao.test.ts` | B10: conjunto integrado Worker/D1/ERP descrito acima; não executado localmente |
| `docs/API.md`, `docs/ORDEM-DE-SERVICO.md`, `docs/MODULOS.md` | Rotas e DTO comercial, propriedade e integração dos módulos |
| `docs/FASE-3-INTEGRACOES.md` | Este relato integral: evidências, operação, permissões, recuperação, limites e pendências |

## Asserções ajustadas ao contrato

| Arquivo / caso | Antes | Agora | Fundamento |
|---|---|---|---|
| `tests/entrega.test.ts` / todas as rotas no OpenAPI | Exatamente 16 rotas | Exatamente 18, verificando cada uma no OpenAPI e preservando a exceção de Idempotency-Key de posições | A9 acrescenta comercial e recebimentos de Entrega |
| `tests/f1-base.test.ts` / campos anteriores de `moduleView` | Igualdade sem campo `integration` e sem exclusão de menu | Igualdade dos campos anteriores mais verificação explícita da declaração e `hidden_when_modules_enabled` | A2 adiciona declaração; A9 esconde OS avulsa com Trabalho ligado |
| `tests/payment-hook-module-retry.test.ts` / Pedido após falha de publicação | Pago, ainda em `awaiting_payment` | Pago e em `received`, com fotografia comercial persistida; repetição não duplica saída nem evento | A7 exige mutação operacional e saída comercial no mesmo lote |

No teste de upload, hash e corpo esperado mudaram junto da fixture, sem mudar
nenhuma regra do produto: continuam conferidos exatamente três bytes, o hash
calculado no servidor e o conteúdo integral do download. Os demais ajustes
citados são de preparação; suas expectativas originais foram preservadas.

## Verificações consolidadas

- Sem commit, sem rede e sem execução de Vitest. `.codex-verificacao.log` foi preservado.
- `npm run check`: aprovado nesta rodada, incluindo TypeScript, conflitos, codificação e CSS.
- `npm run build`: aprovado nesta rodada; avisos sobre tamanho de chunks, nome de grupo e diretivas `use client` não impediram o build.
- `node --no-warnings --test tests/erp/unico/f3-aceitacao.test.mjs`: **19/19 aprovados**, nenhum caso pulado; inclui a última correção de corrida dos cortes.
- `npm run test:erp`: 1.082 aprovações, zero falhas, zero pulados e um TODO preexistente (1.083 casos, saída 0). Inclui subida do esquema com dados e rollback após interrupção, aprovados sem o `spawnSync git EPERM` relatado por Suporte. O diferencial não foi alterado. A rodada anterior tinha 1.080 aprovações, zero falhas e um TODO; as duas provas novas explicam a diferença de contagem.
- `npm run test:erp:painel`: a rodada anterior reproduziu **218 falhas** na árvore original. A proposta de dois arquivos em cópia temporária passou em **2.236/2.236**, sem casos pulados ou mudanças de asserção. Essa correção ainda não está aplicada na árvore; não se declara o painel corrigido aqui.
- OpenAPI em bundle local: a árvore atual reproduz as duas operações ausentes; com a proposta temporária, **18/18 rotas** passam, incluindo tags, schemas e idempotência. Não executou Vitest nem modificou o OpenAPI da árvore.
- Sondagem D1 incorporada à aceitação Node: **12/12 fluxos nos tetos existentes**, conforme tabela acima. Verifica também visibilidade legada com/sem escopo, replay, cortes e rollback.
- `git diff --check`: aprovado.
- Inspeção dos casos Vitest afetados: revisados os contratos de Entrega, M6, custos D1, pagamentos/estorno, concessão dos ganchos, replay e concorrência. Aprovação de execução continua exclusiva do verificador externo.

Na preparação desta rodada, as novas provas detectaram o UPDATE indevido no
replay contra triggers imutáveis e uma fixture de alocação sem fonte persistida.
Ambos foram corrigidos antes do resultado final de 19/19. A revisão acrescentou
uma corrida de inicialização dos cortes, também aprovada. Nenhuma expectativa
existente foi relaxada para obter esses resultados.

O TODO já existente é `248 pedido de compra Em aberto lança contas and still
moves on to Em andamento`, em `tests/erp/fagoo/finance-invoice-postings-sql.test.mjs`:
“pendente da ponte com o Documentos (erp_document_finance_*)”. Não foi criado,
modificado ou usado para desativar uma prova nesta entrega.

Logs desta confirmação: `/private/tmp/f3-r2-check-final.log`,
`/private/tmp/f3-r2-build.log`, `/private/tmp/f3-r2-aceitacao-final.log`,
`/private/tmp/f3-r2-erp-final.log` e `/private/tmp/f3-r2-openapi.log`.
A evidência anterior da proposta do painel está em
`/private/tmp/f3-painel-review-final.log`; a medição anterior às otimizações,
em `/private/tmp/f3-d1-before.log`.

### Propostas fora da matriz, aguardando autorização

| Arquivo | Proposta concreta | Evidência |
|---|---|---|
| `web/erp/test/helpers/component-recovery-harness.mjs` | Primitivas React necessárias e travessia dos corpos reais de Editor/DocumentList | Suíte completa de painel 2.236/2.236 em cópia temporária |
| `web/erp/ORIGEM.json` | Registra a alteração F3 preexistente em DocumentSalesToService e a preparação do harness | Mesmo teste de integridade, hashes preservados |
| `src/modules/entrega/openapi.ts` | Operações e schemas das duas rotas A9, com autorização e idempotência | Bundle local cobre 18/18 rotas; a árvore atual reproduz as duas ausências |

Patches revisáveis: `/private/tmp/f3-painel-preparacao.patch` e
`/private/tmp/f3-entrega-openapi.patch`. Não foram aplicados enquanto a resposta
à autorização solicitada estiver pendente. A [Parte B da tarefa](../../../tarefas/f3-aceitacao.md)
diz: “Arquivos não enumerados não podem ser editados. Necessidade adicional
retorna ao dono da matriz antes da escrita”. O acréscimo do orquestrador amplia
a produção para B1–B9 e parts-gate, mas não enumera esses três arquivos.

## Fora da entrega e dúvidas de liberação

Permanecem as pendências de desenho e operação da seção “Pedidos à base e aos
donos”, os arquivos da tarefa paralela F2 e a liberação real dos módulos. Não
houve migração, alteração de esquema, mudança no oráculo ou relaxamento de
limites/testes. A próxima verificação deve usar a árvore corrigida e informar os
valores por fluxo quando algum teto D1 falhar; o log atual só informa que quatro
fluxos excederam o teto, e a sondagem local reproduziu e corrigiu esses quatro.

A fase continua sem aceite final até a autorização/aplicação das propostas de
painel e OpenAPI e um novo resumo externo `TUDO VERDE`. Não foi usado sucesso em cópia
temporária para declarar que arquivos ainda não aplicados estão corrigidos.

## Correções das revisões

O fechamento da F3 integra as três correções (`f3-corr-fila`,
`f3-corr-motor` e `f3-corr-produtores`) sobre o fechamento da F2. Esta seção
substitui as decisões incompatíveis dos relatos anteriores, especialmente a
recusa do efeito local de pagamentos antigos e a não liberação de pagamentos
tardios. O aceite final depende da verificação externa completa.

- **Fila e Trabalhos:** fatos sem destino elegível usam `seq=null` e não
  incrementam `enqueued_seq`; a leitura cronológica usa `source_revision,seq`.
  Preparação, consulta e envio têm contadores e recuo. Depois de envio sem
  resposta, conserva-se `uncertain` e consulta-se o mesmo comando, sem um 13º
  envio. A substituição valida a projeção e reserva a solicitação antes de
  fechar o original. A drenagem do agendador usa `waitUntil`.
- **Motor:** manutenção resolve o contato pelo vínculo, recusa contato diferente
  e segue títulos, baixas e estoque históricos. Operações genéricas não podem
  alterar esses efeitos por fora da origem. Estorno parcial mantém o cancelamento
  bloqueado. A busca de origem usa a âncora indexada quando há área confiável.
- **Produtores, núcleo e telas:** pagamentos usam a evidência persistida do
  núcleo para recibo comercial e baixa ERP. Pagamento legado sem essa evidência
  conclui a operação local e registra `blocked/payment_evidence_required`;
  consultar novamente o provedor recupera o gancho e a integração, sem segunda
  baixa. Divergência de identidade/valor continua recusada. Uma contratação nova
  de Mensalidade exige evidência antes de criar pagador ou assinatura. Os formulários
  de Trabalho/Entrega usam os contratos do servidor e a Cobrança mostra a
  conferência de reembolso parcial (`review_required`/`review_reason`).

### Quatro interfaces consolidadas

1. Cancelamento, reversão e mudança de etapa vinculada levam `contact_id:null`;
   o motor usa o contato histórico. Recebimento de título vinculado também usa
   esse contato, sem promover novamente a pessoa.
2. Manutenção não leva `auto_post` nem exige categoria, conta ou depósito atuais
   para efeitos existentes. Estornos seguem os efeitos reais. Abrir sem orçamento,
   orçar, aprovar, executar e cancelar funciona com motor real, inclusive depois
   de desligar automação e remover padrões atuais.
3. Só destinos elegíveis consomem sequência ERP. Fatos locais e pendências sem
   obrigação vinculada permanecem auditáveis com `seq:null`. Em Agenda/Reserva,
   cancelamento com dinheiro ainda alocado registra pendência local; estornos
   ocupam a sequência remota antes do cancelamento final. Resolver a última
   devolução encerra aquela pendência no mesmo lote.
4. Estado público é `none | skipped | pending | blocked | failed | uncertain |
   done`, com motivo, destinos aplicados e pendência manual por destino.
   `waiting_manual` permanece um estado interno de entrega; publicamente vira
   `skipped/automation_off`, com `pending:true` e `manual_destinations`.
   “Confirmado no ERP” aparece somente para `done`. Confirmação de Estoque não
   esconde Financeiro manual; `module_cancellation_pending` permanece bloqueado.

Um recebimento de obrigação já vinculada aguarda enquanto Financeiro está
suspenso e sobrevive à mudança de época ao religá-lo. Isso não permite reconhecer
outra vez obrigações antigas sem vínculo: elas ficam
`blocked/historical_origin_unlinked`. O evento local agora existe explicitamente,
para que a preparação devolva esse código em vez de acessar um evento ausente.

### Compatibilidade publicada e preparação dos testes

Receber, estornar, liberar atendimento, reativar reserva e avisar a equipe
continuam independentes de ERP. Os testes publicados de pagamentos, Pedido,
Reserva, Mensalidade e Suporte não foram editados. O sinal tardio reativa Reserva
se a unidade ainda estiver livre (a escrita repete a guarda de disponibilidade);
se estiver ocupada, mantém o aviso à equipe. Suporte pago após expirar/cancelar
volta a liberar atendimento.

**Caminho adotado para recebimento depois de cancelamento:** bloqueio explícito
`obligation_reactivation_required`, com orientação “Recebimento depois do
cancelamento: recompor a obrigação”. Conserva-se o recibo comprovado, sem alocação
nem baixa automática sobre título cancelado. A equipe deve conferir a obrigação
original, decidir recomposição ou devolução e conciliar o dinheiro. Repetir o
pagamento não cria novo título nem remove esse bloqueio. A reativação comercial
idempotente no motor fica adiada; não se declara conciliação concluída.

Reembolso integral publicado (`refunded`/`charged_back`) continua entregando o
estorno. Indícios explícitos de devolução parcial sem total comprovado exigem
conferência, sem fabricar estorno integral. Ganchos pago/estornado conservam sua
ordem; duplicado estornado não cancela a cobrança original nem seu pedido.

Nos testes F3, a preparação de recibos usa `payment.evidence` real persistida;
clientes, categorias e depósitos são registros reais quando o motor é real.
O agendador tem coletor de `waitUntil`, com resposta ERP retida até a rodada
retornar. As expectativas alteradas seguem os contratos acima, mantendo casos
de rollback, CAS, lacunas, propriedade de alias, privacidade, perda de resposta,
recusa e replay. Nenhum teste foi eliminado, pulado ou teve teto aumentado.

A prévia de cópia mantém o contrato já fechado na F2: referências suspensas são
`null` no formulário novo, e omitidas no DTO do documento salvo. A normalização
HTTP respeita os metadados de partes do documento; não restaura referências da
origem. Os testes protegidos de catálogo/documentos e o diferencial não mudaram.

A tela de conferência de Cobrança alterada é
`web/conversations/Payments.tsx`. Não houve edição em `web/erp/app/**`, portanto
não se acrescentou entrada de adaptação local em `web/erp/ORIGEM.json`.

### Retomada após as 15 falhas externas

- **Lote vazio no D1:** repetição de Pedido e Suporte podia produzir um plano
  sem instruções. `DB.batch([])` falha no Cloudflare antes de republicar os
  eventos do módulo. `src/db.ts` encerra esse plano sem chamar D1. O harness
  SQLite agora recusa lotes vazios como D1, em vez de ocultar o defeito.
  Regressões Node interrompem `pedido.paid` e `pedido.status_changed`, repetem
  o gancho e comparam integralmente os eventos e a origem comercial.
- **Destino manual inexistente:** execução de Trabalho sem material marcava
  Estoque elegível e a tela cobrava lançamento manual indevido. O produtor
  exige material para esse destino, preservando a manutenção de efeitos
  históricos. O caso com material conserva sua expectativa original; uma
  prova com motor real exige somente Financeiro manual no serviço sem material.
- **Reserva ocupada:** preservada a recusa de reativação, mas o aviso volta ao
  motivo publicado `unit_taken` (ou `cancelled` para cancelamento explícito),
  com `needs_refund`. A pendência financeira de recomposição continua separada.
- **Expectativas antigas:** fato inelegível tem `seq:null`, motivo local e
  nenhum recibo remoto; salto por parte desligada é `skipped`, sem destino
  aplicado nem ação manual. Agenda/Reserva sem obrigação vinculada conservam
  `blocked/historical_origin_unlinked` inclusive após religamento, sem pedido
  remoto nem dívida retroativa. Os testes verificam esses campos exatos.
- **Gancho legado e tela:** o teste do núcleo agora prova a entrega local sem
  evidência, a pendência sem recibo, a consulta posterior e uma única retomada
  comprovada. A confirmação visual da correção verifica a ordem de validar,
  reservar e consultar antes de fechar. Não se alteraram os testes publicados
  de pagamentos, retomada dos ganchos ou Reserva para acomodar regressões.

### Adiamentos e operação

- **Substituição com sucessores:** continua recusada por
  `replacement_successors`. Falta um protocolo que reserve toda a cadeia,
  reconcilie cada comando incerto pela identidade original, valide todas as
  projeções e instale a cadeia substituta atomicamente, preservando fatos,
  aliases e efeitos confirmados. Não renumerar nem fechar parcialmente a cadeia.
- **Restauração unilateral:** divergência detectada permanece
  `blocked/integration_divergent` (“ERP e fila divergentes”). Suspender as
  entregas da origem, preservar os dois conjuntos de evidências e comparar
  sequência, chave, recibo e efeitos do ERP com o D1. Preferir restaurar um par
  compatível de backups; quando isso não for possível, a equipe técnica e
  financeira precisa reconciliar a origem antes de liberar a operação. Não
  apagar recibos, forçar retry nem gerar uma nova chave para esconder a
  divergência. Efeito órfão sem próximo comando não é detectado por este
  mecanismo; não há reconciliador geral automático.
- **Migração:** `0135` continua inédita; este fechamento não cria migração,
  recurso Cloudflare, classe Durable Object ou mudança de esquema ERP.
- **Validação:** provas Node locais cobrem D1/SQLite, produtores, consumidor,
  adaptador e motor; os comandos `check`, `build`, `test:erp` e
  `test:erp:painel` podem ser executados sem rede. O Vitest completo continua
  exclusivo do verificador externo. Resultados e limites desta sessão são
  entregues no relato final, fora do repositório. Nenhum teto, tempo-limite ou
  teste diferencial foi alterado; não houve execução de Vitest/Wrangler.

## Segunda revisão

Esta seção aplica as decisões do orquestrador aos três anexos da segunda
revisão. **C** identifica Capacidade (Anexo 1), **F** identifica Fila (Anexo 2)
e **P** identifica Produtores (Anexo 3). Os achados fechados da primeira revisão
continuam cobertos; nenhum teste foi removido ou dispensado.

| Achado / decisão | Correção e evidência de regressão |
|---|---|
| Decisão 1 — automação optativa | `policy.ts` nasce com ambos os destinos desligados. Fixtures de automação autorizam ambos explicitamente. `f3-segunda-revisao.test.mjs` e `f3-aceitacao.test.ts` verificam área nova, destino independente e ausência de retroatividade. A tela explica autoria e alcance temporal. |
| C1 / P2 — estoque consumido | O comando distingue `stock_reversal` de automação desligada, validado contra o fato imutável. `consumption_requires_classification` e `refund_confirmed_review_stock` impedem reposição e conservam o cancelamento bloqueado, inclusive em repetição. A substituição genérica não remove a restrição. Os dois motivos têm provas no motor real em `f3-corr-motor.test.mjs`; a reversão histórica por simples automação desligada continua coberta. |
| C2 — parte desligada durante a prova | O endpoint revalida revisão/validade depois da última consulta assíncrona, imediatamente antes da chamada síncrona ao motor. `f3-corr-motor.test.mjs` desliga Financeiro na segunda prova D1 e exige nenhuma baixa. |
| C3 — CNAB incompatível com origem | Reserva/prévia e emissão recusam títulos ancorados em módulo (`module_bank_collection_unavailable`); a guarda genérica financeira permanece fechada. Teste de reserva/prévia e emissão de reserva legada no motor real; os três formulários CNAB explicam o motivo e constam em `web/erp/ORIGEM.json`. |
| C4 / F2 — lifecycle apaga bloqueio | Projeção conserva pendências por operação e destino. Vínculo de documento não resolve `execute/epoch_closed` sem título. Um efeito correspondente ou resolução explícita é necessário. Provas Node e Coordinator em `f3-segunda-revisao.test.mjs` e `f3-aceitacao.test.ts`. |
| C5 — depósito antes do primeiro efeito | Preparação sem efeitos pode adotar o depósito atual; documento é salvo/validado antes da postagem mesmo sem mudança do hash comercial. Parâmetros de efeitos existentes permanecem históricos. `f3-corr-motor.test.mjs` cobre depósito igual e alterado após habilitar Estoque. |
| C6 / F4 / P8 — suspensão consome tentativas | `part_disabled` devolve apenas créditos desta passagem; conserva identidade, incerteza e limites de falhas reais. Testes Node/Coordinator drenam 15 vezes com e sem pedido persistido e exigem retomada única. |
| F1 / P3 — retry destrói fato local | `seq:null` é recusado antes da reserva, com motivo e estado intactos. Interface orienta consultar provedor, recompor obrigação, classificar estoque ou devolver valor; não oferece retry/correção genérica para fatos locais. Testes Node, Worker/Coordinator e `f3-painel.test.ts`. |
| F5 — reserva sem papel ERP | Identidade ERP é conferida antes de reservar; recusa definitiva local anterior a chamada remota libera a reserva por CAS. Reservas com resultado remoto incerto continuam preservadas. Provas Node/Coordinator verificam pessoa sem papel, recusa entre reserva e transporte e retomada autorizada após liberar a origem. |
| P1 — decisão financeira sem MFA | Pedido, Entrega e Mesas (receber, anular e pagamentos no fechamento) chamam `requireFinancialAal` antes de gravar. Aprovação financeira de Mensalidade também verifica o fator. Agenda/Reserva, anulação compartilhada, gestão financeira de Mensalidade e compra de Suporte já tinham a guarda; Trabalho usa a postagem humana compartilhada. Política `off` continua permitindo a operação. Provas em `f3-segunda-revisao.test.mjs`, `f3-corr-produtores.test.ts` e HTTP real em `f3-aceitacao.test.ts`. |
| P4 — paid histórico depois de refunded | Mensalidade reconcilia o fato histórico, mas consulta o estado corrente antes de anunciar, liberar Suporte ou enviar comprovante (inclusive contrato). No reembolso a revogação precede notificações posteriores. `f3-fechamento.test.mjs`, `f3-corr-produtores.test.ts` e `f3-aceitacao.test.ts` cobrem reembolso já conhecido e falha de publicação posterior, inclusive revogação real de Suporte e reversão no Coordinator. |
| P5 — desconto deixa título antigo | Escolhida a alternativa de bloqueio explícito: desconto local e `commercial_correction_required` são atômicos; cobrança reduzida é recusada antes de emissão/reenvio até conciliação. Não se reescreve silenciosamente o título nem se impede a concessão local. Provas Node, produtor e Coordinator (`f3-fechamento`, `f3-corr-produtores`, `f3-aceitacao`). Não foi implementada correção automática da obrigação. |
| P6 — comercial da OS expõe finanças | Servidor remove parcelas, preços, total e destinos/detalhes financeiros para papel Estoque. Provas Node e Coordinator consultam a projeção real e verificam ausência dos campos. |
| P7 — cancelamento parcial de Entrega | Cancelamento local produz `blocked/refund_required`, sem sequência remota. A última devolução enfileira reversão antes do cancelamento e resolve a pendência local. `f3-segunda-revisao.test.mjs` e `f3-aceitacao.test.ts` acompanham título, documento e sequência no motor real/Coordinator. |
| Suporte avulso — decisão 8 | Reembolso confirmado com liberação revogada enfileira cancelamento da obrigação depois das reversões, sem nova liberação ou dívida aberta. Cobertura Node em `f3-fechamento`, Coordinator em `f3-aceitacao` e produtor em `f3-suporte`. |
| Histórico acumulado — três “a conferir” | Prova lê somente o predecessor necessário por consulta indexada; status pagina origens. Testes com mil predecessores e paginação real em `f3-corr-motor` e `f3-segunda-revisao`. Detalhes abaixo. |
| F3 — restauração unilateral | **Adiado por decisão 9.** Não há geração de restauração nem varredura automática de origens concluídas/efeitos órfãos. Procedimento obrigatório de conferência manual abaixo e no guia de operação. |

### Consulta e paginação

A prova busca `seq = sequência_anterior LIMIT 1`, junta entrega e pedido e para
no primeiro predecessor preparado. Só fatos locais legados com salto validado
exigem recuar outra sequência; não carrega de antemão o histórico da origem.
As duas verificações de transporte continuam necessárias. Em SQLite com mil
eventos, `EXPLAIN QUERY PLAN` usa
`sqlite_autoindex_module_erp_events_3 (profile_id, module_id, source_id, seq)`,
`sqlite_autoindex_module_erp_delivery_1 (event_id)` e o índice de cobertura
`sqlite_autoindex_module_erp_requests_1 (event_id)`, sem varredura de eventos.
Não há índice ou esquema novo. Isso comprova o plano local, não mede orçamento
nem latência do D1 de produção.

O status usa cursor por `source_id`, padrão de 50 origens e máximo de 100.
Carrega o histórico completo somente das origens da página para não produzir
confirmação falsa por truncamento. Os contadores são da página (`scope:page`),
e `next_cursor` permite avançar; o painel informa esse alcance. Uma origem
individual muito longa ainda exige sua projeção completa.

### Recuperação e limites assumidos

Depois de restaurar **só D1 ou só ERP**, não confiar em “Confirmado no ERP” sem
conferir as origens do período entre os backups e a interrupção. Sem comando
novo, recibo `done` no D1 não detecta efeito perdido no ERP; no sentido inverso,
efeito órfão do ERP não possui evento que provoque a conferência. Suspender a
retomada da integração/atendimento e preservar ambas as cópias; comparar
sequências, chaves, recibos, documentos, títulos, baixas e estoque, incluindo
origens presentes só em um lado. Preferir um par compatível de backups; a
equipe técnica e financeira reconcilia diferenças antes de retomar. Não apagar
recibos, forçar retry ou trocar chaves para ocultar a divergência. Ver
[Operação e recuperação](OPERACAO.md#restauração-de-apenas-um-banco-com-fase-3).

Continuam adiadas a substituição automática com sucessores e a recomposição
automática da obrigação após pagamento tardio. Classificação de material e
conciliação de desconto exigem tratamento humano; repetição genérica não é
classificação nem correção financeira. Não houve medição de vazão, custo de
alarmes/filas vazias, migração em D1 grande ou comparação com respostas reais
do provedor para reembolso parcial. Esses pontos “a conferir” permanecem
limitações de validação, sem mudança de contrato.

Nesta rodada não se alteram migrações, esquema ERP, classes de Durable Object,
recursos Cloudflare, dependências ou testes protegidos das fases anteriores.
Os testes F3 preservam as asserções existentes, exceto o novo padrão desligado
e as duas sequências de reembolso de Suporte, que agora incluem `cancel`.
A primeira verificação externa desta revisão aprovou `check`, `build`, motor
e painel, mas terminou com quatro falhas no Vitest. A retomada abaixo registra
o tratamento. A execução externa seguinte aprovou todos os 3.390 casos Vitest;
o impedimento atual é o falso positivo do teste de contatos descrito na última
retomada, e não os quatro casos anteriores.

### Retomada após as quatro falhas externas

O resumo em `.codex-verificacao.log` foi confrontado com o log completo externo.
Os quatro casos continuam presentes, com todas as expectativas anteriores.
Não se aumentou o timeout de 5 segundos, o limite de 30 sequências, os tetos D1
ou qualquer limite de tentativas de produção.

| Caso | Causa e tratamento na preparação/sincronização |
|---|---|
| Produtores: Pedido, Mesas, anulação e fechamento exigem MFA | O ator `aal1` tinha política `financial`, mas faltava `sessionId`. `requireFinancialAal` distingue uma pessoa com sessão de atores internos. O caso agora informa a sessão, como a autenticação real; as quatro recusas e as tabelas financeiras vazias continuam exigidas. Não se mudou a guarda central. |
| Produtores: Mensalidade histórica não anuncia liberação | O espião acumulava três publicações da preparação: pagador, assinatura e parcela criados. Seu histórico é limpo imediatamente antes do gancho sob teste. A ausência de publicação/liberação no `paid` histórico e a revogação antes da falha de aviso continuam obrigatórias. |
| Aceitação: recebimento HTTP fica na fila | A resposta HTTP chega antes da drenagem real iniciada pelo Coordinator em `waitUntil`. O bombeamento do teste podia gastar suas 30 rodadas enquanto a outra execução detinha a concessão. O teste observa e aguarda as promessas reais de `waitUntil`, preservando a chamada original, antes de bombear. Também exige que esse trabalho tenha sido iniciado, uma única baixa e saldo recebido de 400 centavos. |
| Aceitação: primeiro caso de Mensalidade excede 5 segundos | O primeiro cenário incluía a carga/transformação inicial do grafo pesado do motor via import dinâmico. O arquivo passa a carregar esse mesmo motor durante a coleta; cada área continua migrando seu SQLite e todos os produtores, transportes e efeitos continuam reais. O cenário completo também passou em Node com revogação real de Suporte, nenhuma nova liberação, falha de aviso e duas movimentações financeiras. A confirmação do timeout no runtime Cloudflare ainda depende da reexecução externa. |

### Arquivos da segunda revisão (consolidado)

As referências abaixo são relativas à raiz do repositório e incluem a rodada
anterior e esta retomada.

| Arquivo(s) | Alteração |
|---|---|
| `src/erp/domains/cnab/reserve.ts`, `src/erp/domains/cnab/finalize.ts` | Recusa de reserva/prévia e emissão bancária de título de módulo. |
| `src/erp/domains/documents/module-policy.ts` | Restrição de reposição validada contra o fato; padrões de preparação podem mudar antes de haver efeito. |
| `src/erp/domains/documents/rpc/erp_module_apply.ts` | Conserva estoque consumido e pendência; preenche depósito antes da primeira postagem. |
| `src/erp/engine/module-origin.ts` | Busca indexada do predecessor necessário, com validação dos saltos legados. |
| `src/erp/engine/rpc-endpoint.ts` | Revalidação de partes após a última espera e antes da transação. |
| `src/integrations/consumer.ts` | Suspensão confirmada devolve apenas os créditos desta tentativa, preservando incerteza. |
| `src/integrations/erp-adapter.ts` | Transporta restrição de estoque, informa início da chamada remota e documenta limite de restauração. |
| `src/integrations/outbox.ts` | Contrato persistido admite a restrição explícita de reposição. |
| `src/integrations/policy.ts` | Automação desligada por padrão nos dois destinos. |
| `src/integrations/privacy.ts` | Mensagens públicas enumeradas para classificação, devolução e correção comercial. |
| `src/integrations/routes.ts` | Recusa retry local, protege reservas, conserva restrição de estoque e pagina status. |
| `src/integrations/state.ts` | Pendências por operação/destino; lifecycle não oculta efeito ausente. |
| `src/modules/entrega/integration.ts` | MFA no recebimento e cancelamento parcial local pendente. |
| `src/modules/pedido/manage.ts`, `src/modules/mesas/integration.ts`, `src/modules/mesas/tabs.ts` | MFA antes de recebimento/anulação e recebimentos no fechamento. |
| `src/modules/pedido/integration.ts` | Plano admite pendência local; última devolução resolve o cancelamento de Entrega em ordem. |
| `src/modules/mensalidade/billing.ts`, `src/modules/mensalidade/contracts.ts` | Não anuncia/libera pagamento já reembolsado; revogação antecede aviso; cobrança respeita bloqueio comercial. |
| `src/modules/mensalidade/integration.ts`, `src/modules/mensalidade/requests.ts` | Desconto e bloqueio atômicos, recusa de cobrança divergente, consulta do reembolso corrente e MFA na decisão humana. |
| `src/modules/os/commercial/routes.ts` | Projeção no servidor retira finanças do papel Estoque. |
| `src/modules/suporte/integration.ts`, `src/modules/suporte/store.ts` | Revoga liberação e enfileira reversão/cancelamento da obrigação avulsa. |
| `web/modules/integrations/CommercialPolicyPanel.tsx` | Explica padrão desligado, autoria e alcance somente para fatos novos. |
| `web/modules/integrations/IntegrationStatus.tsx`, `web/modules/integrations/api.ts`, `web/modules/integrations/contracts.ts` | Ações específicas para fatos locais, cursor de status e alcance dos contadores. |
| `web/erp/app/components/CnabOperationalV2.tsx`, `web/erp/app/components/RealCnab.tsx`, `web/erp/app/components/RealCnabOperational.tsx`, `web/erp/ORIGEM.json` | Motivo explícito da recusa CNAB e registro de cada adaptação em `local`. |
| `tests/helpers/f3-fixtures.ts`, `tests/erp/harness/f3-local.mjs` | Automação explicitamente autorizada na preparação; acesso aos caminhos reais novos. |
| `tests/erp/unico/f3-aceitacao.test.mjs` | Expectativa do novo padrão desligado; demais provas mantidas. |
| `tests/erp/unico/f3-corr-motor.test.mjs` | Regressões de estoque, partes, CNAB e plano de consulta. |
| `tests/erp/unico/f3-fechamento.test.mjs` | Mensalidade/reembolso, desconto e cancelamento avulso; nova prova da revogação real do Suporte e conciliação no motor. |
| `tests/erp/unico/f3-segunda-revisao.test.mjs` | Novo arquivo: automação, MFA, suspensão, estado, retry, reserva, projeção, cancelamento e paginação. |
| `tests/f3-aceitacao.test.ts` | Regressões com Worker/Coordinator reais; carga do motor e espera observável do trabalho assíncrono na retomada. |
| `tests/f3-corr-produtores.test.ts` | Regressões de MFA, reembolso histórico e desconto; sessão e espião preparados corretamente. |
| `tests/f3-painel.test.ts` | Fatos locais orientam a resolução específica e não exibem retry genérico. |
| `tests/f3-suporte.test.ts` | Duas sequências de estorno agora exigem também cancelamento. |
| `docs/FASE-3-INTEGRACOES.md`, `docs/OPERACAO.md` | Achados, decisões, evidências, retomada e procedimento para restauração unilateral. |

### Asserções alteradas nesta segunda revisão

| Arquivo / caso | Antes | Agora | Decisão |
|---|---|---|---|
| `tests/erp/unico/f3-aceitacao.test.mjs` — A4/A8, cortes/política/agendador | Padrão `{stock:true,finance:true}` | Padrão `{stock:false,finance:false}` | 1: automação optativa. |
| `tests/f3-suporte.test.ts` — estorno confirmado encerra liberação e reverte a baixa própria uma vez, mesmo com Financeiro desligado | Sequência exata `recognize, receive, reverse` | Sequência exata `recognize, receive, reverse, cancel` | 8: reembolso extingue obrigação avulsa. |
| `tests/f3-suporte.test.ts` — estorno antes do gancho pago | Sequência exata `recognize, receive, reverse` | Sequência exata `recognize, receive, reverse, cancel` | 8: mesma regra, sem liberar atendimento. |

As demais diferenças nos testes são preparação ou provas adicionais. Nesta
retomada nenhuma expectativa existente foi substituída. Não houve edição em
testes protegidos, diferencial, migrações 0130–0133 ou 0135.

### Evidência de regressão e verificações da retomada

O log externo anterior aprovou `check`, `build`, **1.215 testes ERP** (um TODO
preexistente) e **2.247 testes de painel**. O Vitest terminou com **3.386
aprovações e quatro falhas**, em dois dos 307 arquivos. Esses números descrevem
a árvore recebida, antes das correções de preparação desta retomada.

Localmente, sem Vitest nem rede:

- Os quatro arquivos Node F3 (`f3-aceitacao`, `f3-corr-motor`, `f3-fechamento`,
  `f3-segunda-revisao`) passaram inicialmente **83/83**, sem pulados ou TODO.
  A prova adicional da revogação real passou, incluindo baixa e estorno no motor.
  Após acrescentá-la, `f3-fechamento` foi reexecutado inteiro: **24/24**.
  São **84 casos distintos** verificados na árvore final, sem falha.
- Controle negativo em cópia temporária: os **23 casos “segunda revisão”**
  existentes falharam com os caminhos anteriores de produção; os mesmos casos
  estão entre os 83 aprovados. Os novos exports de Mensalidade foram conservados
  apenas para carregar o harness; os chamadores anteriores não usavam as guardas.
  As falhas conferidas incluem reposição indevida, partes obsoletas, CNAB sem
  recusa específica, 1.000 predecessores em vez de um, depósito ausente,
  notificação de pagamento devolvido, obrigação avulsa sem cancelamento,
  desconto sem bloqueio, MFA ausente, padrão ligado, suspensão em `failed`,
  lifecycle em `done`, cancelamento parcial sem fato local, retry destrutivo,
  reserva retida, classificação contornada e status sem paginação.
- A projeção de Estoque também falhou isoladamente no controle negativo: ao
  restaurar só as guardas de reserva, o caso alcança a resposta comercial e
  encontra `installments`. A nova prova completa de revogação igualmente falha
  no caminho anterior em `aviso indisponível` durante o `paid` histórico.
- `npm run build`, `tsc --noEmit`, marcadores de conflito, escopo CSS e
  `git diff --check` passaram. O manifesto ORIGEM passou **4/4**.
- `npm run check` não concluiu: `spawnSync git EPERM` em `check-encoding.mjs`
  nesta área restrita. A mesma guarda de UTF-8 passou nos **4.397 arquivos**
  recebendo a lista obtida por `git ls-files` diretamente, em cópia temporária
  do script; o script versionado não foi alterado. Não se declara sucesso do
  comando completo com base nessa execução separada.
- A sintaxe dos dois arquivos Vitest alterados na retomada foi compilada com
  esbuild, sem executar o runner. O timeout e a sincronização em Cloudflare
  continuam sujeitos à nova verificação externa; não há declaração `TUDO VERDE`.

As alterações da retomada das quatro falhas não mudaram código de produção. Não houve commit,
acesso à rede, migração aplicada em instalação, dependência nova, classe de
Durable Object nova nem enfraquecimento de testes. Os adiamentos e as medições
pendentes descritos acima continuam válidos.

### Retomada do falso positivo no diferencial de contatos

O resumo recebido em `.codex-verificacao.log` contém apenas o resultado do
motor. A leitura dos logs completos já produzidos pelo verificador em
`/tmp/tmp.2q4O5smBa1` confirmou o resultado da execução seguinte:

| Verificação externa | Resultado |
|---|---|
| `check` | Aprovado; 4.397 arquivos na guarda de codificação. |
| `build` | Aprovado. |
| `test:erp` | 1.217 casos: 1.214 aprovados, duas falhas, um TODO preexistente, nenhum pulado. As duas falhas são o subteste de funcionários e seu teste pai, não dois defeitos distintos. |
| `test:erp:painel` | 2.247/2.247 aprovados; nenhum pulado. |
| Vitest completo | 3.390/3.390 aprovados, nos 307 arquivos. As quatro falhas da rodada anterior passaram. Vitest não foi executado localmente nesta retomada. |

**Causa:** `tests/erp/fagoo/catalog-contacts-lane.test.mjs`, no subteste de
funcionários, serializa o recibo e exige ausência de `529`, os três primeiros
dígitos do CPF sintético. O recibo contém um UUID aleatório, que também pode
conter essa sequência. A asserção não distingue um identificador legítimo de
dado pessoal. O log não registra o UUID sorteado naquela execução, mas a
reprodução controlada confirma exatamente a mesma falha.

O RPC real, tanto no oráculo quanto no SQLite, grava somente
`{entity:"employees",data_mode:"erp_native",replayed:false,item:{id,version}}`.
Isso foi conferido no código e nos dois bancos, sem identidade de sistema.
Não foi encontrado vazamento de CPF nem divergência de produção nesta falha.
O teste dedicado `catalog-employees.test.mjs` já descreve e evita o mesmo
problema de procurar apenas três dígitos; não foi alterado nesta tarefa.

**Correção preparada:** substituir a busca textual por igualdade profunda do
recibo inteiro com os únicos campos permitidos, mantendo a versão esperada
igual a 1 e o identificador retornado pela criação. Assim, qualquer campo
pessoal adicional, inclusive parcial, continua sendo recusado. Todos os outros
casos e asserções do arquivo permanecem. O patch revisável está em
`/tmp/f3-corr2-contacts-privacy.patch`, ainda fora da árvore: a regra da tarefa
proíbe editar testes do diferencial, e foi solicitada uma exceção específica.
Não se altera a geração de UUIDs nem o contrato do motor para acomodar o teste.

**Evidência desta retomada, sem rede e sem Vitest:**

- O arquivo original intacto passou isoladamente: **15/15**. Esse resultado
  confirma que a falha é intermitente; não é usado para declará-la resolvida.
- No banco efêmero do oráculo, forçar o UUID
  `00000529-0000-4000-8000-000000000001` reproduziu a asserção original:
  **13 aprovações e duas falhas**, contando o subteste e o pai. O diferencial
  continuou comparando RPC, respostas e tabelas reais dos dois motores.
- Com o mesmo UUID e somente a asserção proposta, a cópia completa do arquivo
  passou em **15/15**, sem pular casos ou mudar limites.
- Dois controles de recibo real (UUID com e sem `529`) passaram. A igualdade
  exata recusou os oito mutantes de vazamento por controle: CPF/PIS completos,
  com e sem pontuação, em campo extra da raiz ou do item.
- Os quatro arquivos Node F3 foram reexecutados juntos, com o runner no
  próprio processo (`--experimental-test-isolation=none`): **84/84 aprovados**,
  sem falhas, pulados ou TODO. `git diff --check` e a leitura UTF-8 da
  documentação também passaram.

Logs: `/tmp/f3-corr2-contacts-direct-before.log`,
`/tmp/f3-corr2-contacts-controlled-before.log`,
`/tmp/f3-corr2-contacts-controlled-after.log` e
`/tmp/f3-corr2-uuid-privacy.log`; a confirmação F3 está em
`/tmp/f3-corr2-atual-node-f3.log`. Os logs externos foram preservados como
`/tmp/f3-corr2-externo-{erp,painel,vitest}.log`.

Nesta retomada, o único arquivo versionado alterado é esta documentação;
o patch do teste protegido permanece uma proposta. Nenhum teste foi
enfraquecido, removido ou pulado, e não houve mudança de produção, migração,
dependência, esquema ou commit.
