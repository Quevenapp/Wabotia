# Maquininha integrada ao caixa

O caixa do ERP (Vendas › Frente de caixa) manda o valor do cartão direto para
a maquininha, pela nuvem do provedor: não há TEF nem programa instalado no
computador do caixa. A venda só é finalizada quando o pagamento é aprovado,
com a bandeira, as parcelas, a autorização e o NSU gravados na observação da
parcela da venda. Recusado ou cancelado, a venda continua aberta e a tela diz
o motivo em palavras.

Primeiro provedor: **Mercado Pago Point** (Point Smart, Point Pro e as outras
maquininhas Point que aceitam a integração de pagamentos). O código fica atrás
de uma interface comum (`src/erp/terminal/adapter.ts`): Stone/Pagar.me e
PagBank entram depois implementando o mesmo adaptador, sem mudar o caixa.

Faz parte do **Caixa / PDV** (que traz Vendas, Financeiro e Estoque). Com ele
desligado, a configuração some das Preferências, a rota recusa com
`module_disabled` e diz qual módulo ligar.

## O que é preciso para ligar

Feito uma vez por área, pelo administrador.

1. **Conta do Mercado Pago.** A maquininha precisa estar vinculada à mesma
   conta do Mercado Pago cujo Access Token o Vinki usa:
   - **A mesma da Cobrança** (o caso comum): configure antes a Cobrança em
     **Gestão → Automação → Cobrança** (`docs/COBRANCA.md`). A maquininha usa
     o Access Token guardado lá, sem digitar de novo.
   - **Outra conta:** em **Suas integrações** do Mercado Pago, crie (ou use)
     uma aplicação da conta da maquininha, copie o **Access Token de
     produção** (começa com `APP_USR-`) e cole na maquininha integrada.
2. **Formas de pagamento.** Em **Cadastros → Formas de pagamento**, tenha uma
   forma do tipo *cartão de débito* e uma do tipo *cartão de crédito*, ativas
   para recebimentos (por exemplo "Cartão de débito na maquininha" e "Cartão
   de crédito na maquininha"). Formas de cartão que não forem escolhidas
   continuam registradas à mão, como antes.
3. **Ligar.** Em **Preferências → Vendas → Frente de caixa**, no fim da
   página, **Maquininha integrada (cartão)**: escolha a conta, as formas de
   débito e de crédito, até quantas parcelas e quem paga os juros do
   parcelado (a loja ou o cliente). **Ligar a integração**. Nasce desligada.
4. **Maquininha de cada caixa.** Na mesma seção, **Buscar as maquininhas da
   conta** e, em cada loja da frente de caixa, **Usar** a maquininha dela.
   Maquininha fora do modo integrado (modo *PDV* do Mercado Pago) passa para
   ele ao ser escolhida; ela pode pedir para reiniciar. Loja sem maquininha
   continua registrando o cartão à mão.
5. **Aviso de pagamento (opcional).** Sem aviso, o caixa pergunta ao Mercado
   Pago de 2 em 2 segundos enquanto espera, e funciona do mesmo jeito. Para
   receber o aviso, use uma aplicação do Mercado Pago só para a maquininha:
   cadastre em **Webhooks** o endereço mostrado na seção (só o administrador
   vê), com o evento das **integrações Point**, e cole a **assinatura
   secreta** gerada. O aviso só faz o Vinki consultar: o resultado sempre
   vem da consulta autenticada, nunca do corpo do aviso. (Com a mesma
   aplicação da Cobrança, o Mercado Pago manda os avisos para o endereço da
   Cobrança; aí vale a consulta de 2 em 2 segundos.)

O Access Token e a assinatura ficam no cofre do núcleo (cifrados com a
`MASTER_KEY`), nunca em tabela, auditoria ou resposta: a tela mostra só
"guardado".

## No caixa

1. Monte a venda e, na aba **Pagamento**, deixe as parcelas de cartão na forma
   de débito **ou** na de crédito da maquininha (uma cobrança por venda; o
   resto pode ser dinheiro, Pix etc.).
2. **Finalizar venda**: a venda é salva em aberto e abre **Cartão na
   maquininha**. No crédito, escolha à vista ou parcelado. **Enviar para a
   maquininha**.
3. A tela mostra **Aguardando pagamento na maquininha** e confere sozinha. O
   cliente passa ou aproxima o cartão.
4. **Aprovado:** a venda é finalizada pelo mesmo comando do botão de sempre
   (estoque, contas, baixa, cupom fiscal e comprovante, como antes), com a
   observação "Maquininha Mercado Pago · Mastercard crédito 3x · final 4321 ·
   autorização … · NSU …" na parcela.
5. **Recusado ou cancelado:** a venda continua aberta, com o motivo ("Saldo ou
   limite insuficiente no cartão", "A maquininha desistiu da cobrança:
   ninguém passou o cartão a tempo"…). **Cobrar de novo** ou volte para a
   venda e mude a forma.
6. **Cancelar cobrança** tira da maquininha a cobrança que ainda não está na
   tela dela; se o cliente já está passando o cartão, cancele na maquininha.

### Resposta incerta

Se o Mercado Pago não responde a tempo ao envio, a cobrança fica **Sem
resposta da maquininha: conferindo**. Nada é reenviado às cegas:

- pedir de novo (o mesmo comando, outra cobrança para a mesma venda ou
  "Conferir a cobrança") consulta o Mercado Pago pela referência do Vinki e
  segue a mesma cobrança se ela chegou;
- só se ela não está lá aparece **Não apareceu na maquininha**: a pessoa olha
  a maquininha, confirma, e a cobrança sai de novo com a mesma referência;
- uma venda nunca tem duas cobranças em andamento ao mesmo tempo (nem com dois
  caixas abertos na mesma venda).

Pagamento aprovado com a venda ainda aberta (a tela fechou, a internet caiu):
abra a venda de novo e **Finalizar venda**; a tela retoma o pagamento aprovado
sem cobrar outra vez. Se as parcelas de cartão mudaram de valor, a tela pede
para ajustar ao valor aprovado.

## Conciliação de cartões

Finalizada a venda, o pagamento aprovado entra em **Financeiro → Conciliação
de cartões** como uma venda do Mercado Pago **já casada** com as contas a
receber das parcelas da venda (bandeira, débito ou crédito, parcelas, valor,
tarifa quando o Mercado Pago informa, NSU e autorização), sem importar
arquivo (RPC `erp_reconciliation_card_terminal`). Se as contas da venda ainda
não foram lançadas (o papel do caixa não lança contas), a linha entra
pendente e o **Casar de novo** acha a venda depois do lançamento.

Ao importar depois o extrato de vendas do Mercado Pago, a mesma venda aparece
outra vez como linha pendente sem casamento (as contas já estão casadas com a
linha da maquininha): ignore-a com o motivo "já veio pela maquininha". O
extrato de **recebíveis** casa normalmente.

## Bots

Consultar os pagamentos da maquininha é leitura (`erp.maquininha.pagamentos`
e `erp.maquininha.pagamento`, no assunto Conciliação bancária e de cartões).
Enviar a cobrança ao terminal, cancelar, reenviar e configurar **não** existem
para os bots: exigem uma pessoa no caixa.

## Para quem mantém

- Código: `src/erp/terminal/` (contrato, adaptador, Mercado Pago Point,
  transporte, serviço e rotas `/api/v1/profiles/:área/erp-maquininha/*` e
  `/webhooks/maquininha/:código`); tela em `web/erp/MaquininhaCaixa.tsx`,
  `web/erp/MaquininhaSettings.tsx` e `web/erp/maquininha-api.ts`.
- Banco: migração `0270_erp_maquininha.sql` (D1, só tabelas novas). O esquema
  do ERP não mudou (a linha da conciliação usa as tabelas da versão 30).
- Testes só contra provedor simulado: `tests/erp/maquininha/*.test.mjs` (Node)
  e `tests/erp-maquininha.test.ts` (D1).
- Campos do Mercado Pago conforme a documentação pública da API de integração
  de pagamentos do Point (intenção de pagamento por terminal, consulta da
  intenção e do pagamento, cancelamento e eventos). Nenhuma chamada real foi
  feita: antes de ligar em produção, confira com uma maquininha de teste uma
  cobrança de débito, uma de crédito parcelado, uma recusa e um cancelamento.
  O Mercado Pago não devolve um campo chamado NSU: vale a referência da
  adquirente quando vem e, sem ela, o número da operação no Mercado Pago.
