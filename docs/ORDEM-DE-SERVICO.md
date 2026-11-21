# Ordem de Serviço

Para assistência técnica, oficina, lavanderia, costura e serviços parecidos:
o cliente deixa um item, a equipe analisa, envia o orçamento pelo WhatsApp, o
cliente aprova ou recusa, e é avisado quando o serviço fica pronto. Não tem
relação com os **protocolos** do atendimento: são registros separados.

## Ligar

**Gestão → Módulos → Ordem de Serviço** (administrador). Vem desligado. Com
ele ligado, entre pelo botão **ERP**. O módulo oferece **Ordens de serviço**
(toda a equipe) e **Configurar** (só administradores). O nome da lista pode
vir do vocabulário da área, sem se repetir no título do grupo lateral.

A lista reúne a clássica e os modelos personalizados ativos. **Modelo → Todos
os modelos** é o padrão; escolha um para filtrar e consultar suas etapas.
Também há busca, situação, responsável e prazo de/até. **Meus prazos** fica
no topo. Os detalhes existentes são preservados: diálogo da clássica e página
do personalizado. Os endereços antigos, inclusive `/app/gestao/...`, continuam
abrindo a página ou pré-selecionando o modelo correspondente.

## Abrir uma ordem

Cada área de atendimento tem a sua numeração (1, 2, 3…).

- **No balcão**: Ordens de serviço → **Nova ordem**; com vários modelos ativos,
  escolha primeiro o modelo. Na clássica, informe telefone, item,
  problema, observações internas, responsável e prazo previsto.
- **Na conversa**: a ação *Abrir ordem de serviço* liga a ordem à conversa e
  avisa o cliente. Hoje ela existe na API (`service_order`); o botão na tela
  da conversa ainda não foi feito.
- **Pelo cliente**: em ERP → Configurar → **WhatsApp**, use **Adicionar ao menu**
  em *Abrir ordem de serviço*. O cliente escolhe a opção, recebe um link,
  informa o item e o problema, aceita os termos e recebe o número no WhatsApp.

## Modelos para cada segmento

Em **Configurar → Modelos**, cada modelo define campos, etapas e mensagens
de um tipo de serviço. **Criar modelo** permite começar do zero ou escolher
um exemplo dos modelos de área, sem aplicar a área inteira. Campos e etapas
recebem IDs a partir do rótulo; a edição desses identificadores fica em
**Avançado**. Na tela usamos “modelo”; os nomes internos e as APIs permanecem.

Os exemplos de oficina cadastram o **Veículo** uma vez (placa opcional e
pública de até 10 caracteres, marca e modelo, ano, cor e tipo de combustível) e
registram em cada ordem quilometragem, nível de combustível na entrada, última
manutenção informada pelo cliente, peças previstas, avarias e serviço executado.
Quem já aplicou um desses modelos recebe o aviso **O modelo padrão mudou:
revisar e aplicar**, com prévia do que passa ao objeto e do que fica na ordem.
Ordens existentes não mudam. A placa antiga sensível não muda de classificação
nem é copiada para o cadastro do veículo: a placa pública é informada de novo.

## Objeto do serviço

Em **Configurar → Modelos**, o campo **Objeto do serviço** liga o modelo a um
tipo de objeto (veículo, equipamento, imóvel, animal, evento), cadastrado ali
mesmo. O editor mostra numa lista só os campos “Do objeto” e os “Desta ordem”,
e permite exigir um campo a partir de uma etapa ou ao sair dela, além de marcar
até quatro colunas e filtros da lista.

- **Nova ordem**: escolha o contato; aparecem os objetos ativos dele daquele
  tipo e a opção **Cadastrar outro** no mesmo diálogo. Os dados do objeto ficam
  separados dos desta ordem. Trocar o contato pede confirmação.
- **Detalhe**: o bloco “Veículo na abertura” (ou o rótulo do tipo) mostra a
  cópia gravada naquela ordem, só para leitura, com o link **Ver cadastro atual
  e histórico**. Uma etapa com campos pendentes abre o preenchimento antes de
  tentar de novo.
- **Tela do objeto**: dono, campos, arquivamento, revisão adotada, **Nova ordem
  para este objeto**, histórico de ordens com os campos de cada visita e
  **Último atendimento** (última ordem entregue).
- **Ficha do contato**: a coleção **Objetos do cliente** abre a tela do objeto.
- **WhatsApp**: o link de abertura pergunta “Qual veículo?” com os objetos do
  próprio cliente e **Informar outro**. Cada cliente só vê os próprios objetos.
- **Ordens antigas**: nada é convertido sozinho. Numa ordem personalizada sem
  objeto, a ação de vínculo cria ou associa um objeto do mesmo cliente, sem
  copiar quilometragem nem campos privados; a cópia aparece como “Vinculado
  posteriormente”.

Editar o cadastro do veículo não muda as visitas anteriores: uma visita com
60.000 km continua com 60.000 km e com a cor capturada naquela abertura. Quem
não usa objeto não vê diferença. Regras, rotas, limites e custos estão em
[TRABALHOS.md](TRABALHOS.md#objeto-do-serviço).

Modelos de mesmo nome mostram a origem, e a prévia de aplicação de área avisa
quando já existe um equivalente. Para detalhes, consulte [TRABALHOS.md](TRABALHOS.md).

## Estados

Recebida → Em análise → Orçamento enviado → Aprovada ou Recusada → Em
execução → Pronta → Entregue. Uma ordem pode ser **Cancelada** antes de
entregue. Também dá para ir direto de Recebida ou Em análise para Em execução
(serviço sem orçamento), devolver uma Recusada como Pronta (o cliente retira
sem conserto) e voltar uma Pronta para Em execução (retrabalho). Cada mudança
fica no histórico com quem fez e quando.

## Orçamento

Vale para a ordem clássica e para todos os modelos. No detalhe da ordem, o
bloco **Orçamento e recebimento** tem **Montar orçamento** (ou *Editar*):

- **Peças e serviços do catálogo do ERP**: *Buscar no catálogo* por nome ou
  código traz o preço da lista; ajuste quantidade e preço se quiser. O item
  guarda o vínculo com o produto (peça com vínculo baixa estoque na execução).
  Editar a ordem pela tela clássica ou pela nova mantém o vínculo.
- **Itens avulsos**: *Adicionar item avulso* com descrição e valor. Sem a parte
  **Produtos e serviços** do ERP ligada, só há itens avulsos, sem erro.
- **Desconto** em cada item e no total; o resumo mostra subtotal, descontos e
  total.
- **Condições de pagamento**: pagador (o cliente da ordem ou outro contato do
  cadastro), forma de pagamento (as formas do Financeiro do ERP, ou Pix,
  dinheiro, cartão, boleto, transferência) e parcelas (quantidade, primeira
  data e intervalo), com o resumo do que será cobrado. Sem o **Financeiro**
  ligado, a ordem guarda só o total combinado, sem parcelas.
- Validade em dias e uma observação ao cliente.

Depois, **Enviar orçamento**. O cliente recebe pelo WhatsApp um link **Ver
orçamento** (itens, descontos, total, condições e validade, com *Aprovo* ou
*Recuso* e o motivo da recusa) e, logo depois, a lista **Aprovar**/**Recusar**
de sempre. A ordem muda sozinha e guarda quem respondeu, quando e o motivo.
Se o cliente responder por telefone ou no balcão, use *Cliente aprovou* ou
*Cliente recusou* (*Registrar aprovação/recusa do orçamento* nos modelos):
a tela pede **quem respondeu, quando e por onde** (e o motivo da recusa).

- Orçamento **vencido** não pode ser aprovado: envie de novo.
- Mudar um orçamento já enviado volta a ordem para *Em análise* até o novo
  envio; respostas ao orçamento anterior deixam de valer.
- **Orçamento aprovado fica travado.** Para mudar, **Reabrir orçamento** e
  informe o motivo (fica no histórico); a aprovação deixa de valer e o
  orçamento é enviado e aprovado de novo. Só antes de iniciar o serviço. Se o
  orçamento aprovado já gerou o documento de venda no ERP, o ERP não o volta
  para análise: cancele a ordem com motivo e abra outra.
- Na linha oficial o orçamento chega como lista com **Aprovar** e **Recusar**;
  na linha QR, com "1. Aprovar / 2. Recusar". O cliente também pode escrever
  `APROVAR 12` ou `RECUSAR 12` (número da ordem). Com um menu aberto depois
  do orçamento, "1" e "2" são opções do menu. Fora da janela de 24 horas da
  linha oficial o link não sai; a lista segue pelo modelo de notificação.

## Cobrança e recebimento

Com o orçamento aprovado (ou o preço fixo autorizado), o mesmo bloco mostra
total, recebido e saldo:

- **Gerar Pix** ou **Gerar link de pagamento**: pela Cobrança da área
  (Gestão → Cobrança), enviado na conversa da ordem. O pagamento confirmado
  pelo provedor vira recebimento da ordem sozinho; o estorno do provedor, o
  estorno do recebimento.
- **Registrar recebimento**: sem provedor (dinheiro, cartão na maquininha,
  Pix direto), informe valor, forma e data. O que passar do combinado fica
  registrado fora das parcelas.

O recebimento chega ao **Financeiro do ERP** pela fila da fase 3 da própria
ordem (não há outro lançamento): com a conta a receber já criada (primeira
execução com Financeiro), no mesmo instante; registrado antes dela, segue
junto da execução. Com o Financeiro desligado, fica só na ordem.

## Cancelar e voltar etapa

**Cancelar ordem**, voltar de *Pronta* para *Em execução* (retrabalho) e voltar
para *Em análise* pedem o **motivo** antes de enviar. O motivo fica no
histórico e vai ao ERP quando a ordem já tem parte comercial.

## Imprimir

No bloco **Orçamento e recebimento**: **Imprimir orçamento (A4)**, **Imprimir
ordem (A4)** e **Cupom 80 mm**. A página abre pronta para imprimir ou salvar
em PDF pelo navegador, com os dados da empresa (Gestão → Estabelecimento),
cliente, objeto do serviço, itens, descontos e totais, condições, garantia do
modelo, recebido e saldo (na ordem) e campo de assinatura. Campos sensíveis do
modelo nunca saem; nas áreas reservadas (saúde, ensino, jurídico) os itens
saem como "Serviço contratado". Permita janelas pop-up no endereço do painel.

## Notas fiscais

Com o ERP e a parte **Fiscal** ligados e o cofre de notas configurado (ERP →
Fiscal → Configuração do emissor), o detalhe da ordem (clássica e modelos)
ganha o bloco **Notas fiscais**. Com o Fiscal desligado nada muda e a ordem
não fala de nota.

- **Nota de serviço (NFS-e)**: os serviços do orçamento (inclusive os itens
  avulsos) viram uma NFS-e do Sistema Nacional. Tomador é o pagador da ordem;
  a discriminação lista cada serviço como foi escrito (campos sensíveis do
  modelo nunca entram; nas áreas reservadas sai "Serviço contratado"). Código
  de tributação, alíquota e retenção do ISS vêm de **ERP → Fiscal →
  Configuração do emissor → Nota de serviço**; inscrição municipal, série da
  DPS e regime especial ficam no cofre. Prefeitura com provedor próprio ainda
  não é atendida (a tela diz quando o cofre não emite NFS-e).
- **Nota de peças (NF-e)**: as peças do orçamento ligadas a produtos do
  catálogo viram uma NF-e modelo 55, com o valor das peças. Exige também as
  partes Vendas e Produtos. Peça sem produto bloqueia com o nome dela.
- **Quando pode emitir**: orçamento aprovado (ou preço fixo autorizado) e a
  ordem aprovada, em execução, pronta ou entregue. Cada nota mostra o que falta
  quando ainda não dá (falta aprovar, falta o código do serviço, cofre não
  configurado, regime fora do Simples sem alíquota...).
- **Depois de emitir**: situação, número (na NFS-e, o número da nota e o da
  DPS), chave, **Baixar XML** e, na nota de peças, **Baixar PDF** (o cofre não
  gera PDF da NFS-e: consulte no Portal Nacional pela chave). Resultado que
  não chegou mostra **Consultar e retomar**: a mesma nota é conferida, nunca
  enviada de novo às cegas.
- **Cancelar nota**: justificativa de 15 a 255 caracteres (na NFS-e também o
  motivo). A prefeitura ou a SEFAZ decidem. Cancelar a nota **não desfaz a
  ordem**: o estoque e o financeiro lançados pela ordem continuam lançados.
  Depois do cancelamento, **Emitir de novo** gera a nova versão da nota.
- **Estoque e financeiro** continuam sendo os da parte comercial (fase 3): a
  nota não lança nada de novo. Com nota vigente, o ERP recusa estornar
  diretamente os lançamentos da ordem; cancele a nota antes de cancelar a
  ordem ou de reabrir o orçamento.
- **A ordem nunca espera a nota** para mudar de etapa. Nos modelos, em
  Configurar → Modelos → Recursos, **Exigir nota fiscal autorizada para
  entregar** (só aparece com o Fiscal ligado) faz a entrega pedir uma nota
  autorizada (de serviço ou de peças). A situação da nota é anotada quando o
  bloco consulta, emite ou cancela; se a entrega recusar com a nota já
  autorizada, abra o bloco para atualizar e tente de novo. A marca vale para
  as ordens abertas depois dela (as ordens guardam o modelo da abertura).
- **Homologação** por padrão; produção só pelo **Habilitar produção** da
  configuração do emissor.

**Rotas e bots (OS5).** Na rota do ERP `…/erp-comercial-nfe/os/{ordem}/notas`
(nomes estáveis, grupo `nfe` do inventário dos bots; escrita sensível, a pessoa
com o papel fiscal confirma): `osnota.list` (GET), `osnota.emit`
(`…/emitir`, `kind`: `nfse` ou `nfe`), `osnota.consult` (`…/consultar`),
`osnota.cancel` (`…/cancelar`, `justification` e, na NFS-e, `reason`),
`osnota.xml`, `osnota.pdf` e `osnota.cancel.xml` (GET com `kind`); e
`nfse.config.get`/`nfse.config.save` (`…/nfse/config`). Erros novos:
`os_note_not_allowed`, `os_document_missing`, `fiscal_nfse_not_supported`,
`fiscal_nfse_pdf_unavailable` e, na entrega, `invoice_required`. A migração
`0156_os_fiscal_notes.sql` só cria a tabela da situação anotada; o esquema do
ERP ganhou a versão 15 (só aditiva). Detalhes da máquina em
[COMERCIAL-NFE.md](COMERCIAL-NFE.md#ordem-de-serviço-nota-de-serviço-nfs-e-e-nota-de-peças-nf-e).

## Contrato de manutenção

Para quem atende o mesmo cliente todo mês (assistência técnica, decorador,
escritório): **Ordens de serviço → Contratos**. Exige os módulos **Ordem de
Serviço** e **Mensalidade** ligados; com a Mensalidade desligada, a aba diz
qual módulo ligar e nada mais muda.

- **Novo contrato**: escolha o cliente (e, se quiser, os objetos do serviço
  dele: equipamentos, veículos, imóveis), o **plano da Mensalidade**, a
  vigência (início e fim, ou indeterminado) e **o que cobre**: modelos de
  ordem incluídos (nenhum marcado: todos), serviços em texto, limite por
  período (por exemplo 2 visitas por mês, ou 5 horas), o que fazer com o
  **excedente** (entra no orçamento normal da ordem, ou avisa e pede a
  aprovação do cliente) e o preço da visita ou hora excedente.
- **Cobrança**: é a da assinatura da Mensalidade. Criar o contrato cria a
  assinatura pelo fluxo da Mensalidade (valor e dia do plano); também dá para
  criar sem assinatura. Não existe outro motor de cobrança.
- **Reajuste anual informado**: percentual e data (padrão: um ano após o
  início). Na data, o contrato avisa ("aplique o novo valor na assinatura");
  o valor nunca muda sozinho.
- **Assinatura em atraso** (parcela vencida além da carência da Mensalidade):
  o contrato escolhe **só avisar** ou **bloquear a cobertura** até o
  pagamento.
- A lista mostra situação, cliente, plano, próximos vencimentos e o uso no
  período. **Editar**, **Suspender** e **Encerrar** (com motivo; a assinatura
  pode acompanhar: pausa, retoma ou encerra) e **Imprimir** (A4 com os dados
  do Estabelecimento, cliente, objetos, cobertura, valores, vigência,
  condições e campo de assinatura).
- O contrato vigente aparece na **tela do objeto** e no topo da coleção
  **Trabalhos** da ficha do cliente.

**A ordem conhece o contrato.** No detalhe de uma ordem de cliente (ou objeto)
com contrato vigente aparece "Coberto pelo contrato nº 3: 1 de 2 visitas
usadas neste mês" e **Marcar como coberta** (em contratos por horas, informe
as horas). A marcação consome o limite do período e, com o orçamento ainda
editável, coloca a linha "Visita coberta pelo contrato" com valor zero
(marcada como coberta). O que passar do limite entra como **excedente**, com o
preço do contrato, e segue o fluxo comercial normal (com "pede aprovação", a
tela lembra de enviar o orçamento antes de executar). **Cancelar a ordem
devolve o limite**; **Desmarcar cobertura** também, com motivo. No editor do
orçamento, cada item pode ser marcado como coberto (valor zero), e o
orçamento impresso mostra "(coberto pelo contrato)".

**Visitas programadas.** O contrato pode ter recorrência (a cada N dias, ou
todo dia D) com antecedência configurável. A aba **Manutenções a abrir** lista
as visitas que entraram na antecedência: **Abrir ordem de manutenção** abre a
ordem do modelo escolhido, já coberta, e leva até ela para agendar; **Pular
esta data** passa para a próxima. Nada é aberto sozinho.

## Agendar a execução

No detalhe da ordem, o bloco **Execução agendada** tem **Agendar**:

- **Com a Agenda ligada**: escolha o serviço e o profissional da Agenda e um
  dos horários livres. O agendamento nasce na Agenda ligado à ordem; o cliente
  recebe a confirmação e o lembrete da própria Agenda. **Reagendar** remarca
  o mesmo agendamento e **Cancelar agendamento** cancela na Agenda. Mexer pela
  Agenda (remarcar, cancelar) aparece na ordem. Cancelar a ordem cancela o
  agendamento.
- **Sem a Agenda**: a ordem aceita só a data e a hora combinadas, digitadas,
  sem conferência de conflito. A confirmação sai pela conversa da ordem e o
  lembrete, 24 horas antes, pelo mesmo aviso da ordem.
- Sem conversa do WhatsApp ligada à ordem, nada é enviado e a tela diz.

A lista de ordens ganha a coluna e o filtro **Agendado para**, e **Meus
prazos** mostra no topo as **Execuções agendadas** das ordens em que a pessoa
é responsável (ou é o profissional da Agenda).

**Rotas e bots (OS4).** Nomes estáveis no OpenAPI do módulo:

| Operação | Rota | Bot |
| --- | --- | --- |
| `os.contracts.list` / `os.contracts.get` | `GET …/service-orders/contracts`, `…/contracts/{contract_id}` | leitura |
| `os.contract.create` | `POST …/service-orders/contracts` | proposta |
| `os.contract.update` | `PATCH …/contracts/{contract_id}` | proposta |
| `os.contract.status` | `POST …/contracts/{contract_id}/situation` (`status`, `reason`, `subscription`) | proposta |
| `os.maintenance.due` / `os.contract.visit` | `GET …/maintenance-due`, `POST …/contracts/{contract_id}/visits` | leitura / proposta |
| `os.order.contract` | `GET …/service-orders/{id}/contract` | leitura |
| `os.contract.cover` / `os.contract.release` | `POST …/{id}/contract-coverage`, `…/contract-coverage/release` | proposta |
| `os.schedule.get` / `os.schedule.set` / `os.schedule.cancel` | `GET`/`PUT …/{id}/schedule`, `POST …/{id}/schedule/cancel` | leitura / livre |
| `os.schedule.options` / `os.schedule.slots` / `os.my_schedule` | `GET …/schedule-options`, `…/schedule-slots`, `…/my-schedule` | leitura |

A lista de ordens aceita `scheduled_from`, `scheduled_to` e `scheduled=1` e
traz `scheduled_at`. Erros novos: `contract_not_covering`,
`contract_suspended`, `contract_overdue`, `already_covered`, `order_closed`,
`contract_ended`, `reason_required`, `no_visit_due`. As migrações
`0153_os_maintenance_contracts.sql` e `0154_os_order_schedule.sql` só criam
tabelas novas.

## Acompanhamento e avisos

- Item de menu **Acompanhar ordem de serviço**: o cliente vê as ordens abertas
  do telefone dele e o estado de cada uma.
- Mensagens automáticas (ERP → Configurar → WhatsApp):
  ordem aberta, orçamento aprovado ou recusado, serviço iniciado, pronta para
  retirada, entregue (com a garantia) e cancelada. Em branco, não envia.
  Marcadores: `{numero}`, `{item}`, `{estado}`, `{total}`, `{validade}`,
  `{garantia}`, `{pronto}`, `{previsao}`. Nos modelos personalizados com
  objeto, `{objeto}` traz a identificação pública da cópia da ordem.
- Fora da janela de 24 horas da linha oficial, os avisos saem pelo modelo de
  notificação de Regras de atendimento.
- **Lembrete de retirada**: uma mensagem quando a ordem está pronta há mais
  dias que o configurado (padrão 3; 0 desliga).
- **Ordem parada**: sem mudança há mais dias que o configurado (padrão 7), o
  evento `os.stale` vai para as integrações.
- **Garantia**: contada da entrega (padrão 90 dias; 0 para sem garantia).

Esses três prazos da clássica ficam em **Configurar → Prazos e garantia**.
Na mesma aba há atalhos para os Recursos dos modelos personalizados.

## Integrações e aplicativos

Rotas, formatos e eventos em [API.md](API.md#ordem-de-serviço-módulo-os) e no
OpenAPI (`/api/openapi.json`, tag Módulos).

**Parte comercial da fase 3.** O trabalho continua no atendimento e sua parte
comercial usa um documento protegido do ERP. Aprovação isolada não lança;
a primeira execução exige orçamento vigente aprovado ou preço fixo autorizado.
Pronta pode voltar à execução com motivo, sem nova postagem. Entrega registra
entrega/garantia e não confirma pagamento. Cancelamento não inventa estorno.

Os dados comerciais ficam congelados após efeito ou durante envio incerto.
Antes disso, o vínculo explícito de peça é gravado com a revisão e a saída
comercial no mesmo lote. Material sem vínculo não baixa estoque. Parte desligada
não impede o trabalho local nem autoriza lançamento retroativo ao religar.
“Tentar novamente” conserva a identidade do pedido; correção de corpo precisa
fechar o comando anterior. Uma falha no ERP permanece pendência, sem mudar o
estado operacional silenciosamente.

**Dado da ordem não é segredo por padrão.** O documento comercial e a
impressão levam os itens do orçamento como a pessoa escreveu, o título da
ordem no vocabulário do modelo (por exemplo "Ordem de serviço OF-12") e, como
equipamento, o objeto do serviço só com campos que o cliente pode ver. Campos
marcados como sensíveis no modelo nunca entram. Continuam **reservados**
(documento "Serviço contratado", sem dados técnicos, pagador adulto
confirmado por uma pessoa) os modelos de área de saúde, ensino e jurídico
(clínica médica, escolas, professores, advogados e escritório de advocacia) e
toda a área que aplicou um deles. Documentos já lançados não mudam.

**ERP → Ordens de serviço (antiga).** Com o módulo Ordem de Serviço ligado, a
tela antiga do ERP fica só para leitura. Documento que veio de uma ordem diz
isso e tem o link **Abrir a ordem de serviço**, que abre a ordem
correspondente (`/app/erp/modulos/trabalhos?origem=<id>`).

O aceite integrado ainda depende da verificação externa. Consulte
[FASE-3-INTEGRACOES.md](FASE-3-INTEGRACOES.md) para a ordem de liberação,
permissões, configuração, recuperação e campos ainda não exportados ao ERP.

**Rotas do comercial (OS3).** Todas no OpenAPI do módulo, com nome estável:

| Operação | Rota | Bot |
| --- | --- | --- |
| `os.quote.save` | `PUT …/service-orders/{id}/quote` (itens com `id`, `kind`, `discount_cents`; `discount_cents` e `terms` no corpo) | proposta |
| `os.decide` | `POST …/{id}/decision` (`detail`: `by_name`, `at`, `channel`) | proposta |
| `os.quote.reopen` | `POST …/{id}/quote/reopen` (`version`, `reason`) | proposta |
| `os.receipt.create` | `POST …/{id}/receipts` (`amount_cents`, `method`, `occurred_at`) | proposta |
| `os.charge.create` | `POST …/{id}/charges` (`method`: `pix` ou `link`) | proposta |
| `os.payments.get` | `GET …/{id}/payments` | leitura |

"Proposta": o bot propõe e a pessoa confirma; o servidor só aceita a escrita
comercial da pessoa (ou da proposta que ela confirmou). O vínculo de catálogo
de uma linha é gravado em `PUT /integrations/os/catalog/quote_item/{ordem}/{linha}`
depois de a linha existir. Erros novos: `quote_locked`, `quote_not_approved`,
`quote_reopen_blocked`, `nothing_to_charge`, `payment_method_unavailable`.
A migração `0152_os_quote_commercial.sql` acrescenta `quote_discount_cents`,
`quote_terms_json` e `decision_detail_json` a `os_orders`.

**Contagem por estado.** `GET /profiles/{perfil}/service-orders` traz, além
de `data` e `next_cursor`, o mapa `counts`: número de ordens da área em cada
estado, para os chips de filtro e os totais das telas.

```json
"counts": { "received": 3, "analyzing": 1, "quoted": 2, "in_progress": 4, "ready": 1, "delivered": 12 }
```

- As chaves são os códigos de estado, iguais ao campo `status` das ordens:
  `received`, `analyzing`, `quoted`, `approved`, `declined`, `in_progress`,
  `ready`, `delivered`, `cancelled` (em inglês, minúsculas, com `_`).
- **Só aparecem os estados com ao menos uma ordem**; chave ausente vale 0.
  Os valores são inteiros.
- A contagem é da área inteira: **não** segue os filtros da consulta
  (`status`, `open`, `q`, `phone`, `conversation_id`) nem a paginação. Para
  "abertas", some tudo menos `delivered` e `cancelled`.
- Rótulos em português para exibir: Recebida, Em análise, Orçamento enviado,
  Aprovada, Recusada, Em execução, Pronta, Entregue, Cancelada.

## Tipo embutido no motor de trabalhos

O contrato do [motor de trabalhos](TRABALHOS.md), em integração, mantém esta
Ordem de Serviço como tipo virtual `service_order`. Não é necessário migrar
configurações: `service_orders`, formulários, termos, nove estados, orçamento,
garantia, lembretes e histórico das operações antigas conservam seu significado.
Ausência de `type_id` na abertura ou no menu continua selecionando esse tipo.

Os campos novos são adicionais: `type_id`, `type_revision`, `type_number`,
`type_label`, `type_plural_label`, `display_number`, `stage`, `stage_label`,
`labels`, `extra`, `fields`, `version`, `next_stages` e `stage_approval`.
`status_label` continua sendo o rótulo do estado de base. Uma linha antiga usa
`status` como etapa efetiva, `number` como número do tipo e campos extras vazios.

`number` continua global, inteiro positivo até 2.147.483.647. Após abrir tipos
diferentes, o número global e a sequência do tipo podem divergir; mensagens e
comandos antigos continuam usando o global. `next_cursor` continua texto ou
nulo. `counts` também não segue os novos filtros `type_id` e `stage`; para
contagens por tipo/etapa, solicite `facets=1`.

Aplicativos antigos mantêm o fluxo completo do embutido. Para tipos novos,
conservam leitura e ações antigas não ambíguas; recursos próprios exigem versão
atualizada. `next_statuses` contém somente estados de base. Uma ação ambígua em
`/status` retorna `409 stage_required`; a interface nova usa `next_stages`.
A decisão de orçamento continua recebendo `approve`/`decline` e devolvendo
`approved`/`declined`.

O detalhe antigo mantém `history=legacy` por padrão. Interfaces novas podem
pedir `history=none` e consultar `/history`, paginado e com eventos dos filhos.
O cadastro do embutido não deve ser copiado para `os_work_types`.
