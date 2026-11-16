# E-mail da instalação

O Wabotia envia e-mail pelo **Cloudflare Email Sending**, pela API da Cloudflare, sem publicar o Worker de novo. Com o e-mail ligado:
- a equipe usa "Esqueci a senha" na entrada do painel;
- convites e links de nova senha chegam por e-mail;
- cada pessoa recebe um aviso quando a senha ou o segundo fator dela mudam;
- módulos podem mandar e-mail ao cliente que autorizou a finalidade (`ctx.sendEmail`, em [MODULOS.md](MODULOS.md)).

Sem e-mail, tudo continua funcionando. O administrador gera os links em Pessoas e acessos e envia por outro meio.

## Antes de começar

- **Plano Workers Paid** na conta Cloudflare. Sem ele, o teste mostra "A conta Cloudflare não tem o envio de e-mail liberado" (código 10105).
- **Um domínio com o DNS na Cloudflare.** O envio sai de um endereço desse domínio, por exemplo `nao-responda@suaempresa.com.br`. Um subdomínio só para envio, como `avisos.suaempresa.com.br`, separa a reputação do e-mail da empresa.
- O Email Sending está em beta na Cloudflare. Nomes de menus e permissões podem mudar. Confira na tela e siga a documentação da Cloudflare se algo estiver diferente.

## 1. Cadastrar o domínio

1. No painel da Cloudflare, abra **Compute → Email Service → Email Sending**.
2. Clique em **Onboard Domain** e escolha o domínio (ou subdomínio).
3. A Cloudflare cria os registros de DNS. Confira se apareceram:
   - um **MX** e um **TXT (SPF)** em `cf-bounce.<seu domínio>`, para as devoluções;
   - um **TXT (DKIM)**, a assinatura dos e-mails;
   - um **TXT (DMARC)** em `_dmarc.<seu domínio>`, se ainda não existir.
4. Espere o domínio aparecer como verificado. Costuma levar alguns minutos.

Se o domínio já tem um registro DMARC, mantenha o seu e confira se ele aceita o envio pela Cloudflare.

## 2. Criar o token de API

1. Em **Meu perfil → Tokens de API**, clique em **Criar token** e depois em **Criar token personalizado**.
2. Dê um nome, por exemplo `wabotia-email`.
3. Em **Permissões**, escolha **Conta**, depois **Email Sending** e **Edit**. Se a tela mostrar outro nome para a permissão de envio, escolha a que permite enviar e-mail.
4. Em **Recursos da conta**, escolha só a conta do domínio.
5. Crie o token e copie o valor. Ele aparece uma vez só.

Use um token só para o e-mail. Não reaproveite o token de publicação do Worker nem a chave global.

## 3. Configurar no Wabotia

1. No painel, abra **Gestão → Sistema → E-mail**.
2. Preencha:
   - **Account ID**: aparece na página inicial da conta na Cloudflare (32 caracteres). Se a autorização Cloudflare do Sistema já está feita, o campo vem preenchido.
   - **Token de API**: o do passo 2. Fica guardado cifrado com a `MASTER_KEY` e não volta a aparecer.
   - **Endereço do remetente**: um endereço do domínio cadastrado, por exemplo `nao-responda@suaempresa.com.br`.
   - **Nome do remetente** (opcional): por exemplo, o nome da empresa.
3. Clique em **Salvar e-mail** e depois em **Enviar teste**. O teste vai para o e-mail da sua conta. Confira a caixa de entrada e o spam.

Para desligar, use **Desligar e-mail**. O token é apagado.

## O que vai por e-mail

| E-mail | Quando | Validade do link |
|---|---|---|
| Redefinir senha | "Esqueci a senha" na entrada, ou o administrador pede o link com o e-mail ligado | 1 hora (esqueci a senha) ou 24 horas (administrador), uma vez só |
| Convite | O administrador convida uma pessoa | 72 horas, uma vez só |
| Senha trocada | Pelo link, pelo administrador ou pela recuperação com o `SETUP_TOKEN` | Sem link |
| Segundo fator removido | Pelo administrador ou pela própria pessoa | Sem link |

Regras de segurança:
- O assunto nunca leva link nem código. O link vai no corpo, com o código depois de `#`, que não chega aos servidores no caminho.
- "Esqueci a senha" responde igual exista ou não a conta, para não revelar quem tem cadastro.
- Pedidos repetidos têm limites: 5 a cada 10 minutos por endereço de rede e 3 por hora por conta.
- O registro de envios (Gestão → Sistema → E-mail → Últimos envios) guarda o endereço mascarado, a finalidade e a situação. Não guarda o texto.

## Problemas

| Mensagem no Wabotia | Código da Cloudflare | O que fazer |
|---|---|---|
| A conta Cloudflare não tem o envio de e-mail liberado | 10105 | Assine o Workers Paid na conta do token |
| O envio de e-mail está desligado para este domínio | 10203 | Confira o domínio em Email Sending: verificado e com envio ligado |
| A Cloudflare suspendeu o envio de e-mail desta conta | 10207 | Veja o aviso no painel da Cloudflare |
| A Cloudflare recusou o token / O token não tem permissão | 10101, 10102, 10103 | Crie o token de novo com a permissão de envio de e-mail, na conta certa |
| A Cloudflare recusou o remetente ou o destinatário | 10202 | Use um remetente do domínio cadastrado |
| A Cloudflare limitou os envios por agora | 10004 | Espere alguns minutos |
| Devolvido (Últimos envios) | — | O endereço de destino não existe ou recusou. Confira o e-mail da pessoa |

Se o teste sai mas o e-mail cai no spam, confira os registros SPF, DKIM e DMARC do passo 1. Use também um nome de remetente reconhecível.
