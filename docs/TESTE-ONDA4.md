# Teste da onda 4 na instalação de teste

Este roteiro serve para testar, nos aparelhos e no painel, o que entrou no branch `integra/onda4`. Siga um item por vez. Cada item diz:
- o que precisa estar configurado antes;
- o que fazer;
- o que deve acontecer.

A instalação de teste hoje tem dados fictícios (área "Empresa Exemplo"). Ela não tem linha de WhatsApp, Mercado Pago nem e-mail. Os itens que dependem disso estão marcados.

## Antes de começar

- **Versão:** a instalação precisa estar com o `integra/onda4`. A versão aparece em Gestão → Sistema.
- **Módulos ligados** (Gestão → Módulos): Pedido, Mesas, Entrega, Mensalidade e OS. O Suporte é opcional.
- **Pessoas de teste** (Gestão → Pessoas e acessos):
  - "Garçom teste", com o papel Garçom;
  - "Entregador teste", com o papel Entregador;
  - "Atendente restrito", com acesso só à Fila.
- **Apps:** use builds dos apps com as telas novas. Um app antigo continua entrando enquanto a pessoa não tiver segundo fator, mas não mostra as telas novas.

## 1. Acesso por pessoa

**Precisa de:** nada além das pessoas de teste.

1. Entre no painel com "Atendente restrito" e confira que só a Fila aparece. Abrir outra área pelo endereço mostra que não há acesso.
2. Em Pessoas e acessos, edite a pessoa, marque mais itens ou um atalho de perfil e salve. Ela precisa entrar de novo; as áreas novas aparecem.
3. No app, entre com a mesma pessoa e confira que ele mostra só o que ela pode usar.
4. Na pessoa, ligue o horário de acesso com uma janela que já passou. Ao tentar entrar, a pessoa vê a mensagem de fora do horário. O administrador não tem horário.

## 2. Segundo fator

**Precisa de:** um aplicativo autenticador no celular, como Google Authenticator, Microsoft Authenticator ou 1Password.

1. No painel, abra **Minha conta** pelo menu da pessoa e clique em cadastrar o aplicativo autenticador.
2. Leia o QR ou digite o código no autenticador e confirme com o código de 6 dígitos. **Guarde os 10 códigos de recuperação.**
3. Saia e entre de novo. Depois da senha, o painel pede o código.
4. Teste "Perdi o celular: usar um código de recuperação" com um dos códigos. O mesmo código não vale duas vezes.
5. Em Pessoas e acessos, mude **Segundo fator** para "Exigido nas operações financeiras". Numa sessão aberta só com senha, uma ação da Mensalidade (criar plano, dispensar parcela) abre "Confirme que é você".
6. "Exigido para todos" só liga se o administrador já tiver o fator. Ao ligar, o painel avisa que apps antigos deixam de entrar. Outra pessoa sem fator só consegue cadastrar o dela.
7. Em Pessoas e acessos, na pessoa:
   - **Link para redefinir a senha:** gera um link de 24 h para copiar e enviar.
   - **Zerar segundo fator:** derruba as sessões dela.
8. Ao adicionar uma pessoa, marque "Convidar por link". O link abre "Crie sua senha".
9. **Apps:** só builds com o login em duas etapas pedem o código. Teste o app antigo com uma pessoa sem fator.
10. **Antes de encerrar:** volte a política para "Opcional" e zere o seu fator, se não for continuar usando.

**Não teste na instalação de teste:** "Esqueci a senha" com o código de instalação (`SETUP_TOKEN`). Ele troca a senha e tira o fator do único administrador.

## 3. Esqueci minha senha (por e-mail)

**Precisa de:**
- e-mail configurado em Gestão → Sistema → E-mail;
- plano Workers Paid na conta Cloudflare;
- um domínio com DNS na Cloudflare, cadastrado no Email Sending, com o token de envio.

O passo a passo está em [EMAIL.md](EMAIL.md). Sem isso, "Esqueci a senha" mostra só a recuperação do administrador.

1. Em Gestão → Sistema → E-mail, clique em **Enviar teste**. O e-mail chega no endereço da sua conta.
2. Na entrada, clique em **Esqueci a senha** e informe o e-mail de uma pessoa de teste que receba e-mail de verdade.
3. A tela responde igual para um e-mail que não existe.
4. O link vale 1 hora e uma vez só. Ao criar a senha nova, chega o aviso "Sua senha do Vinki foi trocada".
5. Convide uma pessoa com o e-mail ligado: o convite chega por e-mail.
6. Os últimos envios aparecem em Gestão → Sistema → E-mail.

## 4. Cartões do bot na conversa interna

**Precisa de:**
- um bot de IA com chave de provedor (OpenAI, DeepSeek ou Anthropic), em Gestão → Atendente e especialistas;
- o bot na conversa interna (Equipe → Conversas).

Não precisa de linha de WhatsApp. Cada pedido gasta créditos do provedor de IA.

1. Na conversa com o bot, peça: "Quais ordens de serviço estão abertas?". O bot consulta e responde.
2. Peça: "Abra uma OS do notebook que não liga para o telefone 11 99999-0000". Aparece um cartão com:
   - o que vai rodar, em destaque: a operação e os campos;
   - "Texto do bot (não conferido)", à parte;
   - os botões **Confirmar** e **Cancelar**.
3. Confirme. Aparece "Feito" e a OS nasce em nome de quem pediu. Repetir o toque não cria outra OS.
4. Com a política "Exigido nas operações financeiras", peça para criar um plano da Mensalidade. Ao confirmar sem o código, o painel pede o código e o cartão continua aberto. Depois do código, confirme de novo.
5. O cartão vence em 10 minutos.
6. Em Gestão → Sistema, "Bot e dados pessoais" fica desligado por padrão: o bot não vê telefone, documento nem endereço.

## 5. Aprovação de desconto

**Precisa de:**
- linha de WhatsApp ligada à área: o pedido nasce na conversa com o cliente;
- bot de IA com chave atendendo essa linha;
- Mensalidade com um plano e uma assinatura no telefone do cliente de teste.

A instalação de teste não tem linha hoje, então este item fica para quando houver.

1. Pelo WhatsApp do cliente de teste, peça ao bot desconto ou dispensa da mensalidade em aberto. O bot diz que vai consultar a equipe e não concede nada.
2. O cartão chega na conversa interna de quem pode decidir, e também por push. Ele mostra plano, valor, vencimento e parcelas pagas. O resumo do bot aparece à parte, como não verificado.
3. Teste **Aprovar** (com o valor do ajuste), **Recusar** e **Assumir a conversa**. O cliente recebe a resposta.
4. Com duas pessoas, decida ao mesmo tempo: só a primeira vale, e a outra vê quem decidiu.
5. Sem decisão, o pedido vence no prazo e a conversa vai para a equipe.

Os botões que o bot manda ao cliente (agendar, reservar e outros) também precisam de linha. O cliente vê o serviço, a data e o valor montados pelo módulo, com Confirmar e Cancelar. Só o toque, ou CONFIRMAR digitado, confirma; "sim" não confirma.

## 6. Mesas

**Precisa de:**
- Pedido ligado e com cardápio (a instalação de teste já tem);
- Mesas ligado;
- a pessoa "Garçom teste".

Não precisa de linha nem de pagamento online. Uso completo em [MESAS.md](MESAS.md).

1. Em **Mesas**, cadastre as mesas de uma vez: prefixo "Mesa", de 1 a 10.
2. Abra uma conta numa mesa e lance itens do cardápio. Os pedidos aparecem no quadro do Pedido, como "Mesa N".
3. Peça a conta, registre um pagamento parcial e divida por pessoas. Feche a conta: a mesa fica livre e os pedidos ficam pagos.
4. Teste também transferir de mesa, juntar duas contas e cancelar uma conta vazia.
5. Entre como "Garçom teste" no app ou no painel. O garçom opera as mesas sem acesso ao resto da gestão.

## 7. Entregador por QR

**Precisa de:**
- Pedido e Entrega ligados;
- endereço público https (a instalação de teste já tem, fixado no workers.dev);
- app do entregador (Android ou iOS) com a leitura de QR e permissão de localização.

O aviso de saída e o código de confirmação vão ao cliente pelo WhatsApp, então essa parte precisa de linha. Uso e privacidade em [ENTREGA.md](ENTREGA.md).

1. Crie um pedido com entrega (painel, Pedido).
2. Em **Entregas**, ou na via de entrega do pedido, gere o **QR do entregador**.
3. No app, leia o QR. O app entra sem login e vê só essa entrega: primeiro nome do cliente, endereço e itens.
4. Inicie a entrega. O pedido vai para "Saiu para entrega" e a posição aparece no painel, atualizada a cada minuto.
5. Teste a conversa da entrega com a loja e marque como entregue. Com o código de confirmação ligado, informe o código do cliente.
6. Gere outro QR para a mesma entrega: o anterior para de valer e o app recebe "Acesso encerrado".
7. Teste também o "Entregador teste" com login: ele vê as entregas dele.

## O que reportar

Para cada item, diga se funcionou ou o que apareceu de diferente, com o aparelho e a versão do app. Para erros na tela, mande o print com a mensagem.
