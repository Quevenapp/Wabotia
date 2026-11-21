# Venda com NF-e comercial

## Limites e arquitetura

Este percurso atende uma venda nacional integral de mercadorias, de um pedido salvo, modelo 55 e finalidade normal. O ERP prepara no servidor, congela a revisão, acompanha o cofre e concilia estoque e títulos. A NFapi guarda certificado e senha, numera, assina, transmite, arquiva e fornece DANFE/XML. Certificado e senha são configurados diretamente no cofre: não passam pelo painel do Wabotia.

O Worker orquestra chamadas entre transações síncronas do SQLite do `Coordinator` da área. Nenhuma transação aguarda a NFapi. A reivindicação durável precede o envio; o resultado fiscal é persistido antes dos efeitos. Estoque e financeiro têm transações e resultados independentes. Uma falha local nunca desfaz uma autorização.

O esquema ERP v10 acrescenta sete tabelas `erp_fiscal_vault__commercial_settings/order_emission/order_revision/order_command/order_cancel/order_effect/order_audit`. Não há migração D1, nova classe de Durable Object, novo recurso Cloudflare ou dependência. O backup do motor inclui essas tabelas. As revisões e a auditoria são imutáveis; corpo e XML restritos não entram no resumo de auditoria.

Não há projeção nas tabelas fiscais legadas, restritas à homologação. Os relatórios legados não passam a cobrir o histórico comercial novo. A NFC-e do balcão (modelo 65) e as notas da ordem de serviço (NFS-e e NF-e das peças) têm seções próprias abaixo. Nota avulsa, parcial, agrupada, importação/exportação, devolução fiscal, CC-e, inutilização e envio por canais ficam fora deste percurso.

O host instala a porta `commercialNfe` antes de renderizar as telas. Sua entrada fiscal usa o acompanhamento comercial e o acervo de saída somente para consulta. O componente portado continua disponível para hospedeiros sem essa porta; Compras conserva seu percurso, mas no host comercial não pode abrir uma saída legada por conversão, devolução ou URL direta. A exibição de documentos numéricos antigos no formulário portado preserva a compatibilidade anterior; ela não substitui a validação dos dígitos verificadores exigida pelo mapper antes de enviar uma NF-e ao cofre.

IBS/CBS/IS (reforma tributária): o preparo calcula por item (`src/erp/domains/fiscal/reform-calc.ts`, alíquotas de teste de 2026 por padrão) e põe o grupo `ibsCbs` (e `impostoSeletivo`) no item só quando o contrato do cofre os aceita, lido no Testar conexão e guardado ao salvar a configuração da NF-e; com o cofre que não aceita, a nota sai sem o grupo e a tela mostra os valores só para conferência; com teste de conexão anterior a essa leitura, produto classificado bloqueia até testar de novo. O total da nota não muda. Grupos de IBS/CBS digitados no item e tributação sem representação fiel no contrato continuam bloqueados. O cálculo não certifica legislação: o contador precisa validar a operação e a data concreta. Há limites na parametrização legada, incluindo CST do CRT 2 e `retained_base_rate` do ICMS normal; esta fatia preserva o motor/oráculo e bloqueia dados que não representem a tributação necessária.

Casos especiais (conferência contra o Bling, `src/erp/domains/fiscal/comnfe/special-groups.ts`): o contrato 0.12.0 do cofre recebe PIS/COFINS monofásico (CST 02 com alíquota diferenciada e CST 04 na revenda), que se configura na regra de PIS e COFINS da natureza. Não recebe combustível (código ANP), ICMS monofásico (CST 02, 15, 53 e 61), veículo novo, medicamento e lote, autorizados a baixar o XML, inscrição Suframa do cliente, nem locais de retirada e de entrega. Quando a venda depende de um desses grupos, o preparo bloqueia dizendo o grupo e o que fazer; os autorizados a baixar o XML e a inscrição Suframa sem benefício viram aviso na revisão ("Dados que não vão nesta nota") e a nota sai sem eles.

## Configuração

1. No cofre, configure emitente, certificado/senha, ambientes, séries e credencial. Restrinja a chave ao ambiente e às operações necessárias.
2. Em Preferências do ERP, configure URL HTTPS e chave do emissor e execute **Testar conexão**. O servidor confere identidade, ambientes, séries e contrato. O contrato local é 0.12.0: mesma major é compatível, inclusive minor posterior; mínimos por recurso continuam valendo.
3. Complete Dados da empresa, cliente, produtos, natureza, regras e pagamentos. CNPJ numérico e alfanumérico preservam seus caracteres e passam pela validação dos dígitos verificadores.
4. Salve a configuração comercial: ambiente, séries permitidas e momento dos efeitos. Os padrões são homologação e `existing` para ambos os eixos. O motor confere empresa e identificação pública da conexão sem receber a chave.
5. Antes de produção, teste a conexão com permissão de produção, revise com o contador e use **Habilitar produção**, com confirmação explícita de administrador e ciência dos limites. A ação é auditada. Trocar o cofre invalida a habilitação anterior. Use novos pedidos: pedido usado em homologação não é reciclado para produção.

Número não é editável. A série é resolvida pelo cofre ou escolhida entre as séries retornadas para NF-e e ambiente. Alterar configuração não redireciona uma emissão aberta: retomada e arquivos exigem a conexão original e o ambiente congelado. Rotacionar uma chave da mesma origem/emitente conserva o fingerprint público.

## Checklist antes da primeira nota (A9)

- [ ] Cofre instalado; certificado e senha configurados diretamente nele.
- [ ] URL HTTPS e chave salvas; conexão testada; versão compatível e ambiente permitido.
- [ ] CNPJ do ERP igual ao emitente do cofre.
- [ ] CRT, IE e endereço completo da empresa conferidos.
- [ ] Série NF-e resolvida pelo cofre, sem numeração local.
- [ ] Cliente com documento, endereço, município e condição de IE.
- [ ] Produtos com NCM, origem, unidade e dados condicionais aplicáveis.
- [ ] Natureza e parâmetros revisados; regras cobrem todos os itens.
- [ ] Contador conferiu limites, inclusive omissão de IBS/CBS/IS para operação e data.
- [ ] Pagamentos, parcelas e total fiscal coincidem.
- [ ] Transporte coerente com a operação.
- [ ] Políticas de estoque e financeiro escolhidas.
- [ ] Depósito, saldo/reserva, categoria/conta e responsáveis locais conferidos; pendências não fiscais identificadas.
- [ ] Pessoa habilitada para a nota e responsável por cada efeito definidos.
- [ ] Área de ensaio e consequências comerciais da homologação compreendidas.

## Papéis, bots, partes e efeitos

A política sensível única é `requireCom1SensitivePolicy`, em `src/erp/domains/fiscal/comnfe/access.ts`. Fiscal/admin prepara, emite, retoma e cancela; administrador configura. Estoque e Financeiro exigem seus respectivos papéis/permissões. Fiscal pode autorizar e registrar falta do papel local como pendência, sem ganhar poder de movimentar estoque ou títulos.

As doze operações estão descritas em `commercial-nfe/metadata.ts`, integradas ao módulo Fiscal, OpenAPI e catálogo de ações. Escritas são sensíveis. Por padrão o bot propõe e uma pessoa com o papel confirma; a execução usa a pessoa confirmadora, e auditoria conserva proponente e confirmador. O ponto de política aceita uma concessão autônoma já verificada, sem bloqueio estrutural por ser bot. Concessão não substitui pessoa ∩ bot, horário/MFA, partes, permissões ou privacidade. Origem externa (WhatsApp/cliente) não alcança estas operações. Dados pessoais para IA permanecem mascarados por padrão. Nas consultas de arquivos, a ferramenta do bot recebe metadados e um vínculo autenticado para a pessoa, depois da mesma busca/validação; bytes fiscais não são incluídos na resposta JSON da IA.

Na junção candidata, o caminho real exige concessão nominal em `bot.update`:
`erp_operations` contém os nomes `com1.*` liberados para o bot daquela área,
com aviso `erp_data_acknowledged=true` ao configurar. Nasce vazio. Catálogo,
rota e ponte conferem a concessão atual e a conversa interna; escrita exige
proposta realmente em confirmação pela sessão humana. Só informar
`proposal_id` não autoriza. A ponte revalida a concessão após I/O antes de
novos comandos; arquivar evidência já reivindicada continua usando sua
capacidade durável. O ponto de concessão autônoma permanece injetável;
configuração persistida de autonomia e editor no painel ficam fora desta junção.

Preparação/primeiro envio exigem Base, Produtos, Vendas e Fiscal. Histórico, arquivos, retomada e cancelamento exigem Base/Fiscal, sem depender de Vendas, PDV, Compras ou Cobrança. A persistência interna de evidência previamente reivindicada continua permitida mesmo após revogação ou desligamento de Base/Fiscal; exige capacidade durável, não autoriza outro envio nem efeitos.

Com Fiscal desligada, a venda sem nota continua pelos caminhos comerciais existentes. Desligar Fiscal não libera edição destrutiva de nota enviada/aberta. Estoque/Financeiro desligados não bloqueiam a nota: cada efeito fica `pulado/part_disabled`, e religar não aplica nada automaticamente. **Aplicar efeito pulado** exige nova intenção explícita.

Com `on_authorization`, automatismos comerciais adiam os efeitos e postagens manuais/agrupadas antecipadas são recusadas. Reserva continua permitida. Depois da autorização, o ERP reconhece postagem equivalente, consome reserva compatível ou usa os comandos existentes para lançar. Divergência, falta de saldo, categoria, conta ou papel gera pendência localizada, sem nova origem substituta. Homologação pode movimentar estoque, títulos e recebimentos comerciais reais na área de ensaio; não existe um segundo estoque/financeiro fictício por ambiente fiscal.

## Operação diária e recuperação

No pedido salvo, use **Preparar NF-e**. Revise ambiente, participantes, itens, regra aplicada, bases, alíquotas, valores, totais, pagamentos e transporte. Corrija os bloqueios nos cadastros indicados e atualize a preparação. O navegador envia escolhas e versões; não fornece impostos confiáveis, chave, protocolo ou autorização.

**Emitir NF-e** confirma a revisão e seu hash. A referência `wb.<UUID do pedido>.v<versão fiscal>` é persistida e não muda por postagem técnica, duplo clique ou timeout. O mesmo comando conserva o recibo; usar o UUID com outro ator ou outros argumentos gera conflito. Duas abas disputam a mesma emissão. Antes do primeiro envio, o motor relê o fingerprint das fontes: mudança exige atualizar e revisar.

Em `enviando`, `processando` ou `incerta`, use **Consultar/retomar** na mesma emissão. Fechar a aba não apaga a intenção. Reivindicação vencida exige consulta; não permite gerar outra referência. Outra pessoa autorizada pode retomar com comando próprio, conservando autoria anterior. Rejeição conclusiva permite corrigir e criar revisão imutável na mesma referência. Nova versão fiscal só é explícita após encerramento permitido.

Em `autorizada`, confira identificador, ambiente, chave, número/série e protocolo retornados pelo cofre. Abra DANFE/XML pelo vínculo da emissão. O PDF vem do cofre; o ERP não o gera nem o armazena. Situação fiscal e cartões de efeitos são separados. Corrija pendências na área responsável e tente novamente com comando novo; a autorização permanece visível. Receber parcelas é uma operação do Financeiro, sem baixa automática causada pela emissão.

## Cancelamento mínimo

Use justificativa de 15–255 caracteres. O cofre decide a aceitação. O evento é persistido antes de compensações e do arquivamento do XML, com hash SHA-256. Resposta perdida é consultada no mesmo identificador; repetição do evento não comprova compensação comercial. XML ausente gera pendência própria e pode ser arquivado em nova retomada, sem cancelar novamente um evento já confirmado.

Título recebido conserva título, baixa e razão: a compensação financeira fica pendente. Sem recebimento nem vínculo de cobrança impeditivo, a reversão financeira existente pode compensar os títulos. CNAB/cobrança vinculada e faturamento agrupado exigem resolução humana; não há chamada ao banco ou cancelamento de grupo por inferência. Nenhum escritor cancela conta com vínculo de cobrança bancária, inclusive o cancelamento genérico do Financeiro (`erp_finance_billed_locked`; desvio deliberado `titulo-cobranca-bancaria` em `src/erp/schema/deviations.ts`).

Estoque exige confirmação humana de retorno físico e as validações normais de saldo/lote. Aumentar saldo por lançamento inverso não prova devolução. Sem retorno físico ou com reversão recusada, a compensação permanece pendente. Efeitos históricos podem ser mantidos com a parte local desligada pelo escopo estreito existente, sem ampliar papéis. Cancelar comercialmente o pedido não contorna o evento fiscal nem a confirmação física.

Os estornos e cancelamentos diretos de efeito do pedido (`erp_document_stock_reverse`, `erp_document_finance_reverse`, estorno de estoque e de títulos da nota legada vinculada e todo cancelamento de título do pedido, inclusive `title_cancel`, exclusão de conta, devolução e exclusão de faturamento agrupado) consultam a mesma guarda fiscal, com Fiscal ligada ou não. Com emissão vigente (`enviando`, `processando`, `incerta` ou `autorizada`) eles recusam com `fiscal_order_effect_locked`: o caminho é cancelar a nota e conferir a compensação. Depois do cancelamento fiscal, o estorno direto de estoque recusa com `fiscal_order_compensation_required`, porque só a compensação da nota pede a confirmação de retorno físico; o estorno financeiro direto fica permitido e a compensação reconhece a reversão anterior.

Cancelar, corrigir o dado fiscal e emitir de novo sem a mercadoria voltar é permitido: o preparo da nova versão não exige encerrar as compensações da anterior. Quando a nova emissão autorizada reconhece o mesmo lançamento (estoque ou títulos), ela passa a responder por ele. A compensação da versão cancelada fecha como **Transferida para a nova emissão**, com a emissão de origem e de destino, o instante e o comando registrados na compensação e na auditoria (`effect_transfer`). A partir daí a versão cancelada não estorna esse lançamento (`com1_effect_transferred`), nem quando ela nunca o tinha registrado; quem compensa é a emissão que responde por ele, depois do seu próprio cancelamento.

Nota cancelada diretamente no cofre antes de o ERP registrar a autorização: a retomada reconhece `cancelled` com a mesma identidade (referência, ambiente, identificador e chave conferidos), registra a autorização e o cancelamento, abre as pendências de compensação e retoma o evento só por consulta ao cofre, recuperando protocolo e XML sem pedir outro cancelamento. A justificativa local desse evento é fixa ("Cancelamento feito diretamente no cofre; evento recuperado pela retomada."); se o XML faltar, **Retomar cancelamento** usa a mesma justificativa.

## Balcão com NFC-e (modelo 65)

A venda finalizada no Caixa / PDV sai com NFC-e pela mesma máquina: preparo congelado em revisão imutável, reivindicação durável antes do envio, evidência gravada antes dos efeitos, retomada por consulta, cancelamento com evento e XML, efeitos e auditoria. Não há segunda máquina: `comnfe/model.ts` escolhe, num escopo síncrono, o modelo da operação (`nfe` ou `nfce`), as tabelas, o documento no cofre e o modelo da chave de acesso.

**Esquema v13 (só aditivo).** O CHECK de autorização de `order_emission` (v10) exige `55` na chave e não muda sem reescrever a tabela. As irmãs `erp_fiscal_vault__counter_emission/revision/command/cancel/effect/audit` nascem do mesmo DDL da v10, só com o nome e o modelo `65` trocados; `counter_settings` guarda apenas a natureza de operação do cupom. Conexão, ambiente e "Habilitar produção" são os de `commercial_settings`, compartilhados com a NF-e.

**O que o modelo 65 muda** (`comnfe/nfce.ts`): consumidor final, presencial e interno; destinatário só com o CPF/CNPJ opcional informado no fechamento; sem transporte, cobrança, data de saída, destino ou indicador de consumidor final; pagamentos detalhados por forma a partir das parcelas da venda do caixa (dinheiro, Pix, cartão com integração, bandeira e CNPJ da credenciadora quando cadastrados na forma; a autorização do cartão não existe no PDV e é omitida); troco somado ao dinheiro (vPag − vTroco = vNF). Os bloqueios da NF-e sobre grupos que o modelo 65 não tem são descartados; os do emitente, itens, NCM, CFOP e impostos continuam. A série vem do último "Testar conexão" (a menor série de NFC-e do ambiente quando houver várias); o CSC e o resto do emitente ficam no cofre, que não informa se o CSC está cadastrado.

**Natureza.** Uma natureza de saída ativa, não devolução, faturada e do mesmo CRT; com uma só, ela é usada sozinha; com várias, o administrador escolhe em Preferências do Fiscal (`nfce.config.save`).

**Venda nunca espera a nota.** O caixa registra a venda como antes; o painel pede o cupom em seguida (`nfce.emit`). Cofre fora do ar, demora, rejeição ou bloqueio deixam a venda feita e o cupom pendente, com o motivo em palavras. Resultado incerto é sempre consultado (`nfce.consult`, a mesma retomada da NF-e); pedir de novo sobre uma emissão em andamento vira consulta. Durante a reivindicação (60 s) a emissão segue ocupada.

**Contingência.** O contrato 0.12.0 oferece contingência offline da NFC-e. O cupom é pedido com `contingencia: automatica`: sem resposta da SEFAZ em 20 s, o cofre emite em contingência (tpEmis 9), devolve `contingencia` e transmite sozinho depois. O ERP grava a emissão como `processando` com `provider_status = contingency`: o cupom imprime (vias do consumidor e do estabelecimento), fica na lista de pendentes e a consulta confere a autorização. Efeitos e cancelamento esperam a autorização.

**Cancelamento e devolução.** Dentro de 30 minutos da autorização (`NFCE_CANCEL_MINUTES`; a SEFAZ decide), `nfce.cancel` cancela no cofre com justificativa (15–255) e, só depois do evento registrado, cancela a venda do caixa pelo RPC do PDV dentro da capacidade da compensação (`withCom1Compensation`, `effect-policy.ts`): estornos de baixa, títulos e estoque ficam liberados só para aquele pedido; o estoque exige confirmar que a mercadoria voltou. Em seguida a compensação da nota reconhece os estornos (`previous_reversal`). Fora do prazo a tela explica que é devolução (fora desta fatia) e nada é cancelado. Com cupom vigente ou em andamento, o cancelamento direto da venda recusa (`erp_pos_sale_invoice_linked`) e a NF-e do pedido não é preparada por cima (`fiscal_emission_open`), e vice-versa.

**Papéis.** Fiscal/admin pelas permissões da nota; o operador de caixa (`vendas`) emite, consulta e cancela o cupom da venda pelas permissões do PDV (fechamento). Leitura também para financeiro e consulta. Efeitos continuam exigindo Estoque/Financeiro; a falta do papel vira pendência.

**Partes.** Tudo exige Caixa / PDV e Fiscal (e Vendas/Produtos para emitir). Com Fiscal desligado o PDV funciona como antes, sem menção a cupom; a rota recusa `module_disabled` dizendo quais partes ligar.

**Operações** (`commercial-nfe/nfce-metadata.ts`, rota `erp-comercial-nfe/nfce/…`): `nfce.config.get`, `nfce.config.save`, `nfce.sales` (vendas com a situação do cupom, pendentes e contagem do turno), `nfce.get`, `nfce.emit`, `nfce.consult`, `nfce.coupon` (DANFCE de 80 mm do cofre) e `nfce.cancel`. Emitir, consultar, cancelar e configurar são sensíveis; entram no inventário dos bots (`bot-access.ts`, grupo `nfe`) exigindo Fiscal e Caixa / PDV. RPCs do motor: `erp_com1_nfce_prepare`, `erp_com1_nfce_sales`, `erp_com1_nfce_config_get/save`, `erp_com1_nfce_sale_cancel`; as demais (`erp_com1_get/claim/record/cancel_*/effect_*`) roteiam pelo modelo da emissão.

**Tela.** No PDV: CPF/CNPJ opcional na aba Pagamento; depois de finalizar, "Emitindo o cupom fiscal…" e então "Cupom fiscal autorizado" com **Imprimir cupom** e **Mandar ao cliente** (o PDF do cofre pelo compartilhar do aparelho, ou baixado para anexar), ou "Cupom fiscal pendente" com o motivo e **Tentar de novo**, **Corrigir e reenviar** e **Consultar**; **Cupons pendentes** na coluna de pedidos; o fechamento de caixa conta autorizados, pendentes e cancelados do turno. No Fiscal: Cupons pendentes dos últimos 7 dias e, em Configuração do emissor, o que o cofre informou para a NFC-e e o que falta.

**Prova automatizada.** `tests/erp/comnfe/nfce-balcao.test.mjs` vende pelo RPC real do PDV e emite contra cofre simulado: autorização modelo 65 sem grupos da NF-e e com troco, repetição sem segundo envio, cofre sem resposta seguido de consulta, rejeição com texto e reenvio na mesma referência, contingência, cancelamento no prazo com venda/estoque/contas desfeitos, prazo vencido, partes desligadas e CPF inválido.

## Ordem de serviço: nota de serviço (NFS-e) e nota de peças (NF-e)

A ordem de serviço com orçamento aprovado (ou preço fixo autorizado) e em execução, pronta ou entregue emite pela mesma máquina, a partir do documento comercial `service_orders` que a fase 3 gerou para a ordem (âncora `document` da origem `os/<ordem>/main`). O documento continua somente para consulta: a captura o lê e não o altera. Não há máquina paralela: `comnfe/model.ts` ganhou o modelo `nfse` no mesmo seletor.

**Esquema v15 (só aditivo; a outra tarefa usa a 15 e a junção renumera).** O CHECK de autorização da v10 exige chave de 44 posições do modelo 55, série até 999 e protocolo, que a NFS-e não tem. As irmãs `erp_fiscal_vault__service_emission/revision/command/cancel/effect/audit` nascem do mesmo DDL da v10, com o nome trocado e só três restrições diferentes: série da DPS até 5 dígitos, número da DPS até 15, chave nacional de 44 a 50 caracteres (opcional) e, na autorização, o número da NFS-e (`numeroNfse`) na coluna `protocol`. `service_settings` guarda o cadastro fiscal do serviço (código de tributação nacional e municipal, NBS, alíquota e retenção do ISS, apuração do Simples, município de prestação, exceções por serviço do catálogo e a natureza da nota de peças). Nenhuma migração D1 no motor, nenhuma classe nova de Durable Object.

**O que a NFS-e muda no seletor.** Um DPS tem um serviço só: os serviços da ordem (itens do grupo `service`, inclusive avulsos) precisam do mesmo código de tributação nacional (e do mesmo código municipal, NBS e alíquota); a discriminação lista cada linha como a pessoa escreveu (os campos sensíveis do modelo já ficaram fora do documento da fase 3; nas áreas reservadas sai "Serviço contratado"). Tomador é o pagador da ordem (contato do documento), com endereço só quando completo. Valores: soma bruta dos serviços e desconto incondicionado (desconto da linha mais a parte do desconto do total da ordem, repartido pelo valor líquido de cada linha, a mesma repartição da nota de peças). Prestador: município da empresa e regime pelo CRT (1 → `me_epp` com apuração 1 por padrão; 2 → `me_epp` com apuração 2; 4 → `mei`; 3 → `nao_optante`). Inscrição municipal, série da DPS e regime especial não vão no pedido: ficam no cofre. Retomada: o contrato não tem consulta ao governo para NFS-e; resultado incerto repete o pedido com a mesma referência (o cofre consulta a SEFIN antes de reenviar). Cancelamento: motivo (`erro_emissao`, `servico_nao_prestado` ou `outros`) e justificativa de 15 a 255; o XML do evento é conferido por chave, ambiente, número e data do evento. O contrato não gera PDF da NFS-e: a tela oferece o XML e explica que a nota é consultada no Portal Nacional pela chave. Prefeituras com provedor próprio não estão cobertas: o cofre informa `documentos.nfse` no Testar conexão e a tela diz quando ele não emite.

**Simples Nacional primeiro.** No Simples a nota de serviço sai sem alíquota (enviada só se cadastrada); fora do Simples (CRT 3) ou com ISS retido pelo cliente a alíquota é exigida com mensagem clara, e a retenção exige cliente com CNPJ. Serviço com classificação de IBS/CBS no cadastro é bloqueado com explicação (IBS, CBS e IS continuam fora).

**Nota de peças.** Os itens do grupo `part` viram uma NF-e modelo 55 pelo caminho que já existe (`capturePreparationSources` com o escopo `os_parts`): itens só das peças, totais refeitos com a parte do desconto do total, parcela única com o valor das peças, a forma e o vencimento da primeira parcela da ordem (sem forma cadastrada, "99 Outros"), transporte "sem ocorrência" (9) quando não houver, código do item pelo do produto (ou o id do produto no ERP). Peça sem vínculo com produto do catálogo bloqueia com o nome da peça. A natureza é a escolhida em Preferências do Fiscal (ou a única possível). A recaptura no claim usa o mesmo escopo.

**Efeitos.** A nota da ordem não lança estoque nem financeiro: os efeitos são os da fase 3. Os dois eixos ficam `pulado` com o motivo `module_origin_effects`, sem pendência nem compensação; cancelar a nota não desfaz a ordem e a tela diz que o que a ordem lançou continua lançado. Com nota vigente (qualquer das três famílias), os estornos e o cancelamento direto do documento recusam como os do pedido (`fiscal_order_effect_locked`, `effect-policy.ts`); o cancelamento da ordem fica pendente na fila da fase 3 até a nota ser cancelada.

**Partes e papéis.** Tudo exige Fiscal ligada e o cofre configurado; a nota de peças também Vendas e Produtos (a NFS-e não). Fiscal/admin emitem, retomam e cancelam; consulta e fiscal leem; administrador configura. Com Fiscal desligada a ordem não menciona nota.

**Operações** (`commercial-nfe/os-notes-metadata.ts`, rota `erp-comercial-nfe/os/<ordem>/notas…`): `osnota.list`, `osnota.emit` (`kind`: `nfse` ou `nfe`), `osnota.consult`, `osnota.cancel` (`justification`, `reason` só na NFS-e), `osnota.xml`, `osnota.pdf` (só a NF-e), `osnota.cancel.xml`, `nfse.config.get` e `nfse.config.save`. Emitir, consultar, cancelar e configurar são sensíveis; entram no inventário dos bots (`bot-access.ts`, grupo `nfe`). RPCs do motor (`comnfe/os-notes.ts`): `erp_com1_os_notes`, `erp_com1_os_prepare`, `erp_com1_nfse_config_get/save`; as demais roteiam pelo modelo da emissão. A ordem ser elegível (aprovação, estado) é lida no D1 pela ponte `src/modules/os/fiscal/notes.ts`.

**Prova automatizada.** `tests/erp/comnfe/os5-notas.test.mjs` atravessa motor real e serviço com cofre simulado: as duas notas no Simples Nacional, resposta perdida retomada pela mesma referência, cancelamento com motivo e nova versão, XML/PDF, bloqueios em palavras (aprovação, cofre sem NFS-e, regime normal, IBS/CBS, peça sem produto, códigos diferentes), partes e a guarda de estorno. `tests/os5-notas.test.ts` cobre rota, inventário dos bots e "exigir nota para entregar".

## Integração com Documents, Finance, Stock e fase 3

As alterações comerciais ficam nos pontos abaixo:

| Arquivo | Encaixe |
|---|---|
| `documents/rpc/erp_document_save.ts` | Guarda de conteúdo protegido e `deferredCom1Effect` no automatismo financeiro. |
| `documents/rpc/erp_document_transition.ts` | Guarda de transição/cancelamento e adiamento dos dois automatismos. |
| `documents/rpc/erp_module_apply.ts` | A projeção do módulo permanece gravada; os efeitos aguardam autorização fiscal, e cancelamento/transição respeitam emissão já enviada. |
| `fiscal/comnfe/source.ts` | O preparo e a recaptura recusam pedido vinculado a módulo, preservando a mesma leitura exclusiva da lista; só o escopo `os_parts` (peças da ordem de serviço) lê o documento da fase 3, sem alterá-lo. |
| `documents/rpc/erp_document_small_writers.ts` | Protege observações usadas na nota e o vínculo fiscal na lixeira; observações internas operacionais continuam permitidas. |
| `stock/rpc/document-stock.ts` | `requireCom1Posting` antes de nova saída. |
| `stock/rpc/document-stock-read.ts` | A mesma guarda no caminho com depósito. |
| `finance/rpc/erp_document_finance.ts` | Guarda após replay e antes de criar posting/títulos. |
| `finance/rpc/erp_finance_grouped_billing.ts` | Guarda de cada pedido incluído no agrupamento. |

Os caminhos são relativos a `src/erp/domains/`. Os helpers ficam em `fiscal/comnfe/effect-policy.ts`: `deferredCom1Effect`, `requireCom1Posting`, `guardCom1CommercialSave`, `guardCom1Transition`. Ao juntar a fase 3, preserve essas guardas e a ordem replay → política → nova postagem; preserve também as exceções específicas no manifesto `web/erp/ORIGEM.json`. A política "só na autorização" do modelo 55 não se estende à ordem de serviço: as notas da ordem nunca lançam (seção acima). `POST /v1/nfse/{id}/conferir`, disponível no cliente 0.12.0, confere cancelamento externo de NFS-e; não é recuperação genérica de emissão e não é usado pela retomada.

Na junção candidata, pedidos de venda originados em módulos continuam somente para consulta no ERP e não oferecem **Preparar/Acompanhar NF-e**; o RPC também recusa o preparo. A opção "lançar só quando a nota for autorizada" (`on_authorization`) vale para pedidos de venda do próprio ERP. Fato vindo de módulo (Pedido, Mesas, Entrega e os demais) ainda não emite NF-e por aqui e é venda já acontecida: segue a automação da fase 3 e a intenção manual, sem ficar preso em `awaiting_fiscal_authorization`. Recibo antigo que ficou nesse estado numa instalação conserva o replay e ganha saída pela intenção manual, com suas permissões. A ordem de serviço emite as suas notas pela seção própria acima; nos demais módulos a emissão fiscal continua sendo uma lacuna de produto a decidir. As duas guardas de faturamento agrupado permanecem juntas: origem de módulo e momento fiscal.

## Evidência automatizada e limites de verificação

`tests/erp/comnfe/aceite.test.mjs` atravessa preparação, registro real de RPCs, serviço, SQLite, estoque e financeiro, com transporte simulado em memória e relógio injetado. Prova o ciclo integral, recebimento preservado, compensação de título não recebido, repetição, comandos concorrentes, nova pessoa, rejeição corrigida, bloqueio sem chamadas externas, partes desligadas e falhas antes/depois dos commits. Os testes específicos complementam reserva, agrupamento, efeitos preexistentes, papéis separados, saldo/categoria, isolamento por ambiente, CNPJ alfanumérico, migração e backup/restauração.

`tests/com1-aceite.test.ts` usa o cofre simulado oficial `tests/erp/emissor/fake-vault.ts`, cliente NFapi e motor real no Coordinator, sem governo ou cofre real. As provas de Worker, catálogo/segurança, manifesto e painel fazem parte da verificação externa. Nesta máquina não se executam Vitest nem Wrangler. Os resultados efetivamente executados são informados na entrega; a existência de um cenário escrito não significa que o Worker ou a instalação real tenham passado.

O log da verificação externa recebido em 19/11/2026 registra 1.252 testes Node aprovados, nenhuma falha e um TODO preexistente (1.253 casos), incluindo diferencial, migrações e backup/restauração. No Worker, oito arquivos passaram; o aceite integrado apresentou cinco falhas, com 160 testes aprovados e cinco falhos no conjunto. A sequência externa parou antes da suíte integral do painel.

As cinco falhas tinham duas causas no preparo da prova: o fake da conexão não fornecia o OpenAPI exigido para confirmar a compatibilidade; o fake da emissão devolvia sempre R$ 100,00 para um pedido de R$ 51,00. A integração corretamente deixava a conexão sem vínculo verificado e os efeitos locais pendentes por divergência. O fake agora recebe o contrato versionado na prova pública e totaliza os valores declarados dos itens, inclusive após uma rejeição corrigida. O motor continua bloqueando efeitos de um total divergente; um novo teste Node reproduz esse caso e exige zero lançamentos, preservando a autorização fiscal.

Na retomada local, passaram os 195 testes Node da fatia e da totalização do fake, incluindo os novos cenários de seleção do host, proteção do percurso de compras e retomada de importação. O aceite Node usa o mesmo totalizador puro do fake oficial. A compilação avulsa dos testes Worker alterados passou; a suíte Worker corrigida ainda precisa de nova execução externa, pois a compilação não substitui essa prova.

A execução integral local do painel revelou 34 regressões da substituição incondicional das telas portadas e da projeção de documentos numéricos legados. A seleção pela porta comercial, a preservação do percurso de Compras e a compatibilidade explícita da projeção corrigiram essas falhas sem alterar expectativas dos testes existentes. Depois das correções, `npm run test:erp:painel` passou com 2.247 testes aprovados, nenhuma falha, nenhum skip e nenhum TODO, incluindo manifesto e build em memória. Também passaram `npm run check` (conflitos, codificação, CSS e TypeScript), a compilação avulsa dos testes Worker e `git diff --check`. O oráculo, os testes diferenciais, o esquema, as dependências e os recursos Cloudflare permaneceram intactos nesta integração.

Nenhum teste simulado homologa SEFAZ, certificado, credenciamento, comunicação entre Workers ou validade tributária. Não houve publicação, implantação, chamada a governo, cofre real ou produção nesta integração. A infraestrutura da instalação, incluindo acesso entre Workers da mesma zona, permanece sujeita ao ensaio real, sem alteração de recursos nesta fatia.

## Roteiro de homologação real — não executado

1. Preparar área de ensaio e credencial restrita à homologação; conferir CNPJ, certificado, ambiente e séries diretamente no cofre.
2. Testar conexão pelo ERP; conferir versão, identidade e ambientes permitidos.
3. Configurar natureza, produto, cliente e pagamentos com o contador; conferir explicitamente omissão de IBS/CBS/IS.
4. Escolher **somente na autorização** para os dois efeitos; criar pedido sem postagens anteriores.
5. Preparar e comparar itens, CFOP, bases, alíquotas, valores e total com o esperado.
6. Emitir uma vez; anotar referência, identificador, chave, número/série, protocolo e ambiente.
7. Abrir DANFE/XML do cofre e conferir identificação de homologação e correspondência com a nota.
8. Conferir uma saída e um conjunto de parcelas; repetir comandos e atualizar a página sem mudança das quantidades.
9. Receber uma parcela pelo Financeiro e conferir saldo/razão.
10. Cancelar dentro do aceito pelo cofre, com justificativa real do ensaio; conferir evento e XML.
11. Conferir que recebimento não desapareceu e que pendências de compensação são explícitas.
12. Registrar evidências e divergências; interromper diante de resultado incerto e usar retomada, sem criar outra referência.
13. Encerrar o ensaio tratando os efeitos comerciais de teste. Não habilitar produção durante esse roteiro.
