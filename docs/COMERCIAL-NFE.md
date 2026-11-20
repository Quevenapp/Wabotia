# Venda com NF-e comercial

## Limites e arquitetura

Este percurso atende uma venda nacional integral de mercadorias, de um pedido salvo, modelo 55 e finalidade normal. O ERP prepara no servidor, congela a revisão, acompanha o cofre e concilia estoque e títulos. A NFapi guarda certificado e senha, numera, assina, transmite, arquiva e fornece DANFE/XML. Certificado e senha são configurados diretamente no cofre: não passam pelo painel do Wabotia.

O Worker orquestra chamadas entre transações síncronas do SQLite do `Coordinator` da área. Nenhuma transação aguarda a NFapi. A reivindicação durável precede o envio; o resultado fiscal é persistido antes dos efeitos. Estoque e financeiro têm transações e resultados independentes. Uma falha local nunca desfaz uma autorização.

O esquema ERP v10 acrescenta sete tabelas `erp_fiscal_vault__commercial_settings/order_emission/order_revision/order_command/order_cancel/order_effect/order_audit`. Não há migração D1, nova classe de Durable Object, novo recurso Cloudflare ou dependência. O backup do motor inclui essas tabelas. As revisões e a auditoria são imutáveis; corpo e XML restritos não entram no resumo de auditoria.

Não há projeção nas tabelas fiscais legadas, restritas à homologação. Os relatórios legados não passam a cobrir o histórico comercial novo. NFC-e/PDV, NFS-e/OS, nota avulsa, parcial, agrupada, importação/exportação, devolução fiscal, CC-e, inutilização e envio por canais ficam fora deste percurso.

O host instala a porta `commercialNfe` antes de renderizar as telas. Sua entrada fiscal usa o acompanhamento comercial e o acervo de saída somente para consulta. O componente portado continua disponível para hospedeiros sem essa porta; Compras conserva seu percurso, mas no host comercial não pode abrir uma saída legada por conversão, devolução ou URL direta. A exibição de documentos numéricos antigos no formulário portado preserva a compatibilidade anterior; ela não substitui a validação dos dígitos verificadores exigida pelo mapper antes de enviar uma NF-e ao cofre.

IBS/CBS/IS são omitidos integralmente. Operação que os exija é bloqueada, assim como tributação sem representação fiel no contrato. O cálculo não certifica legislação: o contador precisa validar a operação e a data concreta. Há limites na parametrização legada, incluindo CST do CRT 2 e `retained_base_rate` do ICMS normal; esta fatia preserva o motor/oráculo e bloqueia dados que não representem a tributação necessária.

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

Título recebido conserva título, baixa e razão: a compensação financeira fica pendente. Sem recebimento nem vínculo de cobrança impeditivo, a reversão financeira existente pode compensar os títulos. CNAB/cobrança vinculada e faturamento agrupado exigem resolução humana; não há chamada ao banco ou cancelamento de grupo por inferência.

Estoque exige confirmação humana de retorno físico e as validações normais de saldo/lote. Aumentar saldo por lançamento inverso não prova devolução. Sem retorno físico ou com reversão recusada, a compensação permanece pendente. Efeitos históricos podem ser mantidos com a parte local desligada pelo escopo estreito existente, sem ampliar papéis. Cancelar comercialmente o pedido não contorna o evento fiscal nem a confirmação física.

## Integração com Documents, Finance, Stock e fase 3

As alterações comerciais ficam nos pontos abaixo:

| Arquivo | Encaixe |
|---|---|
| `documents/rpc/erp_document_save.ts` | Guarda de conteúdo protegido e `deferredCom1Effect` no automatismo financeiro. |
| `documents/rpc/erp_document_transition.ts` | Guarda de transição/cancelamento e adiamento dos dois automatismos. |
| `documents/rpc/erp_module_apply.ts` | A projeção do módulo permanece gravada; os efeitos aguardam autorização fiscal, e cancelamento/transição respeitam emissão já enviada. |
| `fiscal/comnfe/source.ts` | O preparo e a recaptura recusam pedido vinculado a módulo, preservando a mesma leitura exclusiva da lista. |
| `documents/rpc/erp_document_small_writers.ts` | Protege observações usadas na nota e o vínculo fiscal na lixeira; observações internas operacionais continuam permitidas. |
| `stock/rpc/document-stock.ts` | `requireCom1Posting` antes de nova saída. |
| `stock/rpc/document-stock-read.ts` | A mesma guarda no caminho com depósito. |
| `finance/rpc/erp_document_finance.ts` | Guarda após replay e antes de criar posting/títulos. |
| `finance/rpc/erp_finance_grouped_billing.ts` | Guarda de cada pedido incluído no agrupamento. |

Os caminhos são relativos a `src/erp/domains/`. Os helpers ficam em `fiscal/comnfe/effect-policy.ts`: `deferredCom1Effect`, `requireCom1Posting`, `guardCom1CommercialSave`, `guardCom1Transition`. Ao juntar a fase 3, preserve essas guardas e a ordem replay → política → nova postagem; preserve também as exceções específicas no manifesto `web/erp/ORIGEM.json`. Não estenda automaticamente a política modelo 55 a OS/NFS-e. Serviços exigem mapper, vínculo, tributos, estados e políticas próprios. `POST /v1/nfse/{id}/conferir`, disponível no cliente 0.12.0, confere cancelamento externo de NFS-e; não é recuperação genérica de emissão.

Na junção candidata, pedidos de venda originados em módulos continuam somente para consulta no ERP e não oferecem **Preparar/Acompanhar NF-e**; o RPC também recusa o preparo. Se a automação do módulo e `on_authorization` estiverem ligadas, o pedido é projetado sem estoque/títulos, com motivo `awaiting_fiscal_authorization`, preservando o recibo e seu replay. Alterar a política não lança histórico automaticamente; o lançamento manual existente exige nova intenção e suas permissões. A emissão fiscal desses pedidos e a retomada dos efeitos depois dela são uma lacuna de produto a decidir. As duas guardas de faturamento agrupado permanecem juntas: origem de módulo e momento fiscal.

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
