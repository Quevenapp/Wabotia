# Vendas e orçamento (módulo `vendas`)

Catálogo de produtos por área, com foto, códigos, estoque e os dados fiscais
que a nota fiscal pede; orçamento enviado e aprovado pelo WhatsApp; venda com
baixa de estoque, cobrança e comprovante; e a nota fiscal montada e entregue a
um emissor. O [Caixa](CAIXA.md) usa o mesmo catálogo e a mesma venda.

- Desligado por padrão. Ligue em **Gestão → Módulos → Vendas e orçamento**.
- Telas: **Vendas e orçamentos** (equipe), **Produtos e estoque** (equipe vê,
  administrador cadastra) e **Regras e nota fiscal** (administrador).
- API: [API.md](API.md), seção "Vendas e orçamento"; OpenAPI, grupo "Vendas".
- Código: `src/modules/vendas/`; migrações `0060` (catálogo e estoque) e
  `0061` (orçamentos, vendas, devoluções, documentos fiscais).

## Catálogo

| Campo | Regra |
|---|---|
| `name` | Até 120 caracteres (o limite do nome do produto na nota) |
| `price_cents`, `cost_cents` | Centavos. O custo nunca sai para o cliente nem para os bots |
| `unit`, `fractional` | Unidade comercial (UN, KG, L, M, CX…). Fracionado aceita até 3 casas (0,75 kg) |
| `ean` | GTIN-8, 12, 13 ou 14 com o dígito verificador conferido; único na área |
| `sku` | Código interno; único na área. O leitor de código de barras procura por EAN e por SKU |
| `photo_media_id` | Imagem JPG, PNG ou WebP enviada por `POST /media` (guardada no R2 da instalação) |
| `active` | Arquivado some da grade e das buscas e continua nas vendas antigas |
| `track_stock`, `allow_negative`, `min_stock` | Controle de estoque; saldo negativo só se permitido; aviso no mínimo |
| `fiscal` | Dados da NF-e/NFC-e (abaixo) |

Excluir um produto que já teve movimento, venda ou orçamento arquiva; os
outros são apagados. Categorias têm nome e cor (a cor do botão no caixa);
excluir uma categoria deixa os produtos sem categoria.

## Estoque

O saldo é guardado em **milésimos da unidade** (1 kg = 1000) e a API mostra
o número decimal. Toda mudança é um movimento: `entrada`, `saida`, `ajuste`
(inventário: informa-se o saldo contado e o movimento guarda a diferença),
`venda`, `devolucao` e `cancelamento`. Cada movimento traz o saldo depois
dele.

**Por que duas vendas da última unidade não passam juntas.** Criar a venda,
numerar e baixar o estoque acontecem num único lote do D1, que é uma
transação:

1. `vendas_products` tem `CHECK (track_stock = 0 OR allow_negative = 1 OR stock_milli >= 0)`.
   Uma baixa que deixaria o saldo negativo falha e desfaz o lote inteiro: a
   venda não é gravada, o número não é consumido e os outros itens não baixam.
   A resposta é `409 out_of_stock` com os produtos que faltaram.
2. Cada movimento tem uma chave única por área (`sale:<venda>:<linha>`,
   `cancel:<venda>:<linha>`, `return:<devolução>:<linha>`). Repetir a mesma
   baixa (requisição repetida, gancho reentregue) falha na chave e desfaz o
   lote; a venda já gravada é devolvida igual.
3. A venda tem `source_key` única (o `requestId` do comando, a sessão do
   caixa, o orçamento). A mesma `Idempotency-Key` devolve a mesma venda.

Os comandos de uma área já rodam em série no `Coordinator`; as garantias
acima valem mesmo sem isso (o teste `tests/vendas-estoque.test.ts` dispara
três vendas da última unidade em paralelo, direto no serviço, e só uma
passa).

Quem mexe: entrada, qualquer pessoa da equipe (com o custo, que vira o custo
do produto); saída e ajuste, administrador; aplicações, `billing:write`.
Quando um produto cruza o mínimo (estava acima e ficou no mínimo ou abaixo),
sai o evento `vendas.stock_low` (desligável nas regras). A lista de produtos
filtra `low=1`.

## Dados fiscais do produto

Todos opcionais ao salvar; a prévia da nota diz o que falta. Os padrões do
emitente (CFOP 5102, origem 0, CSOSN 102 ou CST 00, PIS/COFINS 49) valem para
o produto sem o campo.

| Campo | O que é | Validação |
|---|---|---|
| `ncm` | Nomenclatura Comum do Mercosul | 8 dígitos (aceita pontos) |
| `cest` | Código da substituição tributária | 7 dígitos |
| `cfop` | Operação (5xxx dentro do estado, 6xxx fora) | 4 dígitos; NFC-e só 5xxx |
| `origin` | Origem da mercadoria | 0 a 8 |
| `icms_csosn` | Simples Nacional (101, 102, 103, 201, 202, 203, 300, 400, 500, 900) | lista |
| `icms_cst` | Regime normal (00, 10, 20, 30, 40, 41, 50, 51, 60, 70, 90…) | lista; nunca junto do CSOSN |
| `icms_rate`, `icms_base_reduction`, `fcp_rate` | Alíquota, redução da base, FCP | 0 a 100, 4 casas |
| `pis_cst`, `pis_rate`, `cofins_cst`, `cofins_rate` | PIS e COFINS | CSTs válidos |
| `ipi_cst`, `ipi_rate` | IPI (só NF-e) | CSTs válidos |
| `tax_unit`, `tax_factor`, `tax_ean` | Unidade tributável, fator (qtd. tributável = qtd. × fator), GTIN tributável ou "SEM GTIN" | |
| `cbenef` | Benefício fiscal da UF | 8 ou 10 caracteres |
| `ibs_cbs_cst`, `cclasstrib` | Reforma tributária (IBS/CBS, a partir de 2026) | 3 e 6 dígitos |

As linhas da venda e do orçamento guardam uma **cópia** do produto no momento
(nome, preço, códigos e dados fiscais). Corrigir o NCM depois não muda uma
venda já feita: a nota sai com o que estava na venda (o teste fiscal confere
isso). Para corrigir, cancele e refaça a venda.

## Orçamento

1. A equipe monta (`POST /vendas/quotes`): produtos do catálogo ou itens
   avulsos (serviço, frete), desconto, cliente e, de preferência, a conversa.
   No orçamento qualquer pessoa da equipe pode dar outro preço, porque o
   cliente aprova o valor; o limite de desconto da equipe vale do mesmo jeito.
2. Envia (`POST /vendas/quotes/{id}/send`): fixa a validade (fim do dia, em
   Brasília, `valid_days` ou o padrão das regras), sobe a versão e manda:
   - `via: "buttons"` (padrão): o texto com os itens e, em seguida, os botões
     **Aprovar** e **Recusar**. Na linha QR viram "1. Aprovar / 2. Recusar".
   - `via: "link"`: um passo web com o orçamento e a escolha (útil para
     orçamentos longos); a resposta volta pelo gancho `onWebStepCompleted`.
   - `notify: false`: só registra (orçamento entregue em mãos ou por e-mail).
   Fora da janela de 24 horas, o texto sai pelo modelo de notificação.
3. O cliente responde dentro da validade: botão, "1"/"2" (até 24 h depois do
   envio) ou APROVAR/RECUSAR (com o número, opcional). Botão de uma versão
   antiga responde "foi atualizado". A equipe vê uma nota interna e o evento
   `vendas.quote_approved`/`declined`; pode registrar a resposta em nome do
   cliente (`/decision`).
4. Converte (`/convert`): vira venda com os preços e descontos do orçamento.
   Equipe só converte aprovado; administrador também rascunho, enviado ou
   vencido. Converter de novo devolve a mesma venda.

A rodada periódica marca `expired` os enviados vencidos. Editar um orçamento
enviado o volta para rascunho (o cliente nunca aprova um valor que não viu).
O item de menu **Meus orçamentos** (`vendas_orcamentos`) mostra ao cliente os
orçamentos dele e reenvia os botões do pendente.

## Venda

- **Linhas**: produtos do catálogo, com preço do catálogo. Outro preço e item
  avulso só para administrador (a equipe usa desconto).
- **Desconto**: por linha (`discount_cents`) e da venda (`discount_cents` ou
  `discount_percent`), rateado nas linhas (`net_cents`) para as devoluções. A
  equipe tem limite (`max_discount_percent`, padrão 10% do bruto); acima,
  `403 discount_limit`.
- **Pagamento**: uma ou mais formas ligadas nas regras: dinheiro, cartão de
  crédito, cartão de débito, Pix na chave da loja (`pix_manual`, conferido
  pela equipe), outra. A soma precisa cobrir o total; o excesso é troco e só
  pode sair do dinheiro.
- **Pix e link do Mercado Pago** (`pix`, `link`, módulo Cobrança): sozinhos,
  com o total e a conversa do cliente. A venda fica `awaiting_payment`, com o
  estoque reservado e `payment.pix_code`/`url` para mostrar na tela; o
  webhook confirma (`completed`). Vencida ou cancelada, a venda cancela e o
  estoque volta. Paga depois de cancelada: `needs_refund` e nota interna.
- **Cancelar** devolve todo o estoque restante. Só administrador, ou a equipe
  se `operator_can_cancel` estiver ligado (a própria venda aguardando
  pagamento, quem fez pode cancelar). Venda de um caixa já fechado não se
  cancela: faz-se devolução no caixa aberto.
- **Devolver**, parcial ou total: o estoque volta, o valor é proporcional
  (com o desconto rateado) e a forma da devolução fica registrada.
- **Comprovante não fiscal**: `GET /vendas/sales/{id}/receipt?columns=32|48`
  traz o estabelecimento, a venda e o texto em colunas ("NÃO É DOCUMENTO
  FISCAL"), para o painel e para os apps imprimirem no ThermalPrinterKit.

## Nota fiscal

O Wabotia **monta** a NFC-e (modelo 65) ou a NF-e (55) a partir da venda e do
emitente e **não emite sozinho**: a emissão fica atrás da interface
`FiscalProvider` (`src/modules/vendas/fiscal.ts`) e nenhum provedor está
ligado. Hoje:

- `GET /vendas/sales/{id}/fiscal` mostra o documento e as pendências (sem
  CNPJ, sem regime, sem NCM, CFOP que não serve para NFC-e, CSOSN num emitente
  do regime normal, falta de alíquota, destinatário da NF-e…);
- `GET /vendas/fiscal` mostra o que falta no emitente e quantos produtos
  ativos estão sem NCM;
- `POST /vendas/sales/{id}/fiscal/emit` responde
  `409 fiscal_provider_not_configured`.

**Emissor previsto: NFapi**, a API de notas da Queven, com integração futura
(decisão do dono). Nenhum cliente da NFapi existe ainda no Wabotia. Quando ela
estiver pronta, entra como um provedor que implementa `FiscalProvider` e chama
`registerFiscalProvider`; o resto do módulo não muda.

O emitente vem de **Estabelecimento** (nome fantasia e CNPJ) e da chave
`vendas.fiscal` (regime, razão social, IE, IM, CNAE, endereço com o código
IBGE do município, UF, CEP, ambiente, séries e padrões). A tabela
`vendas_fiscal_documents` já existe para guardar número, série, chave de
acesso, protocolo, XML e DANFE devolvidos pelo emissor.

### O que o Wabotia entrega ao emissor

`provider.emit(env, profile, document, {key})`, com `key` idempotente (a
mesma chave não pode gerar outra nota) e `document` (`FiscalDocument`) assim:

| Parte | Campos |
|---|---|
| Documento | `model` ("65" NFC-e ou "55" NF-e), `environment` (homologacao, producao), `series`, `crt` (1 Simples, 2 Simples com excesso, 3 normal, 4 MEI), `sale {id, number, created}` |
| Emitente | `cnpj`, `legal_name`, `trade_name`, `ie`, `im`, `cnae`, `phone`, `address {street, number, complement, district, city, city_code (IBGE), uf, cep}` |
| Destinatário | `document` (CPF/CNPJ), `name`, `ie`, `email`, `address` (obrigatório na NF-e) ou `null` na NFC-e sem CPF |
| Itens | `number`, `code` (SKU ou id), `ean` (ou "SEM GTIN"), `description`, `ncm`, `cest`, `cfop`, `unit`, `quantity`, `unit_value_cents`, `gross_cents`, `discount_cents` (desconto da linha + parte do desconto da venda), `tax_unit`, `tax_quantity`, `tax_ean`, `icms {origin, cst \| csosn, rate, base_reduction, base_cents, value_cents, fcp_rate}`, `pis {cst, rate, value_cents}`, `cofins {cst, rate, value_cents}`, `ipi {cst, rate}` (NF-e), `cbenef`, `ibs_cbs {cst, cclasstrib}` |
| Totais | `products_cents`, `discount_cents`, `total_cents`, `icms_cents`, `pis_cents`, `cofins_cents` |
| Pagamento | `payments [{tpag, method, amount_cents}]` (tPag: 01 dinheiro, 03 crédito, 04 débito, 17 Pix dinâmico, 20 Pix estático, 99 outros) e `change_cents` (troco) |
| Informações | `additional_info` (observação da venda) |

Valores em centavos; quantidades em decimal. O emissor devolve
`FiscalResult`: `status` (authorized, processing, rejected, error),
`provider_ref`, `series`, `number`, `access_key`, `protocol`, `xml_url`,
`pdf_url` e `message`. O Wabotia grava isso em `vendas_fiscal_documents`,
atualiza `fiscal_status` da venda e publica `vendas.fiscal_updated`.

O certificado digital e o CSC da NFC-e ficam com o emissor; nunca passam pelo
Wabotia. Na integração, o token de acesso ao emissor deve ser guardado
cifrado (como a conta do Mercado Pago), nunca em arquivo nem nas
configurações legíveis, e `auto_emit` (já nas regras) passa a emitir a NFC-e
ao concluir a venda.

## Pedido e o catálogo

**Decisão: o cardápio do Pedido continua independente nesta entrega.** Um
item do cardápio não baixa estoque de Vendas. Motivos: o Pedido serve a
lanchonetes que não querem Vendas ligado, e o contrato de módulos só tem
dependência obrigatória (`requires`): o Pedido não pode importar
`vendas/public.ts` sem exigir Vendas ligado em toda área.

O caminho já preparado, para quando o núcleo aceitar dependência opcional:

1. Núcleo (sessão A): `optional_requires` (o módulo pode chamar o
   `public.ts` do outro só quando ele está ligado na área).
2. Pedido (sessão F), migração na faixa dele: `pedido_items.product_id`
   (opcional) e a escolha do produto no cadastro do item.
3. Pedido, ao confirmar o pedido (recebido ou pago): `moveStock(ctx, actor,
   itens, "venda", {type: "sale", id: pedido})` de `vendas/public.ts`, com
   chaves `pedido:<pedido>:<linha>` (repetir não baixa de novo; sem saldo,
   `409 out_of_stock`, e o pedido é recusado como item esgotado). Ao
   cancelar, `"devolucao"` com `pedido-cancel:<pedido>:<linha>`.
4. Pedido, no `onWebStepValidate` do carrinho: item ligado a produto sem
   saldo conta como esgotado.

## Permissões

| O quê | Pessoa | Aplicação |
|---|---|---|
| Ler catálogo, estoque, orçamentos, vendas | equipe | `conversations:read` (telefone e documento do cliente só com `contacts:read`; observações internas só com `notes:read`) |
| Produtos, categorias, regras | administrador | — |
| Entrada de estoque | equipe | `billing:write` |
| Saída e ajuste de estoque | administrador | `billing:write` |
| Orçamento (montar, enviar, resposta, cancelar) | equipe | `conversations:write` |
| Venda, conversão, emissão de nota | equipe | `billing:write` |
| Cancelar e devolver | administrador (equipe com `operator_can_cancel`) | `billing:write` |

Vendas ao balcão com dinheiro na gaveta passam pelo Caixa, que exige o papel
`caixa:cashier` ([CAIXA.md](CAIXA.md)).

**Por que Vendas não tem papel próprio (ex.: `vendas:seller`).** Vender e
orçar aqui faz parte do atendimento: quem conversa com o cliente monta o
orçamento, envia e registra a venda pela conversa. Um papel de vendedor
obrigaria o administrador a concedê-lo a toda a equipe só para mandar um
orçamento, sem proteger nada a mais, porque o que é arriscado já tem trava
própria: preço diferente do catálogo e item avulso só para administrador,
desconto acima do limite da equipe (`403 discount_limit`), cancelamento e
devolução só para administrador (ou com `operator_can_cancel`), saída e
ajuste de estoque só para administrador, e o dinheiro físico só no Caixa,
com o papel `caixa:cashier`. Um papel `vendas:seller` passa a valer se o
dono quiser restringir quem vende, separar vendedores para comissão ou ter
uma lista de vendedores para escolher na venda. Entraria em `grants` do
módulo, sem migração, com `ctx.granted` nas mesmas rotas de escrita de
orçamento e venda.

## Limites (consultas ao D1)

Uma venda custa cerca de 20 instruções mais 2 por linha (saldo e movimento
no mesmo lote); 50 linhas, perto de 120. Cabe com folga no plano pago (1000
por invocação), que a instalação exige; no gratuito (50) uma venda com mais de
10 a 12 linhas não caberia. Veja [LIMITES.md](LIMITES.md).