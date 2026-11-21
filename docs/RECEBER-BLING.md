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
`erp_sync__settings.enabled` continua falso. Não há envio de alterações ao
Bling. A adoção dos cadastros é um passo separado, pedido pela pessoa (seção
"Adotar cadastros"); a escrita contínua futura terá contratos e autorizações
próprios; uma passagem concluída não encerra a coleta nem constitui migração.

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
contas só se mantêm (ajuste no ERP).

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

## Antes de usar uma conta real

O aceite automatizado usa exclusivamente dados e OAuth simulados. Ele não
confirma a documentação atual do Bling, seus limites, o aplicativo do dono,
os escopos contratados, a identidade da empresa ou a disponibilidade de XML.
Nenhum teste exige credencial ou conta real.

Os recursos originais estão marcados `original_conferido`: isso comprova a
implementação local herdada, não a vigência oficial. A coleta real só aceita
recursos `oficial_confirmado` com evidência da conferência. O catálogo é
versionado em `src/erp/bling/resources.ts`; o painel não aceita endpoints
arbitrários nem promove a confirmação por um simples clique. Recursos extras
sem caminho ou identidade confirmados permanecem bloqueados.

Antes da liberação real, registrar URL e data das referências oficiais para
endpoints, paginação, filtros, variantes excluídas, escopos de leitura,
limites e identificação da conta. Conferir separadamente OAuth, expiração,
rotação do refresh token, retorno e procedimento de revogação. Não inferir um
endpoint de identificação ou revogação a partir do seu nome. A montagem deve
receber uma prova oficial de identidade antes de liberar a autorização real.
Essa pendência não pode ser resolvida usando dados do simulador.

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
4. Confere os nomes oficiais dos escopos de leitura exigidos pelos recursos
   selecionados. A lista local ainda sem escopos confirmados não prova que o
   aplicativo tenha acesso. Não solicitar escopos de escrita para esta fatia.
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
