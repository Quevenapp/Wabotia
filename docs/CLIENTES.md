# Cadastro de clientes (módulo `clientes`)

Ficha do cliente para emitir nota fiscal e guardar o relacionamento, preenchida
pelo próprio cliente pelo WhatsApp, com os dados pessoais mascarados para a
equipe e a exclusão a pedido do titular (LGPD). Ligue em **Gestão → Módulos**;
desligado, as rotas `/clientes/…` respondem `409 module_disabled` e as
palavras e itens de menu deixam de responder.

Telas: **Gestão → Clientes** (fichas, exclusões, quem viu dados),
**Gestão → Cadastro e privacidade** (regras, só administrador) e **Dados da
conversa → Cadastro**. API: [API.md](API.md#cadastro-de-clientes).
Migrações 0085 e 0086.

## A ficha

Os dados de destinatário que a NF-e (modelo 55), a NFC-e (65) e a NFS-e pedem:

| Campo | O quê |
|---|---|
| `kind` | `pf` (pessoa física) ou `pj` (pessoa jurídica) |
| `name`, `trade_name` | Nome ou razão social; nome fantasia só na PJ |
| `document`, `document_type` | CPF ou CNPJ, sem pontuação. O CNPJ alfanumérico (Receita, julho de 2026) já vale |
| `individual_business` | CNPJ de MEI ou empresário individual: é dado de pessoa natural e fica mascarado como o CPF |
| `ie`, `ie_indicator` | Inscrição estadual e indicador do destinatário (`indIEDest`): 1 contribuinte, 2 isento, 9 não contribuinte |
| `im` | Inscrição municipal (tomador da NFS-e) |
| `email` | Para enviar a nota |
| `cep`, `street`, `number`, `complement`, `district`, `city`, `city_ibge`, `uf`, `country_code` | Endereço com o código IBGE do município (7 dígitos) e o país (1058, Brasil) |
| `phones` | Telefones; `verified` quando o próprio cliente preencheu pela conversa daquele número |
| `notes` | Observações da equipe (aplicação só lê com `notes:read`) |

`fiscal_ready` diz o que dá para emitir: NFC-e sempre (sem CPF, inclusive);
NFS-e com documento; NF-e com documento e endereço completo com IBGE.

**Ligação com o núcleo.** A ficha se liga às conversas pelo telefone
autenticado pelo canal (`ctx.verifiedPhone`, com e sem o 9 do celular). Uma
conversa de integração (`app:…`) ou de grupo nunca se liga. Um telefone
confirmado pertence a uma ficha só; um CPF/CNPJ também.

## Autocadastro e correção pelo cliente

O cliente recebe um **link de uso único** (passo web, 48 horas) com o
formulário, como botão com URL na linha oficial ou link no texto da linha QR:

- item de menu **Meu cadastro** (`clientes_cadastro`);
- palavra **MEU CADASTRO** (configurável) em qualquer momento da conversa;
- botão **Enviar link de cadastro** em Dados da conversa, ou
  `POST /clientes/invites` pela equipe ou pela integração que atende.

O formulário pede tipo, nome, CPF/CNPJ, MEI, situação e número da IE, IM,
e-mail, endereço e o código IBGE (opcional: a equipe completa) e o **aceite**
com o texto da área. Com ficha, o mesmo link vira **correção**: os valores
atuais aparecem mascarados na ajuda de cada campo e o que fica em branco não
muda. CPF já cadastrado com outro telefone confirmado é recusado na própria
página; uma ficha da equipe sem telefone confirmado passa a ser do cliente que
preencheu.

**O que fica onde.** O passo web é aberto com `private_answers`: o núcleo não
grava as respostas no passo (`web_steps.result` fica nulo), na nota interna,
no protocolo nem no evento `web_step.completed`. Só a ficha guarda os dados.
O link nunca sai como Flow (a resposta do Flow ficaria na conversa).

**Consentimento.** Cada envio grava um aceite em `clientes_consents` com
finalidade própria (`purpose: "cadastro"`), a versão e o hash SHA-256 do
texto aceito e a evidência (passo web, conversa, canal). É um consentimento de
tratamento de dados (LGPD, art. 7º, I, e art. 8º), separado dos
consentimentos de notificação do núcleo (`billing`, `scheduling`…). Mude a
versão quando mudar o texto.

## Dados mascarados para a equipe

Toda leitura sai mascarada, para pessoas e aplicações:

| Dado | Máscara |
|---|---|
| CPF | `•••.982.247-••` |
| CNPJ de MEI/empresário individual | `••.•••.•••/0001-81` |
| CNPJ de empresa | visível (dado de pessoa jurídica) |
| E-mail | `m•••@g•••.com` |
| Telefone | `+55 (11) •••••-4321` |
| Endereço | `cep` com os 2 primeiros dígitos; logradouro, número, complemento e bairro `•••`; município, UF e IBGE visíveis |
| IE e IM de pessoa física | `•••` |

Nome e nome fantasia ficam visíveis: a equipe precisa saber com quem fala.

**Revelar.** `GET /clientes/customers/{id}/reveal?reason=…&fields=…` devolve
só os campos pedidos sem máscara e grava em `clientes_access_log` quem,
quando, quais campos e o motivo (5 a 300 caracteres). Pode revelar:

- administrador, sempre;
- qualquer pessoa da área, se a regra `reveal` for `team`;
- aplicação com `contacts:read` (a chave presa à conversa, nunca).

Os outros recebem `403 reveal_forbidden`. O destinatário completo para emitir
nota sai em `GET …/fiscal-recipient?reason=…` (aplicação com `contacts:read`)
ou por `fiscalRecipientFor` de `public.ts`, com registro `fiscal`. A aba
**Quem viu** da ficha e **Clientes → Quem viu dados** mostram o registro
(administrador ou aplicação com `contacts:read`).

**Busca.** Por nome; por CPF/CNPJ ou telefone só completos (busca exata) e só
para pessoas e aplicações com `contacts:read` (sem a permissão, os dígitos
saem da busca, como em `ctx.safeQuery`). O resultado continua mascarado.

**Eventos.** `clientes.customer_created` e `clientes.customer_updated` levam
o id, o tipo, a origem, a versão e os **nomes** dos campos alterados, nunca
os valores. `clientes.erasure_requested`, `clientes.erasure_cancelled` e
`clientes.customer_erased` levam ids e contagens.

## Linha do tempo do relacionamento

`GET /clientes/customers/{id}/timeline` monta na hora, sem copiar nada:

- do Cadastro: ficha criada, aceites, notas fiscais vinculadas;
- do núcleo: conversas e protocolos dos telefones da ficha
  (`ctx.customerConversations`, `ctx.customerTickets`);
- dos módulos, pela rota pública de cada um (`ctx.read`, com o ator de quem
  lê): Vendas (orçamentos de `vendas/conversations/{id}` e vendas de
  `vendas/sales?conversation_id=`), Pedido, Ordem de Serviço, Reserva, Agenda,
  Mensalidade e Suporte (`…/conversations/{id}`).

Módulo desligado ou ausente da instalação não aparece; rota que recusa o ator
(permissão) vai para `skipped`. Para manter as consultas ao D1 sob controle,
os módulos são lidos pelas 3 conversas mais recentes (as rotas já casam o
telefone autenticado) e a lista vem até 300 itens.

## Exclusão a pedido do titular (LGPD, art. 18, VI)

### Pedir

- palavra **EXCLUIR MEUS DADOS** ou **APAGAR MEUS DADOS** (configuráveis), em
  qualquer momento da conversa, mesmo com atendente;
- item de menu **Excluir meus dados** (`clientes_exclusao`);
- pela equipe: **Pedir exclusão ao cliente** na ficha
  (`POST /clientes/customers/{id}/erasure`), com botões ou, com
  `{"channel":"link"}`, um link de uso único.

Sem ficha para o telefone, o pedido cria uma ficha mínima só para apagar o
histórico daquele número.

### Confirmar (só o titular)

O cliente recebe o que será apagado, o que fica e até quando, com os botões
**Confirmar exclusão** e **Manter meus dados** (na linha QR, as opções saem
numeradas). O pedido vale 48 horas. A confirmação só vale vinda do próprio
WhatsApp de um telefone da ficha: o toque no botão pelo canal da conversa, a
resposta CONFIRMAR digitada nessa conversa (ou "1" nos 30 minutos seguintes à
pergunta; depois disso um "1" é do menu) ou o link de uso único enviado nela.
Com telefone confirmado pelo cliente na ficha, só ele confirma: um número
acrescentado pela equipe, talvez errado, não. Outro telefone que toque no
botão recebe "Só o titular…". **Não existe rota para a equipe
confirmar**; a equipe pode cancelar um pedido ainda não confirmado.

### O que acontece

1. A ficha passa a `erasing` (nada de revelar, corrigir nem autocadastro).
2. Sai a última mensagem: "Pedido confirmado…".
3. Guarda fiscal: se há nota fiscal vinculada dentro do prazo legal, os dados
   de destinatário (nome, documento, IE, IM, endereço) vão para
   `clientes_fiscal_holds`, **cifrados** com a `MASTER_KEY`, fora da ficha e
   da tela da equipe.
4. Cada módulo com `onCustomerErase` apaga a parte dele (abaixo). Falha de um
   módulo fica pendente e a rodada periódica repete (1 min dobrando até 1 h).
5. Núcleo (`ctx.eraseConversations`): mensagens e anexos recebidos (o
   arquivo no R2 também), textos e andamentos dos protocolos, respostas de
   passos web, evidência dos consentimentos de notificação, comentário de
   avaliação, entrada e envios concluídos, entradas e resultados de bots,
   contatos da agenda vinculados ou com o telefone, eventos dessas
   conversas, telefone das senhas da fila e permissões de ligação.
6. Quando a última mensagem sai, a conversa perde o telefone
   (`external_id` vira `erased:<id>`) e é encerrada. Uma mensagem nova do
   cliente abre outra conversa, sem histórico. Envio preso há mais de 24 horas
   é cancelado e a conversa é liberada mesmo assim.
7. Tudo concluído: a ficha vira `erased` (nome, documento, endereço, e-mail,
   observações em branco; telefones apagados) e sai
   `clientes.customer_erased`.

### O que fica, e por quanto tempo

| Fica | Sem dado pessoal? | Até quando | Base |
|---|---|---|---|
| Linha da ficha (`id`, `status: erased`, datas) | sim | sempre | vínculo dos registros abaixo |
| Linhas das conversas e protocolos (id, número, estado, datas) | sim (título vira "Dados excluídos a pedido do titular") | sempre | vínculos de atendimento pedidos pelo usuário |
| Pedido de exclusão (`clientes_erasures`): canais, datas, ids guardados, resumo por módulo | sim | sempre | prova do atendimento ao direito (art. 18, § 3º; art. 37) |
| Aceites do cadastro (versão, hash do texto, ids) | sim | sempre | prova do consentimento (art. 8º, § 2º) |
| Registro de quem viu (ator, campos, motivo) | sim, salvo o que a equipe escreveu no motivo | sempre | prestação de contas (art. 6º, X) |
| Vínculo das notas fiscais (módulo, id, modelo, série, número, chave, emissão) | sim | fim do prazo de guarda | obrigação legal (art. 16, I) |
| Destinatário das notas, cifrado | **não** (é o que a nota exige) | fim do prazo de guarda; some sozinho | obrigação legal (art. 16, I) |
| Cobranças do núcleo (valor, estado, datas) | sim | sempre | registro financeiro |
| Documento fiscal no emissor (Vendas, NFapi) | não | prazo de guarda, regra do emissor | obrigação legal |

**Prazo de guarda das notas.** A LGPD permite conservar dados para cumprir
obrigação legal ou regulatória do controlador (art. 16, I) e ressalva essas
hipóteses no direito de eliminação (art. 18, VI). O emitente da NF-e mantém o
arquivo digital "pelo prazo estabelecido na legislação tributária" (Ajuste
SINIEF 07/2005, cláusula décima, redação do Ajuste SINIEF 22/2013); a NFC-e e
a NFS-e seguem a mesma lógica nas normas estaduais e municipais. A legislação
tributária manda conservar livros e comprovantes até a prescrição dos
créditos (CTN, art. 195, parágrafo único). O fisco tem 5 anos para lançar,
contados do primeiro dia do exercício seguinte (CTN, art. 173, I), e mais 5
para cobrar depois do lançamento definitivo (art. 174); o Código Civil, art.
1.194, repete a regra para o empresário. Por isso o Cadastro guarda até
**1º de janeiro do ano seguinte à emissão + 5 anos** (nota de 16/11/2026:
até 1º/1/2032), configurável até 10 anos em `fiscal_retention_years`.
Havendo fiscalização ou execução fiscal em curso, o prazo se estende: o
contador da empresa decide se aumenta o número.

**O que não é apagado.** A lista de bloqueio da fila (abuso, com validade:
legítimo interesse, art. 7º, IX); respostas guardadas pelo recibo de
idempotência de comandos antigos (tabela `receipts`, que o núcleo expira);
backups feitos antes do pedido (`npm run backup`: quem guarda backup deve
apagar ou deixar expirar). Registros de outros módulos dependem do gancho de
cada um (abaixo); até eles implementarem, o resumo do pedido mostra só os que
responderam.

### Para os outros módulos: `onCustomerErase`

```ts
import { onCustomerErase } from "../api";

onCustomerErase("pedido", async (ctx, erasure) => {
  // erasure: {erasure_id, customer_id, phones, document, conversation_ids,
  //           fiscal_retention_until}
  // Apague ou anonimize o que for do cliente (por telefone, conversa,
  // documento ou customer_id). Registro ligado a nota fiscal emitida guarda
  // só o que a nota exige até fiscal_retention_until.
  return { erased: 3, kept: 1, note: "1 pedido com NFC-e guardado" };
});
```

Roda em toda área, com o módulo ligado ou não. Deve ser idempotente (o
Cadastro repete o gancho que lançou erro). Não mande mensagem ao cliente: o
Cadastro já avisou. A nota do resultado aparece no histórico de exclusões e
não pode ter dado pessoal.

## Mensalidade e Vendas apontando para a ficha

Proposta, sem quebrar o que existe (cada sessão implementa o seu lado):

- **Vendas** (`vendas_sales`, `vendas_quotes`): coluna nova `customer_id`
  (nula). Ao criar venda ou orçamento com conversa, `ctx.read(actor,
  "clientes/conversations/<id>")` devolve a ficha (mascarada) e o id; sem
  ficha, segue com `customer_*` como hoje. Para emitir, `GET
  clientes/customers/<id>/fiscal-recipient?reason=Venda nº …` (ou
  `fiscalRecipientFor` de `public.ts`, quando o núcleo tiver
  `optional_requires`) devolve o destinatário no formato do `recipient` do
  `FiscalProvider`, com registro de acesso. Nota autorizada:
  `recordFiscalDocument` (ou `POST clientes/fiscal-documents`) guarda o
  vínculo e o prazo. `onCustomerErase`: vendas sem nota apagam
  `customer_name/phone/document`; com nota autorizada guardam só o que a nota
  tem até `fiscal_retention_until`.
- **Mensalidade** (`mensalidade_payers`): coluna nova `customer_id` (nula).
  O pagador continua dono das regras de telefone autorizado; a ficha
  acrescenta os dados fiscais. Ao criar ou achar um pagador com documento,
  procurar a ficha pelo documento (rota de busca com `contacts:read`) e
  gravar o id; a tela do pagador mostra "Ver ficha". `onCustomerErase`:
  parcelas pagas guardam valor e datas (registro financeiro); o pagador perde
  nome, documento, e-mail e telefones; assinatura ativa é encerrada (decisão
  em aberto, abaixo).

## Regras da área (chave `clientes` de `PUT /settings`)

| Chave | Padrão | O quê |
|---|---|---|
| `reveal` | `"admin"` | `admin` ou `team`: quem da equipe revela |
| `consent_text` | texto padrão | Texto do aceite (20 a 1000) |
| `terms_version` | `"1"` | Versão do texto, gravada em cada aceite |
| `require_document` | `true` | CPF/CNPJ obrigatório no autocadastro |
| `require_address` | `false` | Endereço completo obrigatório (NF-e) |
| `erase_keywords` | `["EXCLUIR MEUS DADOS", "APAGAR MEUS DADOS"]` | Palavras que pedem a exclusão |
| `register_keywords` | `["MEU CADASTRO"]` | Palavras que mandam o link |
| `fiscal_retention_years` | `5` | Anos de guarda fiscal (5 a 10) |

## Rodada periódica

Com o módulo ligado: vence pedidos não confirmados em 48 horas, repete
exclusões pendentes e apaga guardas fiscais e vínculos de notas vencidos.
**Desligar o módulo com exclusão em andamento pausa a exclusão** até religar.

## Para as telas nativas (Android e iOS)

Mesmas rotas do painel, com a sessão `wabu_` da pessoa (veja
[API.md](API.md#cadastro-de-clientes)). O app mostra a tela só com `clientes`
em `GET /capabilities`.

1. **Lista** `GET /clientes/customers?q=&status=`: nome, tipo,
   `document_display`, primeiro telefone, município/UF. Paginação por
   `next_cursor`. Busca por nome ou CPF/telefone completos.
2. **Ficha** `GET /clientes/customers/{id}`: dados mascarados como vêm (não
   tente "desmascarar"); seções telefones, aceites, notas fiscais e o aviso de
   `erasure` aberto. Botões conforme `revealable` e `status`.
3. **Ver sem máscara**: folha com motivo obrigatório e campos marcáveis;
   mostra o resultado só enquanto a folha está aberta, **nunca guarda em
   cache, log, captura de tela permitida ou notificação** (no iOS, esconda o
   conteúdo ao ir para segundo plano; no Android, `FLAG_SECURE` na folha).
4. **Linha do tempo** `GET …/timeline`: lista por data com o módulo de cada
   item; tocar abre a tela do módulo pelo `ref_id` quando o app tiver.
5. **Na conversa** `GET /clientes/conversations/{id}`: cartão Cadastro com o
   botão Enviar link (`POST /clientes/invites`, com `Idempotency-Key`).
6. **Pedir exclusão** `POST …/erasure`: confirmação explicando que o
   cliente recebe a pergunta e só ele confirma. Cancelar pedido aberto:
   `POST /clientes/erasures/{id}/cancel`.
7. **Administrador**: histórico de exclusões (`GET /clientes/erasures`) e
   quem viu (`GET /clientes/access-log`).
8. Correção feita pela equipe (`PATCH`) manda só os campos digitados, com
   `expected_version`; `409 customer_conflict` pede reabrir.
9. Demonstração: o painel tem fichas fictícias em
   `web/modules/clientes/demo.ts`; use os mesmos formatos.
