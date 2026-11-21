# Receber dados do Bling

Esta função guarda o que foi observado na conta do Bling e oferece consulta
histórica. Ela pertence à Base do ERP, começa desligada e roda na instância
`erp:<área>` do `Coordinator`. Não requer outro Worker, fila, Durable Object ou
recurso Cloudflare. A tela fica em **Base → Sistema → Receber dados do Bling**,
rota `/receber-bling`.

Há três conceitos distintos:

| Estado do dado | O que significa nesta entrega |
|---|---|
| Bruto | Resposta recebida, identidade textual, precisão, referências e evidências preservadas. |
| Espelho histórico | Apresentação consultiva do bruto e de suas versões: **Consulta histórica — não opera no ERP**. |
| Adotado | Cadastro do ERP criado, ligado ou atualizado a partir do acervo, com revisão. Só cadastros nesta entrega (fatia B1, abaixo). |

Coletar não cria cadastros, pedidos, títulos, baixas, saldos, notas ou efeitos.
`erp_sync__settings.enabled` continua falso. A adoção dos cadastros é um passo
separado, pedido pela pessoa (seção "Adotar cadastros"); uma passagem concluída
não encerra a coleta nem constitui migração. Envio de alterações ao Bling e
aplicação automática do que muda lá só existem na **Mão dupla** (seção própria),
depois do corte, com interruptores por tipo de registro que começam
desligados.

## Adotar cadastros (fatia B1)

Aba **Adotar cadastros** da mesma tela. Transforma o que foi coletado em
cadastros do ERP, com revisão. Nada é escrito no Bling.

**Entidades, na ordem do lote:** categorias de produtos, contatos (clientes,
fornecedores e transportadoras), vendedores, produtos e serviços (com as
variações que vierem em `variacoes`), depósitos, formas de pagamento,
categorias financeiras e contas financeiras (`ledger_accounts`). Propostas,
pedidos e contas entram na fatia B2 (abaixo); notas, lançamentos de caixa e
saldos de estoque são usados no corte (fatia C, abaixo); ordens de serviço
ficam para uma próxima fatia.

**Três estados, por entidade:** *coletado* (no acervo, ainda não virou
cadastro), *adotado* (virou cadastro do ERP e fica ligado ao id do Bling, com
a versão e o hash coletados, em `wb_bling_adoption_link`) e *pendente de
revisão* (`wb_bling_adoption_review`, com o motivo em palavras e as duas
versões lado a lado). A pessoa decide cada pendência: **usar a do Bling**
(cria um cadastro novo ou, em contatos, produtos, categorias, depósitos e
categorias financeiras, atualiza o escolhido), **manter a do ERP e ligar** ou
**ignorar**.

**Sem duplicar.** Antes de criar, procura o que já existe: contato por
CPF/CNPJ (sem pontuação); sem documento, e-mail ou nome iguais viram só
sugestão para revisão, nunca ligam sozinhos. Produto por código (SKU) e depois
GTIN. Os demais por nome normalizado (vendedor pelo contato já adotado;
categoria financeira também pelo tipo). Achou um só e os dados batem (nome; no
produto também preço e unidade): liga. Diverge, mais de um, ou o cadastro já
está ligado a outro id do Bling: pendente. A chave (entidade, id no Bling) é
única; repetir o lote não cria outro cadastro.

**Mesmas regras das telas.** Criar e alterar usam as RPCs que as telas usam
(`erp_catalog_contact_save`, `erp_catalog_product_save`,
`erp_catalog_product_variation_add`, `erp_catalog_taxonomy_save`,
`erp_catalog_seller_from_contact`, `erp_stock_warehouse_save`,
`erp_catalog_payment_method_save`, `erp_finance_category_execute`,
`erp_finance_account_execute`) por `invokeRpc`: papel, validações, partes e
avisos são os mesmos. No lote, qualquer aviso (CPF/CNPJ inválido, código, GTIN
ou documento repetido) deixa o registro pendente; ao escolher "usar a do
Bling", a pessoa aceita o aviso, como na tela. Valores que o Bling não traz
recebem o padrão da tela: forma de pagamento "aplicável a ambos" com destino
em contas; conta financeira do tipo "outra", sem saldo inicial (o saldo fica
para a fatia de financeiro). Categoria de produto só é preenchida no produto
se a categoria já foi adotada.

**Partes.** Categorias e produtos exigem **Produtos e serviços**; depósitos,
**Estoque**; categorias financeiras e contas, **Financeiro**; os demais, a
Base. Com a parte desligada, a entidade aparece com o aviso de qual módulo
ligar e não pode ser marcada; se a parte cai durante o lote, ele pausa com o
motivo.

**Lote no alarme.** `erp_bling_adoption_start` grava o trabalho
(`wb_bling_adoption_job`) e já roda a primeira unidade; depois, uma unidade de
até 25 registros ou 1,5 s por acordada do alarme, só quando não há trabalho
operacional da área, antes da coleta. Cada registro é uma transação: a falha
de um vira pendência dele e o lote segue; perda de permissão ou parte
desligada pausam o lote com o motivo. Pausar e retomar continuam do último id.

**Desfazer.** "Desligar do Bling" remove só o vínculo; o cadastro do ERP fica
e o registro passa aos ignorados (o lote não religa sozinho; a pessoa pode
ligar de novo por ali). Não há exclusão em massa. Um vínculo de adoção também
impede apagar o acervo daquela entidade (referência impeditiva da prévia).

**Operações** (todas exigem administrador do ERP; caminhos sob
`/api/v1/profiles/{área}/erp/v1/receber-bling`; contrato em
`src/erp/bling/adoption-contracts.ts`):

| Nome | Método e caminho | Sensível |
|---|---|---|
| `erp_bling_adoption_status` | GET `/adotar` | não |
| `erp_bling_adoption_reviews` | GET `/adotar/pendencias` | sim (dados pessoais) |
| `erp_bling_adoption_links` | GET `/adotar/vinculos` | sim |
| `erp_bling_adoption_start` | POST `/adotar/iniciar` | sim |
| `erp_bling_adoption_pause` | POST `/adotar/pausar` | sim |
| `erp_bling_adoption_resolve` | POST `/adotar/pendencias/resolver` | sim |
| `erp_bling_adoption_unlink` | POST `/adotar/desligar` | sim |

Os comandos têm `command_id` com recibo (`wb_bling_adoption_command`):
repetir devolve o mesmo resultado; outro pedido com o mesmo id é recusado.
Bots usam os mesmos nomes pela concessão nominal em
`src/modules/erp/bot-access.ts`; nas sensíveis o bot só propõe e a operação
roda com a proposta confirmada pela própria pessoa (sem a liberação
autônoma da política do Bling). Testes: `tests/erp/org/adocao.test.mjs` e
`tests/erp/org/adocao-painel.test.mjs`.

## Documentos e contas em aberto; histórico (fatia B2)

Mesma aba **Adotar cadastros**, mesma tabela e mesmo lote da B1, com mais
cinco entidades depois dos cadastros: propostas comerciais, pedidos de venda,
pedidos de compra, contas a receber e contas a pagar. A tabela ganha a coluna
**No histórico (só consulta)** e, nas contas e documentos, os totais do que
ficou de fora e por quê. A nova aba **Histórico do Bling** lista o que já está
encerrado no Bling.

**Em aberto ou encerrado: um mapa só**, com teste, em
`src/erp/bling/adoption-situations.ts` (regras do sistema original anotadas
no arquivo):

| Entidade | Em aberto (vira documento ou título do ERP) | Encerrado (histórico) |
|---|---|---|
| Propostas | Rascunho, Em aberto, Pendente, Aguardando, Em andamento | Aprovado, Concluído, Faturado (atendido); Não aprovado, Cancelado |
| Pedidos de venda | Em aberto (id 6, valor 0), Em andamento (15, 3), Em digitação (21), Verificado (24) | Atendido (9, 1), Atendido/Faturado parcialmente, Faturado, Venda agenciada (18); Cancelado (12, 2) |
| Pedidos de compra | valor 0 Em aberto, 3 Em andamento | 1 Atendido, 2 Cancelado |
| Contas | situação 1 com saldo igual ao valor (inteira) | 2 paga, 3 e 6 parcial, 1 com saldo menor que o valor (parcial), 4 devolvida, 5 cancelada, 7 confirmada |

Situação fora do mapa não é adivinhada: vira pendência "situação
desconhecida". Registro excluído no Bling vai para o histórico como
"excluído".

**Adotar sem efeitos.** Em aberto vira documento ou título pelas RPCs das
telas, por `invokeRpc`: `erp_document_save` (propostas, pedidos de venda e de
compra), `erp_document_transition` só na proposta (Pendente, Aguardando e Em
aberto; a proposta não tem efeito de estoque nem de contas) e
`erp_finance_title_execute` (`title_create`). Pedidos de venda e de compra
entram sempre **Em aberto** no ERP, porque as outras situações do ERP disparam
lançamentos configurados de estoque e contas; a situação do Bling fica escrita
nas observações internas. Depois de criar, o motor confere que não há
lançamento de contas a partir do documento, lançamento ou reserva de estoque,
nem baixa da conta; se houver, desfaz e o registro vira pendência ("efeitos").
Pedido de compra com **Contas a pagar automáticas** ligada em Preferências →
Compras não é adotado (pendência dizendo o que desligar). Adotar não emite
nota, não cria movimento de caixa e não mexe em saldo de conta financeira.

**O que vai no documento.** Contato (ou fornecedor), itens com produto
adotado, quantidade, valor, desconto do item, código e código do fornecedor;
desconto, frete e outras despesas; data e data prevista; vendedor adotado;
parcelas com forma de pagamento adotada; observações; nas observações
internas, "Adotado do Bling: pedido de venda nº X (id Y), situação no Bling: Z"
e os avisos (vendedor ou forma de pagamento ainda não adotados, parcelas que
não fecham com o total calculado — saem e a pessoa refaz no ERP —, diferença
entre o total do Bling e o calculado pelo ERP). O número do Bling é usado se as
Preferências permitem editar o número e ele está livre. **Na conta:** contato,
categoria e forma de pagamento adotados, vencimento, emissão, competência,
valor, histórico como descrição, "número do documento (Bling id)" na
referência, portador e vendedor quando adotados.

**Falta um cadastro.** Contato ou produto do documento (e categoria ou forma
de pagamento da conta) sem vínculo de adoção: pendência "falta adotar"
dizendo qual (`wb_bling_adoption_doc_review.missing`), com o atalho **Adotar
agora** (`erp_bling_adoption_adopt_one`, que adota só aquele cadastro pelas
regras do lote) ou o caminho para as pendências daquele cadastro. Depois,
**Tentar adotar de novo** (resolver com `use_bling`). Vendedor e forma de
pagamento do documento não bloqueiam: ficam de fora com aviso.

**Possível duplicado.** Documento com mesmo número e contato, ou conta com
mesmo contato, vencimento e valor já no ERP: pendência com as duas versões;
**manter a do ERP e ligar** ou **adotar como novo mesmo assim**.

**Histórico (espelho).** Encerrados ficam só como índice em
`wb_bling_adoption_history` (número, contato, data, situação, motivo e total);
o documento como veio continua no acervo. Busca por número ou contato (sem
acento) e período, mais recentes primeiro; abrir mostra cabeçalho, itens,
parcelas e o registro recebido, com o aviso "Já encerrado no Bling (só
consulta). Este registro não pode ser faturado, cancelado nem editado no ERP".
Não há botão de operar. Apagar o acervo tira o registro do histórico.

**Partes.** Propostas e pedidos de venda exigem **Vendas** (e Produtos e
serviços); pedidos de compra, **Compras** (e Produtos e serviços); contas,
**Financeiro**. Desligada, a entidade mostra quais módulos ligar e as
operações dela (lote, resolver, adotar um, histórico) recusam com
`BLING_ADOPTION_PART_DISABLED`.

**Esquema versão 13** (12→13, só tabelas novas, porque o CHECK de entidade da
versão 12 não se reescreve): `wb_bling_adoption_doc_link`,
`wb_bling_adoption_doc_review` e `wb_bling_adoption_history`. O vínculo de
documento também impede apagar o acervo daquela entidade.

**Operações novas** (mesmas regras da B1; bots pela concessão nominal, com
parâmetros no inventário):

| Nome | Método e caminho | Sensível |
|---|---|---|
| `erp_bling_adoption_adopt_one` | POST `/adotar/um` | sim |
| `erp_bling_adoption_history` | GET `/adotar/historico` | sim (nomes de contatos) |
| `erp_bling_adoption_history_get` | GET `/adotar/historico/documento` | sim |

Testes: `tests/erp/org/adocao-b2.test.mjs`,
`tests/erp/org/adocao-situacoes.test.mjs` e
`tests/erp/org/adocao-b2-painel.test.mjs`.

## Passar a operar aqui: o corte (fatia C)

Aba **Passar a operar aqui** da mesma tela. A pessoa escolhe a **data de
corte**: a partir dela o ERP passa a valer. O que estava em aberto no Bling
nesse dia vira documento, conta, saldo ou estoque do ERP; o que já estava
encerrado fica no histórico. A conta do Bling continua viva e nada é escrito
nela. Mesmo mecanismo da B1 e da B2 (vínculo por entidade e id no Bling,
pendências, recibo de comando, RPCs das telas); código em
`src/erp/bling/cutover.ts`, `cutover-package.ts` e `cutover-contracts.ts`.

**1. Data de corte.** A tela mostra o que falta adotar (aguardando, pendentes e
ignorados por entidade) e uma conferência antes de confirmar: acervo
disponível, data escolhida e não futura, lote de adoção parado, o que ainda
aguarda a adoção e as pendências de revisão (as duas últimas só avisam; o que
ficar sem decisão aparece na conferência final). Confirmar exige
administrador e o aceite na tela. **Nada desta fatia roda sem a data
confirmada** (`BLING_ADOPTION_CONFLICT`, "Confirme primeiro a data de
corte..."). Enquanto nenhuma etapa gravou nada no ERP, outra data pode ser
confirmada; depois, não muda mais.

**2. Contas parciais, pagas e canceladas** (parte Financeiro). As contas que a
B2 deixou no histórico com baixa parcial (situação 3 e 6, ou 1 com saldo menor
que o valor) viram título do ERP pelo **saldo que falta**, por
`erp_finance_title_execute` (`title_create`), com vencimento, contato,
categoria e forma de pagamento adotados; a descrição anota o valor original,
o que já foi pago no Bling e o id de origem. As baixas antigas não são
recriadas. A conta sai do histórico e fica ligada (vínculo da B2); repetir não
duplica. Falta de cadastro ou saldo que não fecha vira pendência da conta, com
o motivo, e a etapa segue. As **pagas, canceladas, devolvidas e outras
encerradas** continuam no histórico e entram num resumo por mês (vencimento)
e por categoria, conferido com os mesmos totais contados direto do acervo
("bate" ou "não bate", com o porquê).

**3. Saldos de abertura** (parte Financeiro). Para cada conta financeira
adotada, o saldo na data de corte é calculado dos lançamentos de caixa
coletados (`cash_entries`: conta em `contaFinanceira`, `portador` ou `conta`;
sinal em `debitoCredito`/`tipo`; excluídos ficam de fora). Lançamento sem
valor ou sem entrada/saída deixa o cálculo em branco e pede o valor. A pessoa
**confirma ou corrige** e grava: entra **um** lançamento de caixa
(`erp_finance_cash_execute`, `entry_save`) com a diferença entre o saldo
confirmado e o saldo do ERP naquela data, nota "Saldo de abertura vindo do
Bling". Se a conta foi adotada depois da data de corte, o lançamento fica no
dia do saldo inicial da conta no ERP (o ERP não aceita movimento antes dele) e
a tela mostra a data usada. Gravar de novo com o mesmo valor não duplica; com
outro valor é recusado ("use Ajustar saldo no Financeiro"). Se a coleta mudou
o cálculo depois da conferência, recusa e pede para conferir de novo.

**4. Estoque de abertura** (partes Produtos e serviços e Estoque). A prévia
mostra, por depósito, o saldo físico observado no Bling (`stock_balances`;
saldo ausente não vira zero), os produtos sem cadastro adotado, serviços,
variações e composições (não entram), saldos negativos (só entram se as
Preferências de Estoque aceitam negativo), diferenças com o saldo que o ERP
já tem e o estoque valorizado pelo custo do produto no acervo (`precoCusto`)
quando houver. Gravar lança **um** ajuste por depósito na data de corte
(`erp_stock_post`, tipo ajuste, "Estoque de abertura vindo do Bling"), levando
o saldo do ERP ao do Bling; o ERP aceita até 100 produtos por lançamento, então
depósitos maiores saem em lançamentos de 100 (a tela continua sozinha). A
prévia tem um hash: mudou (nova coleta, cadastro adotado), recusa e pede
para conferir. Repetir não lança de novo. **Não recria movimentos antigos,
lotes nem reservas** (a tela diz isso). O lançamento coletivo do ERP não
guarda custo: o custo médio usado fica no registro do corte e na conferência
(estoque valorizado dos dois lados).

**5. Notas emitidas no Bling** (parte Fiscal). Nova tela **Fiscal → Notas
emitidas no Bling** (`/notas-bling`, administrador): NF-e e NFC-e do acervo
por período (emissão), número, chave de acesso ou destinatário; abrir mostra o
resumo e o XML guardado (conferido pelo hash no R2) com botão de baixar. Só
consulta: nunca vira emissão pelo cofre, não cancela nem corrige, e a tela diz
isso. Sem XML coletado, a tela diz para pedir a coleta de XML.

**6. Pacote do contador** (parte Fiscal). Por mês (até o mês da data de
corte), um ZIP sem compressão com os XML do mês e o índice
`indice-notas-AAAA-MM.csv` (planilha com ponto e vírgula: modelo, chave,
número, série, data, valor, situação e se o XML está no pacote). É montado no
alarme, depois da adoção: até 25 notas ou 4 MiB por acordada, cada parte
gravada no R2 (`erp/<área>/bling/contador/<mês>/<execução>/parte-NNNNN`) e
registrada; no fim grava o índice e o diretório do ZIP (`.../final`). O
download (`erp_bling_cutover_package_download`, administrador) junta as
partes na ordem sem montar o arquivo na memória. Pedir de novo refaz o pacote
e manda as partes antigas para a limpeza.

**7. Conferência final.** Por entidade: quantos no Bling, adotados, no
histórico, pendentes, ignorados e aguardando. Em dinheiro, Bling × ERP: a
receber e a pagar (em aberto pelo valor e parciais pelo saldo × contas
adotadas), saldos das contas financeiras e estoque valorizado. Cada diferença
vira um grupo explicado, com até 20 itens: pendências e o que aguarda a
adoção por entidade, parciais não adotadas, contas sem saldo gravado,
depósitos sem estoque gravado e produtos que ficaram de fora, mudanças no
Bling sem decisão e diferenças em dinheiro. Ignorados na adoção contam como
decididos. A pessoa justifica um grupo (ou item) com texto; fica registrado
com quem e quando. **Concluir** só passa sem diferença sem justificativa e
guarda a fotografia da conferência. Depois de concluído, as etapas que gravam
no ERP param ("ajustes daqui para a frente direto nas telas do ERP"); pacote
do contador e conflitos continuam.

**8. Depois do corte.** A coleta continua. Registro já adotado que mudou no
Bling (versão do acervo maior que a do vínculo) aparece em **Mudanças no Bling
depois do corte**, com as duas versões; o lote nunca sobrescreve. A pessoa
escolhe **manter o ERP** (marca a versão como vista) ou, nos cadastros que
aceitam atualização (contatos, produtos, categorias, depósitos e categorias
financeiras), **usar a versão nova do Bling** pela RPC da tela. Documentos e
contas só se mantêm (ajuste no ERP). Com **Receber do Bling** ligado na aba
Mão dupla, o que a coleta trouxer depois de ligar é aplicado sozinho (ou vira
conflito); o que veio antes continua nesta lista.

**Partes.** Data, conflitos e conferência exigem a Base; contas e saldos, o
Financeiro; estoque, Produtos e serviços e Estoque; notas e pacote, o Fiscal.
Desligada, a etapa mostra qual módulo ligar e a operação recusa com
`BLING_ADOPTION_PART_DISABLED`; a tela Fiscal some do menu com a parte.

**Esquema versão 15** (14→15, só tabelas novas): `wb_bling_cutover` (a data,
quem confirmou, a conclusão e a fotografia da conferência) e
`wb_bling_cutover_item` (o que cada etapa gravou: parcial, saldo, estoque por
depósito, pacote e partes, justificativa, conflito decidido).

**Operações** (todas exigem administrador; mesmas regras de recibo e de bots
da B1; sensíveis, menos a consulta do andamento):

| Nome | Método e caminho |
|---|---|
| `erp_bling_cutover_status` | GET `/corte` (não sensível) |
| `erp_bling_cutover_confirm` | POST `/corte/confirmar` |
| `erp_bling_cutover_accounts_summary` | GET `/corte/contas/resumo` |
| `erp_bling_cutover_partials` | GET `/corte/contas/parciais` |
| `erp_bling_cutover_partials_adopt` | POST `/corte/contas/parciais/adotar` |
| `erp_bling_cutover_balances` | GET `/corte/saldos` |
| `erp_bling_cutover_balance_post` | POST `/corte/saldos/gravar` |
| `erp_bling_cutover_stock` | GET `/corte/estoque` |
| `erp_bling_cutover_stock_post` | POST `/corte/estoque/gravar` |
| `erp_bling_cutover_invoices` | GET `/corte/notas` |
| `erp_bling_cutover_invoice_get` | GET `/corte/notas/nota` |
| `erp_bling_cutover_packages` | GET `/corte/contador` |
| `erp_bling_cutover_package_start` | POST `/corte/contador/gerar` |
| `erp_bling_cutover_package_download` | GET `/corte/contador/arquivo` (arquivo ZIP) |
| `erp_bling_cutover_report` | GET `/corte/conferencia` |
| `erp_bling_cutover_justify` | POST `/corte/conferencia/justificar` |
| `erp_bling_cutover_conclude` | POST `/corte/concluir` |
| `erp_bling_cutover_conflicts` | GET `/corte/conflitos` |
| `erp_bling_cutover_conflict_resolve` | POST `/corte/conflitos/resolver` |

As etapas que gravam muitos registros (parciais, estoque) trabalham em
pedaços pequenos por pedido (até 40 contas ou 1,5 s; até 100 produtos) e a
tela repete até terminar; cada registro é uma transação e repetir não
duplica. Testes: `tests/erp/org/corte.test.mjs` e
`tests/erp/org/corte-painel.test.mjs`.

**Limites conhecidos.** A lista de notas e o resumo das contas leem o acervo
direto (sem índice próprio): com centenas de milhares de registros a consulta
fica mais lenta. Os campos de lançamentos de caixa e de custo do produto foram
lidos pelo formato conhecido do sistema original e precisam ser conferidos
com uma conta real.

## Mão dupla: coleta contínua e escrita de volta (versão 19)

Aba **Mão dupla** da mesma tela. Depois do corte, a empresa mantém a conta do
Bling viva (marketplace e loja virtual) e os dois lados ficam iguais. Cada tipo
de registro tem **dois interruptores**, um por sentido, e **todos começam
desligados**: com eles desligados nada muda no ERP sozinho e nada é escrito no
Bling. Ligar exige administrador, o corte confirmado, a parte do ERP ligada e
o **aviso confirmado** na tela; ligar e desligar ficam registrados com quem e
quando (`wb_bling_twoway_audit`, imutável). Código em `src/erp/bling/two-way.ts`
(motor), `two-way-map.ts` (ERP → Bling e conferências), `writer.ts` (escrita
HTTP) e `two-way-contracts.ts`; tela em `web/erp/app/components/TwoWayBling.tsx`.

| Tipo de registro | Receber do Bling | Escrever no Bling | Partes |
|---|---|---|---|
| Contatos | atualiza o cadastro ligado; adota os novos | `POST /contatos`, `PUT /contatos/{id}` | Cadastros |
| Produtos | idem | `POST /produtos`, `PUT /produtos/{id}` (só produto simples novo) | Produtos e serviços |
| Propostas, pedidos de venda e de compra | `erp_document_save` no documento ligado; adota os novos | `POST`/`PUT` em `/propostas-comerciais`, `/pedidos/vendas`, `/pedidos/compras` | Vendas ou Compras, e Produtos |
| Contas a receber e a pagar (com baixas) | `title_update` e, o que foi pago no Bling, baixa na conta financeira do portador | `POST`/`PUT` em `/contas/receber` e `/contas/pagar`; baixa por `POST /contas/.../{id}/baixar` | Financeiro |
| Saldos de estoque | ajuste (`erp_stock_post`) para o saldo físico do Bling, por depósito ligado | balanço (`POST /estoques`, operação `B`) com o saldo do ERP | Produtos e Estoque |

**Nunca** nota fiscal nem ordem de serviço: não estão na lista de entidades (o
CHECK das tabelas também as recusa) e o cliente de escrita não tem caminho para
elas. Também não vão ao Bling: exclusões, cancelamentos, estorno de baixa (a API
do Bling não tem) e mudança de situação de documentos; viram pendência "faça
também no Bling". A exceção são os pedidos de venda que vieram do Bling: a
nota (chave, número e série, escritos no pedido), a situação e o rastreio têm
interruptores próprios, na seção "Volta ao Bling" abaixo. A NF-e em si
continua nunca sendo criada nem emitida no Bling.

**1. Coleta contínua (Receber do Bling).** A coleta já segue pela pista
"recente" com o filtro de data de alteração ou de emissão que cada recurso
oferece e 15 minutos de sobreposição. O **ritmo** entre as passagens é
configurável na aba (5 min a 24 h, padrão 15; `wb_bling_twoway.pace_minutes`,
lido pelo alarme da coleta) e segue o mesmo limite de chamadas por dia e o
intervalo mínimo da conta. A cada acordada, para os tipos com o interruptor
ligado, o que a coleta gravou depois da marca d'água (a hora de ligar) é
aplicado: registro já ligado recebe a versão nova pelas mesmas funções da
adoção (`applyBlingUpdate`, `applyB2Update`); registro novo é adotado pelas
regras do lote (`adoptCollected`), inclusive pendências. Registro que a própria
mão dupla criou no Bling é ligado ao mesmo cadastro, sem adotar de novo. O que
a coleta trouxe antes de ligar continua em "Mudanças no Bling depois do corte"
(fatia C). Limite: recursos que a API só filtra pela data de emissão (por
exemplo, propostas e pedidos de compra) só trazem mudanças de documentos dessa
janela recente.

**2. Escrever no Bling.** Uma varredura no alarme compara, registro a
registro, a **impressão** (hash) do que seria enviado com a da última
sincronização (`wb_bling_twoway_state`). Não há gatilho nas tabelas do ERP. Na
primeira vez, o ERP de agora vale como ponto de partida: ligar não reenvia o
que já está igual. Mudou, vira item da fila. Registros criados no ERP depois do
corte (sem vínculo) vão como criação. A atualização parte do último detalhe
lido do Bling e sobrepõe só os campos que o ERP mantém (regra do sistema
original: o PUT substitui o registro inteiro). Documento ou conta cujo contato
ou produto ainda não existe no Bling espera o envio dele (se a escrita desse
tipo estiver ligada) ou vira pendência dizendo o que falta.

**3. Fila de saída retomável** (`wb_bling_twoway_outbox`), no alarme do
`Coordinator`, sem classe nova nem fila da Cloudflare. Cada mudança tem **id
estável** (operação, entidade, registro e impressão; a baixa, o id da baixa).
Uma chamada HTTP por acordada, dentro do mesmo limite diário e intervalo mínimo
da coleta (contadores de `wb_bling_control`), com o token do cofre lido na
hora. Antes de enviar, o item é gravado como "enviando". Resultado:

- gravou → feito; a linha de base passa a ser a enviada e o eco que a coleta
  trouxer depois não vira conflito nem reenvio;
- recusa definitiva (400, 404, 409, 422 ou falta de permissão de escrita) →
  **pendência com o motivo em palavras**, incluindo o texto do Bling; não é
  repetida sozinha (Tentar de novo ou Deixar como está);
- limite de taxa (429) → espera o `Retry-After`;
- **incerto** (tempo esgotado, queda de conexão, erro 5xx ou redirecionamento
  depois do envio) → **nunca é repetido às cegas**: o próximo passo é um GET no
  Bling. Atualização: o registro lido já tem o que mandamos? Criação: a lista
  filtrada pela chave natural (CPF/CNPJ, código, número; na conta, contato e
  vencimento) tem exatamente um registro? Baixa: o saldo da conta é o de depois
  da baixa? Saldo: o saldo físico já é o do ERP? Entrou → feito; não entrou →
  volta para a fila e só então é reenviado; não dá para saber (sem chave,
  mais de um parecido, saldo que não bate nem antes nem depois, ou seis
  conferências sem resposta) → pendência para a pessoa dizer se entrou
  (informando o id, numa criação) ou mandar de novo.
- **queda do objeto** no meio do envio: o item que ficou "enviando" vira
  conferência na acordada seguinte, sem reenviar.

Desligar a escrita depois de enfileirar deixa o pendente parado (nada sai);
conferências já em curso, que só leem, continuam. Envio que ficou velho (o
registro mudou de novo no ERP) é substituído pela mudança mais nova.

**4. Conflito.** Quando o mesmo registro mudou nos dois lados desde a última
sincronização (impressão do ERP diferente da linha de base **e** versão do
Bling maior que a sincronizada), **nada é sobrescrito**: vira pendência com os
dois resumos lado a lado (`wb_bling_twoway_issue`, tipo conflito) e o envio da
fila, se houver, fica parado. A pessoa escolhe **Usar a do Bling** (aplica no
ERP pelas mesmas funções e descarta o envio) ou **Usar a do ERP** (vai para a
fila; com a escrita desligada, o ERP só fica como está). **Sem conflito, a
mudança mais recente vence**: só o Bling mudou → entra no ERP; só o ERP mudou →
vai ao Bling.

**5. Tela.** Aba Mão dupla: interruptores por tipo e sentido (com o motivo
quando a parte está desligada e o aviso ao ligar), ritmo da coleta, última
rodada em cada sentido com os totais, fila de saída com a situação e o motivo
de cada envio, pendências e conflitos com os dois lados e os botões, e quem
ligou ou desligou. Sem a data de corte, a aba diz para confirmá-la em Passar a
operar aqui. Os três estados do dado (bruto, espelho histórico, adotado)
continuam como na tabela do início.

**6. Bots** (grupo `bling`): `erp_bling_twoway_status` (GET `/mao-dupla`, não
sensível), `erp_bling_twoway_queue` (GET `/mao-dupla/fila`, sensível),
`erp_bling_twoway_issues` (GET `/mao-dupla/pendencias`, sensível) e
`erp_bling_twoway_resolve` (POST `/mao-dupla/pendencias/resolver`, sensível,
com proposta confirmada pela pessoa). **Ligar ou desligar**
(`erp_bling_twoway_switch`, POST `/mao-dupla/interruptor`) e o **ritmo**
(`erp_bling_twoway_pace`, POST `/mao-dupla/ritmo`) são só do administrador
pela tela: ficam fora do inventário dos bots e a chamada de um bot é recusada
(`BLING_ADOPTION_SCOPE_REQUIRED`).

**Esquema versão 19** (18→19, só tabelas novas; 17 e 18 são de outras
frentes): `wb_bling_twoway` (ritmo, cursor da varredura e últimas rodadas),
`wb_bling_twoway_setting` (interruptor por entidade e sentido, desde quando e a
marca d'água), `wb_bling_twoway_state` (linha de base), `wb_bling_twoway_outbox`
(fila), `wb_bling_twoway_issue` (pendências e conflitos) e
`wb_bling_twoway_audit`. Envio pendente impede apagar o acervo da entidade.
Nenhuma migração de D1.

**Testes:** `tests/erp/org/mao-dupla.test.mjs` (contra o Bling simulado com
escrita: zero escritas com os interruptores desligados, nenhuma repetição às
cegas, conflito vira pendência, retomada depois de queda, recusa com motivo,
criação conferida pela chave natural, baixa conferida pelo saldo, saldo de
estoque nos dois sentidos) e `tests/erp/org/mao-dupla-painel.test.mjs`.

**Antes de ligar com uma conta real.** Os caminhos e formatos de escrita vêm
do sistema original e da documentação conhecida da API v3; precisam de
conferência oficial (corpos, filtros de lista usados na conferência —
`numeroDocumento`, `codigos[]`, `numero`, `idContato` com `tipoFiltroData=V` —,
códigos de resposta e se o PUT devolve corpo). O aplicativo do Bling precisa
dos escopos de **escrita** dos tipos ligados; sem eles a recusa aparece como
pendência ("sem permissão para gravar"). A situação de pedidos e propostas
não é enviada nesta entrega; forma de pagamento, categoria e portador só vão
quando estão ligados ao Bling pela adoção.

## Volta ao Bling: nota, situação e rastreio; aviso do Bling (versão 32)

Para quem vende no marketplace pelo Bling: o pedido nasce no Bling, é atendido
aqui, e o marketplace precisa da nota e do rastreio. Na aba **Mão dupla**,
seção **Volta ao Bling**, três interruptores próprios, todos **desligados**,
só do administrador (ligar pede o aviso confirmado e fica no registro de quem
ligou; `erp_bling_twoway_return_switch`, fora do inventário dos bots). Só
valem depois do corte e só para pedidos de venda ligados a um pedido do Bling
(vínculo da adoção ou criado pela mão dupla). Código em
`src/erp/bling/returns.ts`.

| Interruptor | O que vai ao Bling | Como | Depende de |
|---|---|---|---|
| Nota de volta | Chave de acesso, número e série da NF-e autorizada aqui (cofre fiscal do pedido, só leitura) | Lê o pedido (`GET /pedidos/vendas/{id}`) e grava o mesmo pedido com a linha "NF-e emitida no ERP: nº …, série …, chave …" acrescentada às observações internas (`PUT /pedidos/vendas/{id}`) | Vendas, Produtos e Fiscal |
| Situação e rastreio de volta | A etapa do pedido aqui vira a situação escolhida para ela; o código de rastreio da Expedição | Situação: `PATCH /pedidos/vendas/{id}/situacoes/{idSituacao}`, sem corpo. Rastreio: lê o pedido e grava com o código no primeiro volume sem rastreio (`transporte.volumes[].codigoRastreamento`) e uma linha nas observações internas | Vendas e Produtos |
| Aviso do Bling (webhook) | Nada vai ao Bling: o aviso do Bling adianta a coleta | Ver abaixo | Base |

**Limite da nota.** A API v3 não tem caminho para receber uma NF-e emitida fora
do Bling (o `POST /nfe` cria uma nota para o próprio Bling emitir). Por isso a
nota vai **escrita no pedido**, não como nota do Bling; marketplace que só lê a
nota emitida pelo Bling pode precisar dela informada à mão lá. O XML não vai.
A tela diz esse limite ao lado do interruptor.

**Etapas e situações.** A etapa do pedido sai do que já existe aqui, só leitura:
cancelado (documento cancelado) > entregue (Expedição com entrega registrada) >
enviado (Expedição enviada) > faturado (NF-e autorizada) > separado (Expedição
separada ou embalada). No Bling cada situação tem um número (Preferências →
Situações; as padrão são 6 Em aberto, 9 Atendido, 12 Cancelado, 15 Em
andamento). O dono escolhe o número para cada etapa; etapa sem número não muda
a situação no Bling (o rastreio vai mesmo assim). A tela avisa que, em algumas
contas, Atendido ou Cancelado lançam ou estornam estoque e contas lá.

**Fila.** Os envios usam as regras da fila de saída da mão dupla, numa tabela
própria (`wb_bling_return_outbox`) que aparece na mesma Fila de saída como
pedido de venda ("Nota no pedido do Bling", "Situação no Bling", "Rastreio no
Bling"):

- **Id estável**: tipo, pedido e impressão do que vai. A mesma nota, etapa ou
  rastreio nunca entra duas vezes; mudou (outra etapa, outro código), o pendente
  anterior é substituído.
- **Só o que acontece depois de ligar**: nota autorizada, mudança de etapa ou
  rastreio gravado depois do interruptor ligado.
- **Uma chamada por acordada**, no mesmo limite de chamadas da conta.
- **Conferência antes de reenviar**: nota e rastreio sempre leem o pedido no
  Bling antes de gravar e não gravam o que já está lá; resposta incerta (tempo
  esgotado, queda, erro do servidor) vira "Conferindo no Bling" e o próximo
  passo é um `GET`; entrou, fica gravado; não entrou, volta a ler e gravar.
- **Pendência com motivo**: recusa do Bling (com o motivo dito por ele), falta
  de permissão (403) ou pedido excluído lá viram pendência em Pendências e
  conflitos (chave `ret:`), com Tentar de novo ou Deixar como está; incerto
  sem resposta depois de várias conferências pede "Entrou no Bling" ou "Não
  entrou: enviar de novo".
- **Janela curta**: entre a leitura e a gravação de nota e rastreio passa uma
  acordada (cerca de um segundo); uma edição feita no Bling exatamente nesse
  intervalo seria sobrescrita pelo pedido lido.

**Aviso do Bling (webhook).** O Bling avisa quando um pedido de venda
(`order.*`), produto (`product.*`), estoque (`stock.*`), NF-e (`invoice.*`) ou
NFC-e (`consumer_invoice.*`) muda. O endereço a cadastrar no aplicativo do
Bling, em Webhooks, aparece na tela:
`https://<endereço-público>/api/public/erp-bling/<área>/webhook`. Funcionamento
(`src/erp/bling/webhook.ts`):

1. O Worker confere a assinatura `X-Bling-Signature-256: sha256=<HMAC-SHA256
   do corpo com o segredo do aplicativo da área>` (segredo lido do cofre). Sem
   assinatura certa, 401 e nada é guardado.
2. Guarda só o essencial no D1 (`erp_bling_webhook_event`, migração 0280: área,
   id do evento, entidade, ação, id do registro, empresa, horário); o mesmo
   aviso repetido não duplica. Recurso que a coleta não usa é aceito e
   ignorado. Depois acorda o objeto da área.
3. Na acordada, com o interruptor ligado, o objeto confere a empresa do aviso
   contra a empresa vinculada pela prova de conta (aviso de outra empresa é
   ignorado) e marca a entidade como avisada (`wb_bling_webhook_hint`).
4. A coleta daquela entidade roda já, em vez de esperar o ritmo. Nenhum dado
   do aviso entra direto no ERP: o que mudou vem pela coleta, com as mesmas
   conferências.
5. **Reserva**: a consulta periódica continua. Para a entidade que já recebeu
   aviso, o intervalo entre as passagens vira de pelo menos 2 horas
   (`BLING_WEBHOOK_RESERVE_MS`); para as outras, o ritmo de sempre.

**Permissões.** A seção lista o que marcar no aplicativo do Bling conforme os
interruptores: leitura dos recursos escolhidos e "Empresa (dados básicos)";
escrita de pedidos de venda quando a nota ou a situação e rastreio estão
ligados; escrita do que estiver com "Escrever no Bling" ligado.

**Bots.** A consulta da mão dupla (`erp_bling_twoway_status`, leitura) traz a
volta ao Bling em `returns`; a fila e as pendências também a mostram. Ligar,
desligar e escolher as situações são só do administrador, pela tela.

**Esquema.** Versão 32, só adição: `wb_bling_return_setting` (interruptores e
o mapa de situações), `wb_bling_return_outbox` (a fila da volta) e
`wb_bling_webhook_hint` (entidades avisadas). As pendências usam
`wb_bling_twoway_issue`. Apagar o acervo de pedidos de venda espera a fila da
volta (envio ainda não confirmado conta como referência).

## Outros dados do Bling (fatia D, versão 24)

Aba **Outros dados** da mesma tela. Traz o que o coletor não lia e que agora
tem destino no Wabotia: listas de preços, naturezas de operação, campos
customizados (definições e valores), fornecedores e lotes de produto,
contratos e notas de serviço (NFS-e). Código em `src/erp/bling/extras.ts`
(adoção), `extras-two-way.ts` (mão dupla), `extras-worker.ts` (contrato, no
Worker) e `extras-contracts.ts`; tela em
`web/erp/app/components/ExtrasBling.tsx`. Situações (e módulos e transições)
continuam fora: não há destino no ERP nem lista sem o id do módulo.

**1. Coleta, pelo mesmo coletor.** Cada recurso é uma seleção da
Configuração (o interruptor), desligada por padrão. No catálogo
(`resources.ts`) os sete continuam `nao_confirmado` e sem caminho; ao lado fica
o **acesso proposto**, lido da documentação pública da API v3 e ainda não
conferido numa conta real (`BLING_EXTRA_PROPOSED_ACCESS`, com a dúvida de
cada um, também mostrada na aba). O recurso só vira coletável quando o dono
registra a evidência completa da conferência (`confirmBlingExtraResource`);
sem ela nenhuma chamada sai. Coletado, segue as regras de sempre: uma unidade
e um GET por acordada, retomável, limite diário e intervalo mínimo, recibos,
acervo bruto em `wb_bling_extra_raw` (versão 11) com versões. O cliente de
dados confere o caminho contra o proposto do catálogo, nunca contra o que
chega. Naturezas de operação usam a lista inteira, sem GET de detalhe
(`detail: null`, modo novo do coletor: a página é o registro, conferida contra
o corrente no commit).

| Recurso | Caminho proposto | Destino |
|---|---|---|
| Listas de preços | `/listas-precos`, `/listas-precos/{id}` | listas de preços do ERP (lista personalizada, preço por produto) |
| Naturezas de operação | `/naturezas-operacoes` (só lista) | naturezas do Fiscal, ativas, sem trocar a padrão |
| Campos customizados | `/campos-customizados`, `/campos-customizados/{id}` | campos próprios de produto ou de contato (versão 20) |
| Valores dos campos | `camposCustomizados` dentro de produtos e contatos já coletados | valores no produto e no contato adotados |
| Fornecedores de produto | `/produtos/fornecedores`, `/produtos/fornecedores/{id}` | fornecedor do produto (o mesmo vínculo da compra pela nota) |
| Lotes de produto | `/produtos/lotes`, `/produtos/lotes/{id}` | lotes do estoque, com saldo e validade na data de corte |
| Contratos | `/contratos`, `/contratos/{id}` | contrato de manutenção da Ordem de Serviço |
| NFS-e | `/nfse`, `/nfse/{id}` | só consulta |

**2. Adoção com revisão.** Mesmo mecanismo da B1: **prévia** (o que vai
acontecer com cada registro — criar, ligar ao que já existe ou ficar
pendente com o motivo —, com o Bling e o ERP lado a lado, sem gravar nada),
**três estados** (coletado, adotado em `wb_bling_adoption_extra_link`,
pendente em `wb_bling_adoption_extra_review`), **sem duplicar** (a chave
entidade + id no Bling é única; procura por nome normalizado, por produto e
fornecedor, por produto e código do lote) e só pelas funções de domínio, por
`invokeRpc`: `erp_pricing_list_save` e `erp_pricing_list_items`,
`erp_fiscal_nature_execute` (só `create`; `set_default` nunca é chamada),
`erp_catalog_custom_field_save` e `erp_catalog_product_save`
(`custom_values`), `erp_catalog_contact_field_save` e
`erp_catalog_contact_field_values_save` (versão 20), `erp_catalog_product_save`
(`suppliers`, a lista inteira conservada), `erp_stock_lot_launch` (tipo
`balance`) e `erp_stock_lot_import`. "Adotar os conferidos nesta prévia" leva
só os ids que a pessoa viu; "Adotar o próximo pedaço" leva até 25 ou 1,5 s;
cada registro é uma transação e a falha de um vira pendência dele. Repetir o
mesmo pedido devolve o mesmo resultado (recibo em `wb_bling_adoption_command`).

**Formato não conferido não é adivinhado.** O mapeador lê só os campos do
formato público; o que faltar vira pendência "formato não conferido" com o
que faltou: lista sem `produtos`/`itens` com `produto.id` e `preco`; campo sem
módulo (produto ou contato), com tipo desconhecido ou lista sem opções;
natureza sem tipo (entrada/saída) ou sem regime (CRT); fornecedor ou lote sem
produto; valor sem `idCampoCustomizado`. Dependência que falta (produto,
contato, depósito ou campo ainda não adotado) também vira pendência, com o
id do Bling. Decisões que a tarefa não dizia: campo de contato vale para os
quatro tipos de contato (o Bling não separa); tipos inteiro/decimal viram
número e texto longo vira texto no contato; lista de preços entra como
**personalizada** (a única com preço por produto) e sem período.

**Lotes.** Exigem a data de corte confirmada, o produto adotado com
controle de lotes ligado e, com saldo, o depósito adotado. Entram com o saldo
do Bling (lançamento de balanço do lote) e a validade. Se o estoque de
abertura daquele depósito já foi gravado no corte, o lote entra **sem saldo**
(senão somaria de novo) e a tela avisa.

**Fornecedores.** O cadastro do produto só guarda fornecedores com Compras
e Estoque ligados; por isso a entidade pede Produtos e serviços, Compras e
Estoque.

**3. Contratos.** A aba lista os contratos como vieram (cliente, vigência,
valor, periodicidade, situação) e o que falta conferir. "Conferir e preparar"
abre o rascunho com os planos da Mensalidade e os clientes do atendimento
com o mesmo telefone ou nome; a pessoa escolhe o plano (o valor e a
periodicidade da cobrança são os do plano), o cliente, as visitas por
período e o período. Criar roda **no Worker**
(`erp_bling_extras_contract_create`): confere de novo a versão do contrato,
os módulos **Ordem de Serviço** e **Mensalidade** (desligados, diz qual
ligar), e chama o comando do próprio módulo, `os.contract.create`, no
Coordinator da área (como o ERP pela conversa faz), sem mudar as regras
dele, com `create_subscription: false`: **a cobrança recorrente nasce
desligada** e a pessoa liga na tela do contrato. As condições do contrato
anotam "Vindo do Bling: contrato nº X (id Y)" e o valor do Bling. O vínculo
volta ao ERP (`erp_bling_extras_contract_link`, também usado para ligar a um
contrato de manutenção que já existe). Sem o módulo, o contrato fica no
acervo com o aviso. Criar e ligar são só do administrador, pela tela.

**4. NFS-e.** Só consulta, como as NF-e antigas: lista por número, tomador e
período, lida direto do acervo, com o aviso de que não vira emissão, não
cancela nem corrige. Pede a parte Fiscal.

**5. Mão dupla das listas e dos campos.** Interruptores próprios
(`wb_bling_adoption_extra_twoway`) para listas de preços, campos de produto e
campos de contato, um por sentido, **todos desligados**; ligar exige
administrador, o corte confirmado, a parte ligada e o aviso confirmado, e
fica registrado (`wb_bling_adoption_extra_audit`, imutável). **Receber do
Bling**: o que a coleta trouxe depois de ligar entra pelas mesmas funções da
adoção (atualiza o ligado, adota o novo); se o ERP também mudou desde a
última sincronização (impressão diferente), vira pendência "conflito" e a
pessoa escolhe. **Escrever no Bling**: na primeira varredura o ERP de agora é
o ponto de partida; depois, o que mudar no ERP num registro ligado vai para
a fila (`wb_bling_adoption_extra_outbox`) como `PUT` no registro do Bling,
partindo do último detalhe lido; uma chamada por acordada, com a mesma
reserva da coleta (intervalo mínimo e teto diário); resposta incerta **nunca
é repetida sozinha** (a pessoa diz se entrou ou manda de novo); recusa vira
"recusado" com o motivo. Só atualiza o que veio do Bling; não cria lista nem
campo novo no Bling. Valores de campo não são escritos de volta nesta
entrega. **Naturezas, NFS-e e contratos nunca voltam ao Bling** (o simulador
recusa qualquer escrita nesses caminhos).

**6. Bots** (grupo `bling`, pela concessão nominal): consultar
(`erp_bling_extras_status`) é leitura; a prévia, as pendências, os contratos,
as NFS-e e a fila trazem nomes e são sensíveis; adotar, resolver, desligar e
resolver envio são sensíveis (o bot propõe e a pessoa confirma). Criar o
contrato de manutenção, ligar a um contrato e os interruptores da mão dupla
ficam fora do inventário (só a pessoa, pela tela).

| Nome | Método e caminho (sob `/receber-bling`) |
|---|---|
| `erp_bling_extras_status` | GET `/outros` (não sensível) |
| `erp_bling_extras_preview` | GET `/outros/previa` |
| `erp_bling_extras_reviews` | GET `/outros/pendencias` |
| `erp_bling_extras_adopt` | POST `/outros/adotar` |
| `erp_bling_extras_resolve` | POST `/outros/pendencias/resolver` |
| `erp_bling_extras_unlink` | POST `/outros/desligar` |
| `erp_bling_extras_invoices` | GET `/outros/nfse` |
| `erp_bling_extras_contracts` | GET `/outros/contratos` |
| `erp_bling_extras_contract_options` | GET `/outros/contratos/opcoes` (Worker) |
| `erp_bling_extras_outbox` | GET `/outros/mao-dupla/fila` |
| `erp_bling_extras_outbox_resolve` | POST `/outros/mao-dupla/fila/resolver` |
| `erp_bling_extras_contract_create` | POST `/outros/contratos/criar` (Worker, só a pessoa) |
| `erp_bling_extras_contract_link` | POST `/outros/contratos/vincular` (só a pessoa) |
| `erp_bling_extras_switch` | POST `/outros/mao-dupla/interruptor` (só a pessoa) |

**Partes.** Listas de preços pedem Produtos e serviços; naturezas e NFS-e,
Fiscal; lotes, Produtos e serviços e Estoque; fornecedores, Produtos e
serviços, Compras e Estoque; campos e valores, a Base (campo de produto
também Produtos e serviços, conferido por registro). Desligada, a entidade
mostra qual módulo ligar e a operação recusa com
`BLING_ADOPTION_PART_DISABLED`.

**Esquema versão 24** (23→24, só tabelas novas; 22 e 23 são de outras
frentes): `wb_bling_adoption_extra_link`, `wb_bling_adoption_extra_review`,
`wb_bling_adoption_extra_twoway`, `wb_bling_adoption_extra_outbox` e
`wb_bling_adoption_extra_audit`. Vínculo e envio pendente impedem apagar o
acervo da entidade. Nenhuma migração de D1.

**Testes:** `tests/erp/org/fatia-d.test.mjs`, contra o Bling simulado
ampliado (`blingExtrasSample` e os caminhos propostos em `fake-bling.mjs`;
escrita em `/listas-precos` e `/campos-customizados`; qualquer escrita em
NFS-e, contratos ou naturezas falha o teste).

**Antes de ligar com uma conta real.** Conferir, para cada recurso, o
caminho, a paginação, se há detalhe por id, os nomes dos campos usados pelos
mapeadores (listados acima e nas dúvidas da aba), os escopos de leitura e,
para a mão dupla, o corpo e o código de resposta do `PUT`. Até lá os
recursos ficam `nao_confirmado`, e o que vier diferente vira pendência, nunca
cadastro adivinhado.

## Antes de usar uma conta real

O aceite automatizado usa exclusivamente dados e OAuth simulados. Ele não
confirma a documentação atual do Bling, seus limites, o aplicativo do dono,
os escopos contratados, a identidade da empresa ou a disponibilidade de XML.
Nenhum teste exige credencial ou conta real.

A coleta real só aceita recursos `oficial_confirmado` com evidência da
conferência. O catálogo base (`BLING_RESOURCES`, dos testes e do simulador)
marca os recursos originais como `original_conferido`; a montagem de produção
usa o **catálogo oficial** `BLING_CONFIRMED_RESOURCES` (versão 32), em que os
17 recursos descritos pela documentação pública da API v3 passam a
`oficial_confirmado`, cada um com o endereço da referência
(`https://developer.bling.com.br/referencia#/<grupo>/get_<caminho>`), a data
da conferência e os limites conferidos (3 chamadas por segundo e 120 mil por
dia por conta; o intervalo local de 700 ms e o teto local de 20 mil por dia
ficam abaixo). Ficam fora, com o motivo dito na tela de Configuração
(`BLING_UNCONFIRMED_REASONS`, que vai em `limitations` como "chave: motivo"):

| Recurso | Por que ficou fora |
|---|---|
| Ordens de serviço (`service_orders`) | A rota do sistema de origem (`/ordens/servico`) não aparece na documentação pública. |
| XML das notas (`fiscal_xml`) | `/nfe/documento/{chave}` não tem referência pública; número, chave e situação da nota entram pela coleta de NF-e e NFC-e. |
| Outros dados da fatia D | Acesso só proposto; liga quando o dono confere numa coleta real (seção "Outros dados do Bling"). |
| Demais entidades extras | Sem destino no ERP e sem referência conferida. |

O painel não aceita endpoints arbitrários nem promove a confirmação por um
simples clique.

**Prova de conta** (`src/erp/bling/account.ts`). Depois da troca do código
OAuth, um `GET /empresas/me/dados-basicos` (API v3, só leitura) com o token
recém-recebido devolve o id e o nome da empresa. O id é o vínculo gravado no
controle; toda autorização ou renovação seguinte precisa devolver a mesma
empresa (`BLING_ACCOUNT_MISMATCH`). A chamada é única, com prazo, sem
redirecionamento; o token nunca vai a log, erro ou banco.

**Escopos.** No Bling as permissões são marcadas no cadastro do aplicativo,
não no endereço de autorização (que não leva `scope`). O token devolve os
escopos concedidos como identificadores opacos; a montagem aceita esse formato
(`isBlingGrantedScope`) e grava a lista para consulta. A aba Mão dupla → Volta
ao Bling mostra o que marcar no aplicativo conforme os interruptores ligados
(`blingScopeChecklist`): leitura para o que vai receber, mais "Empresa (dados
básicos)" para a prova de conta; escrita só para o que volta ao Bling. Falta
de permissão volta como 403 e vira recusa "falta permissão".

**Renovação.** O token do Bling dura poucas horas. A coleta renova sozinha dez
minutos antes de vencer (`BLING_RENEW_MARGIN_MS` em `wake.ts`), pela mesma
reserva exclusiva com comparação de revisão; recusa 401 também leva à
renovação. Sem a coleta ligada, a escrita de volta espera a próxima renovação
e diz "A conta do Bling precisa ser autorizada de novo" se não houver.

O aceite automatizado continua usando só dados e OAuth simulados: ele não
prova a documentação vigente nem o aplicativo do dono. A primeira coleta real
é do dono, pelo roteiro abaixo.

O procedimento exclusivo do dono está em
[Primeira coleta](RECEBER-BLING-PRIMEIRA-COLETA.md).

## Aplicativo, retorno e configuração

1. O dono registra seu próprio aplicativo no Bling, seguindo a referência
   oficial que conferiu. Não usar aplicativo de terceiro nem credenciais de
   demonstração.
2. Um administrador abre Configuração, informa identificador e segredo do
   aplicativo e salva. A resposta mostra somente a presença da configuração,
   sua revisão e o retorno público; nunca mostra novamente o segredo.
3. Copia o retorno exato apresentado, derivado do endereço canônico confiável
   da instalação: `https://<endereço-público>/api/public/erp-bling/<área>/callback`.
   Registra esse mesmo HTTPS no aplicativo. Não usar URL de desenvolvimento,
   `Host` recebido de terceiros ou redirecionamento improvisado.
4. Marca no aplicativo do Bling as permissões de leitura dos recursos
   selecionados e "Empresa (dados básicos)". Escrita só quando for ligar a mão
   dupla ou a volta ao Bling (a lista está na aba Mão dupla); depois de mudar
   as permissões, autoriza de novo.
5. Define seleção, período, quota e permissões; revisa a lista de conferência
   de dez itens; aciona **Ligar recebimento** e depois **Autorizar conta**.
6. Conclui a autorização no mesmo navegador e sessão administrativa. O
   retorno valida estado de uso único, cookie protegido, sessão, área,
   revisões e validade de até dez minutos. Confere a empresa vinculada antes
   de pedir a primeira passagem.

Uma área vincula uma única conta. Reautorizar a mesma conta conserva acervo e
checkpoints; uma conta diferente é recusada. Para outra empresa, não tentar
trocar manualmente IDs no SQLite ou no cofre.

A API de dados usa apenas GET. A troca e a renovação OAuth usam POST
protocolar, separados do transporte de dados; isso não escreve entidades no
Bling. A renovação é exclusiva e usa comparação de revisão. Se o provedor
puder ter rotacionado o refresh token e a resposta se perder antes da custódia,
a autorização fica incerta e exige nova autorização.

## Cobertura e limites de interpretação

As 18 entidades originais têm coleta declarada; a seleção efetiva continua
dependendo da confirmação oficial e dos escopos da conta:

| Recursos | Semântica temporal local a conferir oficialmente |
|---|---|
| Contatos, produtos, pedidos de venda e vendedores | Alteração com hora; variantes excluídas podem não ter filtro temporal. |
| Propostas, pedidos de compra e ordens de serviço | Intervalo de datas. |
| Contas a receber e a pagar | Emissão; revisitas de títulos conhecidos abertos/parciais complementam a varredura. |
| NF-e e NFC-e | Emissão com hora, variantes por direção/situação; identidades separadas. |
| Formas de pagamento, depósitos, categorias de produtos e financeiras, contas contábeis | Sem filtro temporal. |
| Caixas | Intervalo de datas e variantes de registrados/excluídos; recortes persistidos da página recebida. |
| Saldos de estoque | Produtos conhecidos, até 25 IDs por grupo e três partições; cobertura incompleta. |

Janelas usam São Paulo e sobreposição de quinze minutos quando aplicável.
“A partir de” não limita recursos sem filtro temporal. Página curta não
comprova fim nos recursos de página de origem. Ausência em lista ou 404 de
detalhe não prova exclusão. Saldo ausente ou desconhecido não vira zero.
Estoque observado não é movimento, reserva, lote nem saldo de abertura.

Contratos, produção, listas de preços, naturezas, campos customizados,
borderôs, NFS-e, estruturas/fornecedores/lotes/movimentos/variações de produtos,
grupos, tipos de contato, situações/módulos/transições, logística e seus
subrecursos, empresas e usuários são lacunas visíveis enquanto os contratos
de acesso e identidade estiverem `nao_confirmado`. Depois de confirmados,
seu destino inicial é bruto sem interpretação operacional presumida.
Marketplace, anúncios, lojas virtuais e canais de venda ficam fora.

URLs de imagens e anexos permanecem referências no bruto; seus bytes não são
arquivados. Uma definição fiscal preservada não transporta regras fiscais,
e NFS-e bruta não implementa emissão ou escrituração.

## Histórico fiscal e XML

**XML de NF-e/NFC-e** é uma seleção própria (`fiscal_xml`). Selecionar NF-e
ou NFC-e coleta as fontes fiscais; para obter os arquivos, selecionar também
XML e conferir sua referência oficial. Pode-se pedir apenas XML quando as
fontes já existem no acervo. Sem fonte fiscal com chave/modelo comprovados,
não há arquivo a buscar.

XML de NF-e/NFC-e é privado por área no binding `MEDIA`, com chave derivada
do SHA-256. Reserva, obtenção, gravação, verificação e manifesto são etapas
duráveis. Arquivo gravado sem manifesto é reconciliado ou removido; o download
autenticado usa referência opaca e verifica o conteúdo.

O parser recusa estruturas proibidas, incluindo DTD/ENTITY, verifica limites,
identidade fiscal e presença estrutural de assinatura/protocolo. Isso não
certifica assinatura criptográfica, autorização fiscal ou escrituração.
Conservar as lacunas de XML indisponível, eventos ausentes e diferenças entre
produção e homologação. O contador deve conferir amostras e a cobertura do
pacote fiscal, inclusive a distinção entre recebido do Bling e XML nativo.

## Duração, espaço e retomada

Há no máximo uma unidade e um GET de dados por acordada elegível. O trabalho
operacional e os arquivos vencidos do ERP têm prioridade. A unidade externa
tem até quatro segundos, HTTP até três segundos, respeitando o próximo
vencimento operacional. Não há espera ativa ou repetição escondida: 429,
`Retry-After`, quota, falhas temporárias e timeout persistem a próxima tentativa.
403 de escopo bloqueia o recurso; 401 solicita renovação exclusiva.

A proteção inicial é de até **20 mil chamadas de dados por dia por conta**,
ajustável para baixo, e intervalo mínimo de **700 ms**. São limites locais,
não uma atribuição de quota oficial ao Bling. Aumento depende de conferência
oficial e nova projeção. Detalhes, revisitas, variantes e XML aumentam o número
de chamadas; uma lista de dez registros costuma exigir a lista mais seus
detalhes. A coleta pode durar dias e pode não caber inteira.

Progresso e cobertura apresenta as chamadas de dados no dia registrado e,
por pista, revisão do checkpoint, observados/alterados, início e conclusão
da passagem, próxima tentativa e frescor comprovado. Pista sem contador ou
passagem suficiente continua identificada como desconhecida. O frescor
agregado usa o início mais antigo das últimas passagens necessárias
concluídas; o horário do último GET não substitui essa evidência.
XML é acompanhado pelos manifestos confirmados no Histórico fiscal;
seus contadores por pista continuam desconhecidos e não reutilizam os
contadores de coleta de NF-e/NFC-e.

O teto conservador do SQLite é **10.000.000.000 bytes**: aviso em 70% e
parada em 80%, ou antes de a próxima transação ultrapassar 80%. Medem-se os
bytes reais da instância; o acervo tem estimativa própria, e os XML em R2
são separados. Versões antigas, índices, recibos e metadados também ocupam
espaço. Não há descarte automático de versões. Crescimento diário, médias
por entidade e projeção com intervalo de incerteza ainda são desconhecidos;
dependem da medição de amostras comparáveis, descrita no roteiro do dono.

O recibo torna o replay idempotente: repetir uma unidade confirmada não
duplica versão ou checkpoint. Queda antes do commit pode repetir GET, mas
não presume gravação. Mesmo conteúdo atualiza observação sem aumentar a
versão semântica; A→B→A mantém três versões. Fonte comprovadamente mais
antiga não substitui a corrente mais recente.
Capturas lexicais conservam a precisão original, com limite de 128 KiB de
evidência no armazenamento; exceder a capacidade interrompe a unidade sem
truncar ou substituir valores por números arredondados.

Desligar Vendas, Estoque, Financeiro ou Fiscal não interrompe o acervo,
que depende somente da Base. Desligar a Base suspende I/O e commits. Religar
qualquer parte não adota dados nem executa documentos históricos.

## Proteção, pessoas e IA

Configuração, autorização, coleta manual, desligamento, desconexão e
apagamento exigem administrador. Leituras começam restritas ao administrador;
concessões adicionais pertencem à configuração da área. Outra área não lê
acervo, XML, recibos ou credenciais desta área.

As operações estão definidas uma única vez em
`src/erp/bling/schema.ts`, com nomes estáveis, entradas, saídas, efeitos,
resumos em português, classificação sensível e OpenAPI. Bots usam essas
mesmas operações, dentro da interseção pessoa ∩ bot. A concessão nominal por
operação é única: `src/modules/erp/bot-access.ts`, nas opções ERP do bot e da
área. A lista `operations` da política antiga do Bling é mantida apenas para
compatibilidade dos dados; não concede nem restringe operações. A política
do Bling continua definindo entidades, dados enviados à IA e a liberação da
categoria sensível. Sem política adicional, a concessão ERP permite somente
metadados e conteúdo mascarado. Ações sensíveis exigem
confirmação humana por padrão, com liberação configurável pelo administrador.
Dados pessoais começam mascarados, e dados sensíveis/IA desligados. Habilitar
o envio ao provedor de IA exige aviso explícito e auditoria. Não existe
proibição estrutural de um tipo de dado comercial para IA.

O catálogo geral ainda não descobre o OpenAPI do ERP; conectá-lo é outra
trilha. O contrato e a política do servidor estão preparados, mas não se
deve anunciar a operação como descoberta pelo catálogo antes dessa conexão.
A opção de entrega dos próprios dados ao cliente exige também o caminho de
identidade verificada; configurar a opção não amplia a autoridade de uma
origem externa. WhatsApp e demais origens externas não adquirem poder
administrativo por usarem o telefone de alguém da equipe.

Identificador/segredo do aplicativo e tokens ficam cifrados no cofre do núcleo,
separados por `erp-bling:<área>`. Não entram no SQLite do ERP, erros, logs,
recibos, exportação ou backup lógico. Auditoria contém atores, operações,
revisões, hashes, contagens e códigos saneados, sem cargas comerciais completas.

O backup lógico conserva acervo, hashes, checkpoints e recibos não secretos;
exclui credenciais e estados OAuth transitórios. Restauração mantém a coleta
desligada, invalida posses e requer nova validação de conta/credencial. O
backup lógico do SQLite não substitui a preservação dos objetos XML em R2.

**Até onde o backup lógico cobre.** O backup e a restauração são em páginas
(formato 2; [ERP-PORTE.md](ERP-PORTE.md), "Backup lógico em páginas"). O
administrador os faz em Gestão → Sistema → Backup do ERP (rotas
`/profiles/:p/erp-backup`, com segundo fator para fazer, restaurar e apagar;
operações `erp.backup.*` para os bots, sensíveis). Nenhuma tabela é montada
inteira na memória do Worker,
e essa memória não depende do tamanho do banco (pico de 10 a 15 MB de heap
acima da base de 16 MiB a 1 GiB de dados, medido localmente, no Node, com o
heap do processo travado em 48 MB).
O teto provisório de 16 MiB (`erp_backup_too_large`) saiu dessas rotas; ele
vale só para as funções na memória (`dumpAll`/`readBackup`), usadas por
testes.

Os números abaixo são da Cloudflare (20/11/2026, instalação de teste, massa
sintética de uma tabela com linhas de ~1,1 KB). A coluna "restauração" é da
**restauração antiga**, com a troca numa transação só; a restauração em
etapas desta versão ainda vai ser medida. A medição local, no Node e no
workerd, não mostra o limite de memória do objeto e dava tempos bem menores.

| dados exportados (bytes) | backup | escritas suspensas | restauração antiga (troca numa transação) |
|---|---|---|---|
| 65.044.677 (62 MiB) | 27 s, 3 invocações | 24 s | concluída |
| 129.808.795 (124 MiB) | 62 s, 7 invocações | 59 s | concluída |
| 259.736.747 (248 MiB) | 84 s, 9 invocações | 83 s | falhou: sem memória na troca |
| 519.594.139 (496 MiB) | 165 s, 17 invocações | 164 s | falhou: sem memória na troca; o banco ficou como estava |

- **Backup:** sai inteiro em qualquer tamanho. Enquanto ele lê o banco, as
  alterações do ERP da área ficam suspensas (503 `erp_backup_running`, com
  `Retry-After`); consultas continuam. Medido na Cloudflare: **cerca de
  5 min por GiB** de dados exportados. A barreira cai no fim da leitura, em
  qualquer falha, sem progresso por 2 min ou ao fim do prazo absoluto de
  60 min. A coleta não roda enquanto ela dura e volta na acordada seguinte.
  O manifesto e o estado do trabalho declaram
  `logical_restore: { limit_bytes, exceeds_limit }` (o teto agora é o que
  cabe no disco do objeto); quando o backup passa dele, o estado traz também
  um aviso: o backup foi gravado inteiro, mas para voltar a ele use a
  recuperação no tempo.
- **Restauração:** confere cada parte (tamanho, hash e linhas) e o hash de
  cada tabela antes de mexer no banco (as alterações ficam suspensas, as
  consultas continuam). Depois troca o conteúdo **em etapas**: transações
  pequenas (até ~8 MiB de texto), retomáveis, em várias invocações. Durante
  a troca o ERP da área fica **inteiro parado**, consultas inclusive (503
  `erp_restore_swapping`, "O ERP desta área está sendo restaurado. Volte em
  alguns minutos."). Antes da primeira transação o objeto grava a marca da
  recuperação no tempo; se a troca não puder terminar (erro de dado, erro que
  se repete, prazo de 60 min da troca, conferência final de linhas, hashes ou
  FKs), ele volta à marca e reinicia, e o trabalho termina como falho com o
  banco como estava. Ou o banco fica igual ao backup, ou fica como estava.
  Na restauração antiga (troca numa transação só) o limite era a **memória**
  do objeto: 124 MiB restauraram e 248 MiB falharam (tabela acima), e o teto
  era 64 MiB. Agora o limite é o **disco** do objeto (10 GB): os dados
  atuais mais o estágio têm de caber; senão recusa começar, com
  `erp_restore_too_large`, sem barreira e sem tocar o banco. Para voltar a
  um ponto que não cabe, use a recuperação no tempo do Durable Object da área
  (até 30 dias).

Os bytes dos XML e dos anexos continuam no armazenamento de arquivos (R2) e
não entram no backup lógico. O manifesto diz isso e conta as linhas que os
referenciam (`external_objects.xml_objects` e `attachment_rows`).

**Restauração e arquivos XML.** A restauração recusa começar, com o código
`erp_restore_archive_busy`, enquanto houver exclusão ou gravação de XML em
voo nesta instância (inclusive a que passou do prazo da acordada) ou ainda
não conferida no banco. Depois de começar, nenhuma gravação, leitura de
conferência ou exclusão de XML, nem passo do apagamento, inicia até ela
terminar: a barreira recusa as operações de escrita da coleta e o alarme não
roda a coleta enquanto há trabalho de backup; durante a troca, nenhuma rota
do ERP da área atende. Se mesmo assim houver XML em voo na hora da troca,
ela não começa e a restauração falha sem mudar o banco. Um apagamento em curso dentro do backup restaurado é aposentado: a
coleta fica desligada e um novo apagamento exige nova prévia e confirmação;
as exclusões R2 que ele já tinha enfileirado passam à limpeza de órfãos da
área, que só apaga objeto que nenhum item restaurado referencia.

## Parar, desconectar, revogar e apagar

- **Desligar:** impede novas chamadas e invalida commits em curso; conserva
  o acervo. Religar exige configuração/aprovação válidas e respeita as esperas.
- **Desconectar:** também remove o material secreto e conserva uma revisão
  de invalidação, para uma resposta atrasada não restaurar credenciais.
  Conserva os dados históricos.
- **Revogar no Bling:** o dono remove a autorização do aplicativo no próprio
  Bling, segundo procedimento oficial conferido. Não há chamada inventada de
  revogação remota.
- **Apagar acervo:** revisar a prévia com escopo, geração, contagens e arquivos;
  confirmar seu hash. O trabalho desliga a coleta, aposenta a geração e apaga
  SQL/R2 em lotes retomáveis. Conteúdo referenciado por adoção, vínculo
  operacional ou envio em revisão impede o apagamento. A conclusão só vale
  após conferência SQL e R2; recibo mínimo/auditoria permanecem, e comandos
  antigos não podem ressuscitar o acervo.

O apagamento excepcional suspende somente os gatilhos DELETE da allowlist
do acervo dentro da mesma transação síncrona, restaura as definições e
confere FKs. Não usa a restauração geral de backup nem desliga guardas
operacionais. Não apagar arquivos diretamente no R2 como atalho.

## Evidências de aceite

Os testes `tests/erp/org/*.test.mjs` e `tests/org-*.test.ts` distinguem o
servidor de recursos simulado (somente GET, zero mutações) do provedor OAuth
falso. A prova integrada compara conteúdo e contagens operacionais,
recibos/checkpoints, retomada e isolamento; testes do adaptador OAuth
inspecionam os POSTs com `fetch` injetado, sem rede.

O conjunto de verificação externa é `npm run check`, `npm run test:erp`,
as seis suítes `tests/org-{base,auth,coleta,acervo,api,painel}.test.ts`,
`tests/org-fecha.test.ts` e `npm run test:erp:painel`. A aprovação deve citar
o resultado efetivamente executado; teste escrito não é teste aprovado.
O diferencial e seu oráculo não são alterados para acomodar esta função.
Nenhum desses testes substitui o roteiro do dono ou autoriza implantação.

| Contrato | Onde conferir no aceite |
|---|---|
| A1 — escopo | Montagem no `Coordinator`, Base independente, API de dados GET e comparação operacional antes/depois. |
| A2 — semântica herdada | Recibos/CAS, revisitas, precisão, histórico e XML; aplicadores, vínculo operacional e envio permanecem fora. |
| A3 — dados | Tabelas da versão 11 (e as quatro da adoção, versão 12), corrente único, arquivo anterior, hash do envelope, replay e geração aposentada. |
| A4 — recursos | Catálogo versionado de 18 entidades, XML e extras não confirmados; evidência oficial continua pendente. |
| A5 — alarme | Uma unidade/GET, orçamento e prioridade operacional, esperas persistidas e revalidação após I/O. |
| A6 — autorização | Cofre cifrado/CAS, estado/cookie/sessão, mesma conta, refresh incerto e restauração suspensa. |
| A7 — operações | Descritores/OpenAPI, mesmas operações para pessoa/bot, política persistida, quatro abas e apagamento retomável; descoberta pelo catálogo é outra trilha. |
| A8 — arquivos e capacidade | XML privado por área, hash/manifesto, bytes SQL/R2 separados, parada preventiva e backup sem autorização. |
| A9 — conferência | Avisos e aprovação administrativos, auditoria saneada e roteiro do dono; métricas sem evidência não comprovam cobertura. |
| A10 — integração | Portas concretas montadas, simuladores separados, interrupções/replay e invariância operacional; registrar os resultados das verificações externas. |
