# E-mail da instalação

O Vinki envia e-mail pelo **Cloudflare Email Sending**, pela API da Cloudflare, sem publicar o Worker de novo. Com o e-mail ligado:
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

## 3. Configurar no Vinki

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

| Mensagem no Vinki | Código da Cloudflare | O que fazer |
|---|---|---|
| A conta Cloudflare não tem o envio de e-mail liberado | 10105 | Assine o Workers Paid na conta do token |
| O envio de e-mail está desligado para este domínio | 10203 | Confira o domínio em Email Sending: verificado e com envio ligado |
| A Cloudflare suspendeu o envio de e-mail desta conta | 10207 | Veja o aviso no painel da Cloudflare |
| A Cloudflare recusou o token / O token não tem permissão | 10101, 10102, 10103 | Crie o token de novo com a permissão de envio de e-mail, na conta certa |
| A Cloudflare recusou o remetente ou o destinatário | 10202 | Use um remetente do domínio cadastrado |
| A Cloudflare limitou os envios por agora | 10004 | Espere alguns minutos |
| Devolvido (Últimos envios) | — | O endereço de destino não existe ou recusou. Confira o e-mail da pessoa |

Se o teste sai mas o e-mail cai no spam, confira os registros SPF, DKIM e DMARC do passo 1. Use também um nome de remetente reconhecível.

## Enviar conversa por e-mail

A primeira leva de canais acrescenta **Enviar conversa por e-mail** no menu e nos dados de uma conversa externa direta, na web e nos aplicativos. A ação exige `conversations:email` e acesso à conversa. Administradores começam autorizados; `*` não concede essa permissão a outras pessoas. Aplicações exigem os escopos explícitos de leitura e exportação e não podem usar o destino **Meu e-mail**. Bots, conectores e execução delegada não exportam.

O envio usa esta mesma configuração em **Gestão → Sistema → E-mail**. Sem configuração, a ação explica onde ativá-la. O administrador pode permitir endereço digitado (`transcript_custom_enabled`, inicialmente falso) e restringir domínios (`transcript_allowed_domains`). Lista vazia não acrescenta restrição de domínio; domínio permitido deve coincidir exatamente, após normalização. Um envio tem um destinatário, sem CC/BCC.

1. Escolha **Meu e-mail**, **E-mail do contato** ou um endereço digitado quando permitido.
2. Escolha **Este atendimento** ou um intervalo de datas. Histórico antigo sem sessão segura exige datas; não é exportado inteiro silenciosamente.
3. Confira destinatário, período, quantidade de mensagens, tamanho e avisos na prévia. Ela não envia e-mail e expira em dez minutos.
4. Para contato, confirme o endereço exibido e que o cliente pediu o envio. Endereço digitado também exige confirmação. Mudança de destinatário ou e-mail cadastral exige nova prévia.

A transcrição contém somente mensagens públicas nas direções `customer` e `outbound`, ordenadas por data e ID. Notas internas ficam sempre fora, inclusive para administrador e envio ao próprio e-mail. Mensagens apagadas aparecem como “mensagem apagada”. Anexos aparecem somente por tipo e nome, sem bytes, links privados, URL temporária ou token; documentos sensíveis/não visíveis aparecem como `[documento não incluído]`. Campos laterais como formulário, cobrança e check-in não são exportados. Destino digitado recebe CPF/CNPJ mascarados inclusive em cabeçalhos e nomes de arquivos. O HTML é escapado e não contém imagens remotas.

O assunto é `Conversa de atendimento · DD/MM/AAAA`. A prévia e o conteúdo usam o fuso da área. Os limites são 2.000 mensagens, 50.000 caracteres de texto e 200.000 de HTML; excesso pede intervalo menor, sem corte silencioso.

Há cota própria de **10 reservas por ator e 50 por área em 24 horas móveis**. Falhas também contam; replay da mesma chave não reserva de novo. A finalidade é `conversation.email`. Transcrições ficam fora da cota de 200 e-mails dos módulos. Avisos legados sem `module_id`, nas finalidades `billing`, `scheduling`, `order` e `booking`, continuam contando na cota dos módulos; o histórico não é reclassificado.

A chave idempotente é mantida enquanto a intenção de envio não muda; corpo diferente com a mesma chave dá conflito. Permissão e seleção são conferidas novamente no envio e no replay. O log, auditoria e nota interna usam destinatário mascarado e não guardam corpo ou endereço integral. O resultado pode ser enviado, na fila, devolvido, falhou ou **indeterminado**. Se houver queda após reserva/envio e antes da confirmação, o sistema não reenvia automaticamente: confira o resultado antes de criar outra intenção. Não há promessa de entrega remota exatamente uma vez.

O formato real de confirmação do provedor permanece registrado em [CANAIS-ZERNIO.md](CANAIS-ZERNIO.md). `provider_message_id` só será preenchido com campo documentado confirmado; não é inventado. O estado das provas está em [CANAIS-ACEITE.md](CANAIS-ACEITE.md).

## E-mail como canal de atendimento

A segunda leva acrescenta uma conexão própria de **E-mail**, mostrada pelo catálogo em `/app?canais=2` ou pela ativação na área. É diferente de **Enviar conversa por e-mail**: recebe mensagens como atendimento e oferece resposta com assunto e encadeamento, sem anexar transcrição automaticamente. Transcrição, módulos e avisos do Sistema conservam suas permissões, contratos e cotas.

O recebimento exige configuração manual **Email Routing → endereço exato → Worker desta instalação**, além do mesmo endereço na conexão Vinki. O instalador e o atualizador não configuram domínio, DNS/MX ou regra de recebimento, não pedem token de zona e não criam recurso Cloudflare adicional. Preserve os MX de Google, Microsoft ou outro provedor existente e valide o uso de subdomínio antes de alterá-los. Mantenha o nome do Worker; mudança exige revisar a regra.

Siga [CANAIS-EMAIL-RECEBIMENTO.md](CANAIS-EMAIL-RECEBIMENTO.md) para escolher domínio/endereço, configurar a regra, conferir o envio do Sistema e executar **Testar recebimento**. O desafio vale dez minutos e não abre atendimento. Teste expirado é inconclusivo; não ativa o canal. A conexão reutiliza o envio do Sistema e não recebe credencial SMTP ou token próprio.

**Limite atual:** o contrato REST de MIME, anexos, cabeçalhos e ID retornado ainda não foi confirmado com uma conta real. O transporte de produção do canal retorna `provider_contract_unverified`; envio do canal e entrega do desafio de recebimento ficam pendentes. O teste de envio do Sistema ou uma transcrição bem-sucedida não confirma esse contrato. A interface não pode habilitar essa hipótese.

Remetente de e-mail nunca prova identidade de cliente, mesmo com SPF/DKIM/DMARC recebidos, endereço cadastral ou junção humana. A equipe vê **Remetente não confirmado**; o bot, desligado por padrão, não recebe ficha, histórico privado ou dados de módulos. A confirmação automática é separada, desligada por padrão, e usa texto fixo sem dados de cliente. Automáticos, listas, devoluções, bloqueados e testes não abrem conversa nem disparam bot.

HTML vira texto por parser e não carrega recursos remotos. Bruto privado: até 25 MiB no runtime; parsing MIME: até 8 MiB, com quarentena acima disso. Anexos: até 32, sujeitos à política local de tipo/tamanho. Brutos processados são elegíveis à limpeza após sete dias; automático, bloqueado, quarentena ou erro, após trinta. Não há promessa de antivírus ou reentrega automática da Cloudflare após falha.

A finalidade `channel.email` tem 200 reservas por área em 24 horas móveis, dez por remetente/hora e, adicionalmente, uma confirmação automática por remetente/hora. Replay não reserva de novo. O assunto do canal aceita até 200 caracteres, incluindo número de pedido e URL, sem CR/LF/NUL; texto até 50.000. A restrição de assunto dos avisos de segurança descrita acima continua própria desses avisos. Resultado indeterminado não é reenviado automaticamente e aceitação HTTP não comprova entrega na caixa postal.

Confira os [formatos pendentes](CANAIS-FORMATOS-PENDENTES.md) e o [estado real do aceite da segunda leva](CANAIS-SEGUNDA-LEVA-ACEITE.md) antes de considerar a conexão operacional.
