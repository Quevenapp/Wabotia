# Boleto pela API do banco

A **Cobrança bancária** do ERP (parte `erp-cobranca`) registra a conta a
receber como boleto direto no banco, pela API pública de cobrança de cada um:
**Banco Inter**, **Sicoob**, **Banco do Brasil** e **Itaú**. A linha
digitável, o código de barras e o Pix do boleto (boleto híbrido) ficam
gravados com a conta, o PDF sai para qualquer um desses bancos, e o
pagamento chega pelo aviso do banco (webhook) ou pela consulta periódica.

A remessa e o retorno **CNAB continuam como estão**. Cada conta financeira
escolhe: **pela remessa CNAB** (o padrão, como antes) ou **pela API do
banco**.

Código: `src/erp/boleto-api/` (adaptadores em `banks/`, interface comum em
`adapter.ts`), migração `migrations/0260_erp_boleto_api.sql`, telas em
`web/erp/app/components/TitleBoletoApi.tsx` e `BoletoApiSettings.tsx`.

## Ligar, passo a passo

Feito uma vez por área, pelo administrador, com as partes **Financeiro** e
**Cobrança bancária** ligadas em Gestão → Módulos.

1. **Ligue o banco.** ERP → Preferências → Finanças → **Contas a receber** →
   *Boleto pela API do banco* → **Ligar em homologação**. Cada banco nasce
   desligado e em homologação (sandbox), onde o boleto não vale.
2. **Configure a conta financeira.** Finanças → Caixas e bancos → abra a
   conta bancária do banco → *Emissão de Boleto* → *Como esta conta emite
   boleto* → **Pela API do banco**. Digite as credenciais, o certificado e os
   dados do convênio (abaixo, por banco) e use **Salvar e conferir no banco**:
   o Wabotia entra na API (sem registrar nada) e, nos bancos que aceitam,
   cadastra o endereço do aviso de pagamento.
3. **Teste na homologação**: registre o boleto de uma conta a receber, use
   *Consultar no banco*, *Alterar vencimento* e *Baixar no banco*.
4. **Passe para produção** no mesmo lugar do passo 1 (pede a confirmação do
   aviso). Em produção, troque as credenciais e o certificado pelos de
   produção na conta financeira.

Segredos (Client Secret, chaves, token do sandbox, certificado e chave
privada) vão para o **cofre do núcleo** (tabela `secrets`, cifrados com a
`MASTER_KEY`). Nunca voltam nas leituras (a tela mostra "Guardado"), nunca
vão para auditoria nem para log; para trocar, digite de novo. O registro
(`erp_boleto_api_audit`) guarda só quem mudou o quê (os nomes dos campos).

### Certificado (mTLS): o passo do dono da instalação

Inter e Itaú pedem o certificado da API em todas as chamadas; Sicoob e Banco
do Brasil, em produção. O `fetch` do Worker não apresenta um certificado de
cliente escolhido na hora: o certificado precisa estar **ligado ao Worker**
como um vínculo de certificado mTLS da Cloudflare, um por banco, com o nome
`BOLETO_MTLS_INTER`, `BOLETO_MTLS_SICOOB`, `BOLETO_MTLS_BB` ou
`BOLETO_MTLS_ITAU` (`src/erp/boleto-api/transport.ts`). Esta entrega **não
cria** esse recurso; o dono faz uma vez, para cada banco usado:

```
npx wrangler mtls-certificate upload --cert certificado.pem --key chave.key --name boleto-inter
# e no wrangler.jsonc:
# "mtls_certificates": [{ "binding": "BOLETO_MTLS_INTER", "certificate_id": "<id devolvido acima>" }]
```

Sem o vínculo, o pedido que exige certificado nem sai e a tela diz o que
falta. Um vínculo vale para a instalação inteira: duas áreas no mesmo banco
com certificados diferentes não funcionam ao mesmo tempo (limitação conhecida).

Certificado em `.pfx`/`.p12` (comum no Inter e no Itaú): converta para texto
antes de colar:

```
openssl pkcs12 -in certificado.pfx -clcerts -nokeys -out certificado.pem
openssl pkcs12 -in certificado.pfx -nocerts -nodes -out chave.key
```

## Por banco

| | Banco Inter | Sicoob | Banco do Brasil | Itaú |
|---|---|---|---|---|
| API | Cobrança v3 | Cobrança Bancária v3 | Cobranças v2 | Boletos (cash management v2) e Boleto com Pix |
| Certificado | sempre (também no sandbox) | em produção | em produção | sempre |
| Credenciais | Client ID e Secret | Client ID (sandbox: token do portal) | Client ID, Secret e chave do desenvolvedor | Client ID e Secret |
| Dados da conta | conta corrente (opcional) | número do cliente, conta corrente, modalidade | convênio, carteira, variação | id do beneficiário (12), carteira |
| Nosso número | o banco escolhe | o banco escolhe | o Wabotia: `000` + convênio + sequência de 10 | o Wabotia: sequência de 8 |
| Pix no boleto | sempre | opcional (`codigoCadastrarPIX`) | opcional (`indicadorPix`) | opcional (`boletos_pix`) |
| Aviso de pagamento | webhook, cadastrado pela API ao conferir | consulta periódica | webhook (cadastre no portal do BB com o endereço da tela) | webhook (cadastre no portal do Itaú com o endereço da tela) |
| Homologação | `cdpj-sandbox.partners.uatinter.co` | `sandbox.sicoob.com.br` | `api.hm.bb.com.br` | `sandbox.devportal.itau.com.br` (registro como `simulacao`) |

Onde pegar as credenciais:

- **Banco Inter**: Internet Banking PJ → Soluções para sua empresa → Nova
  integração, escopos *boleto-cobranca.read* e *boleto-cobranca.write*; o
  arquivo baixado traz o certificado (`.crt`) e a chave (`.key`).
- **Sicoob**: portal developers.sicoob.com.br → aplicativo com a API
  Cobrança Bancária; o número do cliente é o código do beneficiário no
  contrato de cobrança. Produção: certificado ICP-Brasil da empresa enviado
  no portal.
- **Banco do Brasil**: portal developers.bb.com.br → aplicação com a API
  Cobranças; o convênio, a carteira e a variação estão no contrato de
  cobrança do gerente.
- **Itaú**: devportal.itau.com.br → credenciais e certificado dinâmico; o id
  do beneficiário é agência (4) + conta (7) + dígito.

## O que acontece com a conta a receber

- **Registrar** (na conta a receber em aberto, seção *Boleto pelo banco*):
  sai com o saldo e o vencimento da conta e os dados do cliente (nome,
  CPF/CNPJ e endereço com CEP; faltando, a tela diz o quê). Um boleto vivo
  por conta: registrar de novo devolve o mesmo. Sem resposta do banco, o
  boleto fica "Sem resposta do banco: confira" e a nova tentativa usa o mesmo
  seu número e nosso número (o banco recusa o duplicado).
- **Alterar vencimento** e **Baixar no banco**: só no banco; a conta no
  Financeiro não muda. A linha digitável nova vem da consulta.
- **Pago no banco** (aviso ou consulta): o corpo do aviso só diz quais
  boletos consultar; o pagamento vale depois de o Wabotia consultar o banco.
  Com **Baixar sozinho as contas pagas por Pix ou link** desligada (o padrão,
  Preferências → Contas a receber), vira **sugestão de baixa**, confirmada
  com um clique; ligada, o alarme da área baixa em nome do administrador que
  ligou a opção, **na conta financeira do boleto**, com o comprovante do banco
  na observação. Pago a mais (juros, multa): a diferença entra como juros.
- **Conta mudada à mão** depois do registro (baixa parcial, valor, vencimento
  no Financeiro), já baixada, ou paga a menor: **pendência**, sem baixa.
- O comando de baixa tem id derivado do boleto: aviso repetido nunca baixa
  duas vezes.
- **Consulta periódica**: o alarme da área pergunta ao banco pelos boletos em
  aberto (a cada 12 horas; perto do vencimento, a cada 2 horas). Banco fora do
  ar só adia.
- **PDF** (tela e envio pela conversa): ficha de compensação com o código de
  barras desenhado (intercalado 2 de 5), agência e código do beneficiário,
  carteira e o QR do Pix do boleto híbrido; homologação sai marcada "sem
  valor". Sem os dados (linha digitável, CNPJ da empresa, documento do
  cliente), diz o que falta. No envio pela conversa, o boleto pela API vem
  antes do da remessa CNAB e o Pix do boleto vai no texto.

## Bots

Assunto *Cobrança no banco*: **consultar o boleto** e **perguntar ao banco**
são leitura; **registrar**, **alterar o vencimento**, **baixar no banco** e
**confirmar a baixa** são sensíveis (o bot propõe, a pessoa confirma). Os
interruptores, a conta financeira e o PDF ficam só na tela.

## Rotas

`/api/v1/profiles/{área}/erp-boleto/…` (com a Cobrança bancária desligada:
409 `module_disabled`):

| Operação | Rota |
|---|---|
| `erp.boleto.bancos` / `.salvar` | `GET bancos`, `POST bancos/{banco}` (administrador) |
| `erp.boleto.conta_financeira` / `.salvar` | `GET/POST contas-financeiras/{conta}` (salvar: administrador) |
| `erp.boleto.ver` | `GET conta/{id}` |
| `erp.boleto.registrar` | `POST conta/{id}/registrar` |
| `erp.boleto.consultar_banco` | `GET conta/{id}/banco` |
| `erp.boleto.vencimento` | `POST conta/{id}/vencimento` |
| `erp.boleto.baixar` | `POST conta/{id}/baixar` |
| `erp.boleto.confirmar_baixa` | `POST conta/{id}/confirmar-baixa` |
| `erp.boleto.pdf` | `GET conta/{id}/pdf` |

Registrar, alterar e baixar pedem o papel de remessas da cobrança no ERP
(`financas.remessas.ie`); confirmar a baixa, o de baixar contas a receber.

Aviso do banco: `POST /webhooks/boleto/{código}`. O código (48 caracteres,
um por conta financeira) só aparece ao administrador; no D1 fica o hash.
Limite por IP; falha ao consultar o banco responde erro para o banco reenviar.

## O que só um banco de verdade confirma

Os testes (`tests/erp/boleto-api/bancos.test.mjs` e
`tests/erp-boleto-api.test.ts`) usam bancos simulados; nenhuma chamada saiu
para banco nenhum. Os formatos seguem a documentação pública de cada API e
precisam ser conferidos na homologação de cada banco antes da produção:

- Inter: o `PATCH` de edição do vencimento, o cadastro do webhook pela API e
  o corpo do aviso (`codigoSolicitacao`, `situacao`, `origemRecebimento`).
- Sicoob: os campos do valor pago e da data de liquidação na consulta
  (`valorPago`/`dataLiquidacao` ou o histórico); sem eles, vale o valor do
  boleto e a tela avisa.
- Banco do Brasil: os códigos de estado do título (6 liquidado, 7 baixado),
  os nomes do valor pago (`valorPagoSacado`) e o corpo do webhook de baixa
  operacional; exigência de certificado na produção do convênio.
- Itaú: o endereço da consulta (`boletoscash`), o `PATCH` de vencimento e de
  baixa, o corpo do `boletos_pix` e o formato da notificação.
- Em todos: o vínculo mTLS do certificado no Worker e a expiração do token
  (o Wabotia pede um token novo a cada rodada, sem guardar).
