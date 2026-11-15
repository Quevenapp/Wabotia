# Suporte pago

Para quem vende suporte técnico: o atendimento humano só depois de conferir
o pagamento. O cliente escolhe **Atendimento humano (pago)** no menu do
WhatsApp; o Wabotia reconhece quem paga, confere a mensalidade e passa para a
equipe quem está em dia. Quem não está pode pagar ali mesmo, comprar suporte
avulso ou contratar um plano mensal. A IA continua grátis. API em
[API.md](API.md#suporte-pago-módulo-suporte).

## Ligar

1. **Gestão → Módulos**: ligue **Suporte pago** e **Mensalidade** (sem a
   Mensalidade, só o suporte avulso é oferecido e não há identificação por
   telefone).
2. **Gestão → Cobrança**: configure o Mercado Pago ([COBRANCA.md](COBRANCA.md)).
   Sem ele, nada é vendido pelo WhatsApp.
3. **Mensalidades → Planos e regras**: marque **Vender pelo WhatsApp** nos
   planos mensais oferecidos.
4. **Suporte pago → Regras do suporte**: setor que recebe a conversa,
   identificação, pacotes avulsos (preço e validade: até o protocolo fechar ou
   por horas), planos oferecidos, formas de pagamento, carência e textos.
5. **Menus e ações**: por exemplo, um submenu **Falar com atendente** com
   **Falar com a IA (grátis)** (item de bot) e **Atendimento humano (pago)**
   (item deste módulo).

## Como o cliente é atendido

1. **Identificação.** Pelo telefone da conversa, entre os telefones
   autorizados dos pagadores (Mensalidades → Pagadores). Se não achar, pede o
   CPF ou CNPJ de quem paga, com os dígitos conferidos (aceita o CNPJ com
   letras), em até 3 tentativas (configurável).
2. **CPF/CNPJ vindo de telefone não vinculado.** Por padrão libera e a
   conversa chega ao atendente com o aviso "telefone não vinculado ao pagador
   X"; em **Dados da conversa → Suporte pago**, **Vincular ao pagador**
   autoriza o número com um toque. No modo **só telefone vinculado**, a
   conversa vai para a equipe confirmar antes (**Confirmar e liberar**).
3. **Situação** (Mensalidade, com a carência das regras):
   - **em dia**: liberado;
   - **em atraso**: o cliente paga a parcela em aberto (Pix ou link) e é
     liberado quando o pagamento é confirmado;
   - **sem assinatura**: escolhe **Suporte avulso** (pacotes) ou **Plano
     mensal** (planos vendáveis). Sem cadastro, informa CPF/CNPJ e nome; o
     plano cria o pagador e a assinatura e cobra a primeira parcela na hora.
4. **Pagamento** pela Cobrança: Pix copia e cola na conversa ou link de
   pagamento (cartão e outros meios). "Já paguei" ou um comprovante enviado
   pelo cliente **não libera**: só o webhook do Mercado Pago, depois da
   consulta do pagamento. Enquanto espera, o cliente responde 1 para receber o
   código de novo ou 2 para trocar a forma.
5. **Liberação.** Fica gravado quem foi liberado, como (assinatura em dia,
   mensalidade paga, avulso, cortesia, confirmado pela equipe), por qual
   pagador e até quando, e a conversa vai para o setor configurado com um
   resumo para o atendente.
6. **Cortesia.** O atendente (com a conversa assumida) ou um administrador
   libera sem pagamento em **Dados da conversa → Suporte pago**, com motivo.

**Suporte pago → Suporte pago** lista as liberações e as compras avulsas,
com filtro, e busca pagadores.

## O que ainda depende do núcleo

- **Passagem para humano pela interface dos módulos** (`ctx.handoff`): hoje o
  módulo usa a mesma passagem do item de menu "humano" do núcleo; ao chegar
  `ctx.handoff`, troca sozinho (`src/modules/suporte/handoff.ts`).
- **Condicionar toda passagem automática para humano**: sem o gancho do
  núcleo, o cliente ainda consegue pedir um humano ao bot de IA ou por outro
  item "humano" do menu. A regra está pronta (`handoffGate`): libera com
  liberação ativa ou pagador em dia.
- **Pix direto** (chave Pix da empresa, confirmado pela equipe): entra como
  terceira forma de pagamento quando a Cobrança tiver.
- **`requires` entre módulos**: hoje o Suporte importa a Mensalidade direto
  (`src/modules/mensalidade/public.ts`) e confere se ela está ligada.

## O que só uma conta real confirma

Os testes simulam o Mercado Pago e não enviam nada ao WhatsApp. Antes de
vender, confira numa linha Zernio e numa conta do Mercado Pago reais: a lista
de opções e de formas de pagamento, o Pix e o link chegando na conversa, a
confirmação pelo webhook liberando a conversa e o resumo que o atendente vê.
