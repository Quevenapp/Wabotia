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
`FiscalProvider` (`src/modules/vendas/fiscal.ts`) e nenhum emissor está
integrado. Hoje:

- `GET /vendas/sales/{id}/fiscal` mostra o documento e as pendências (sem
  CNPJ, sem regime, sem NCM, CFOP que não serve para NFC-e, CSOSN num emitente
  do regime normal, falta de alíquota, destinatário da NF-e…);
- `GET /vendas/fiscal` mostra o que falta no emitente e quantos produtos
  ativos estão sem NCM;
- `POST /vendas/sales/{id}/fiscal/emit` responde
  `409 fiscal_provider_not_configured`.

O emitente vem de **Estabelecimento** (nome fantasia e CNPJ) e da chave
`vendas.fiscal` (regime, razão social, IE, IM, CNAE, endereço com o código
IBGE do município, UF, CEP, ambiente, séries e padrões). A tabela
`vendas_fiscal_documents` já existe para guardar número, série, chave de
acesso, protocolo, XML e DANFE quando houver emissor.

### Integrar um emissor (quando o dono decidir)

1. Um arquivo `src/modules/vendas/fiscal-<emissor>.ts` que implementa
   `FiscalProvider` (`emit`, e opcionalmente `status` e `cancel`), traduz o
   documento neutro para o JSON do emissor e chama `registerFiscalProvider`.
2. O token da conta do emissor guardado cifrado (como a conta do Mercado
   Pago em `payment_accounts`), nunca em arquivo nem nas configurações
   legíveis. Precisa de uma tela de conta, como **Gestão → Cobrança**.
3. O webhook ou a consulta de situação do emissor atualiza
   `vendas_fiscal_documents` e publica `vendas.fiscal_updated`.
4. `auto_emit` (já nas regras) emite a NFC-e ao concluir a venda.

O **certificado digital A1** (e-CNPJ, arquivo .pfx, validade de 1 ano) e o
**CSC** da NFC-e ficam no emissor, cadastrados pelo dono; nunca passam pelo
Wabotia.

### O que cada emissor pede e quanto custa (consultado em 16/11/2026)

| Emissor | Preço publicado | Notas incluídas | O que pede |
|---|---|---|---|
| **Focus NFe** | Retail (NFC-e) R$ 62,90/mês para 1 CNPJ; Solo R$ 94,90/mês (NF-e e NFC-e) | Retail: 500 NFC-e + 100 NF-e/mês (adicional R$ 0,055 a NFC-e); Solo: 100 notas (R$ 0,11 a adicional) | Certificado A1 do CNPJ (só A1), token da API; para NFC-e, o CSC da SEFAZ |
| **NFE.io** | NFC-e: Inicial R$ 88/mês (anual, até 2 CNPJs); Base R$ 220/mês (mensal) | Inicial 700; Base 2.000 notas/mês | Certificado A1, chave da API; NF-e por proposta comercial |
| **PlugNotas** (TecnoSpeed) | Sem preço publicado: cotação pelo formulário | Sem taxa por documento, segundo a página | Certificado (.pfx/.p12) de cada CNPJ; contrato comercial |

Além do emissor, o dono precisa de:

- **Certificado e-CNPJ A1**: cerca de R$ 165 a R$ 235 por ano, conforme a
  certificadora (valores de referência de 2026, a confirmar na compra).
- **Inscrição estadual** ativa e **credenciamento como emitente de NFC-e**
  na SEFAZ do estado; depois, gerar o **CSC** (identificador e código) no
  portal da SEFAZ. Sem CSC a NFC-e não tem validade.
- O **contador** para definir regime, CFOP, CSOSN/CST e NCM dos produtos.

Fontes: [Focus NFe, preços](https://focusnfe.com.br/precos/);
[NFE.io, preços NFC-e](https://nfe.io/precos/emissao-nfce);
[NFE.io, preços NF-e](https://nfe.io/precos/emissao-nfe);
[PlugNotas](https://tecnospeed.com.br/plugnotas/);
[preço de certificado digital 2026](https://rolmyjuncontabilidade.com.br/certificado-digital/certificado-digital-preco/);
[requisitos da NFC-e, Receita Federal/ENAT](https://enat.receita.economia.gov.br/pt-br/area_nacional/eventos/x-enat-encontro-nacional-de-administradores-tributarios/noticias/arquivos-pdf/nota-fiscal-de-consumidor-eletronica-nfc-e/at_download/file);
[credenciamento, SEFAZ-PE](https://www.sefaz.pe.gov.br/Servicos/Nota-Fiscal-de-Consumidor-Eletronica/Paginas/Credenciamento-de-Contribuintes.aspx).
Os preços mudam; confira antes de contratar.

**Para quem só vende no balcão, a Focus NFe Retail é a opção mais barata
publicada** (NFC-e, 1 CNPJ). Quem tem vários CNPJs ou muito volume deve
comparar o plano anual da NFE.io e uma cotação do PlugNotas. A decisão é do
dono da instalação.

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

## Limites (consultas ao D1)

Uma venda custa cerca de 20 instruções mais 2 por linha (saldo e movimento
no mesmo lote); 50 linhas, perto de 120. Cabe com folga no plano pago (1000
por invocação), que a instalação exige; no gratuito (50) uma venda com mais de
10 a 12 linhas não caberia. Veja [LIMITES.md](LIMITES.md).
