# Fase 3 — integração dos módulos com o ERP

Estado em 19/11/2026: **regressões do verificador investigadas, liberação pendente**.
Este é o relato consolidado da implementação e das duas rodadas de correção.
O log mais recente contém três falhas Vitest e 218 falhas no painel. As causas
foram identificadas; as correções de produção/preparação autorizadas estão nesta
árvore. Três arquivos fora da matriz têm propostas verificadas em separado e
ainda aguardam autorização de escrita.
A verificação externa recebida falhou; esta revisão não declara os três marcos aprovados. O verificador externo precisa concluir
`check`, `build`, `test:erp`, `test:erp:painel` e o Vitest integrado com
**TUDO VERDE**. As pendências abaixo também precisam de decisão dos donos.

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
`auto_post.finance` inicialmente ligados. Cada opção só tem efeito se sua parte
estiver ligada. Uma escolha explícita de desligar a automação permanece nos
religamentos. Não se escolhe o primeiro depósito, categoria, forma ou conta:
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
| `GET /integrations/:module/status` | Épocas, cortes e contadores por **origem** com eventos; inclui espera manual efetiva |
| `GET /integrations/:module/sources/:id` | Estado, revisão, confirmação, entregas e vínculos permitidos ao solicitante |
| `POST /integrations/:module/sources/:id/retry` | `{event_id}`; preserva pedido e comando |
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
