# WhatsApp: mídias, grupos e ligações

Disponível a partir de 0.5.0. As telas deste guia usam dados fictícios. Os testes automatizados usam provedores simulados; o teste com seu número real é a última etapa.

## Primeiro, atualize os dois lados

1. Faça backup e abra **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Espere a confirmação e reabra o painel. A migração adiciona tabelas e campos, preservando conversas, agenda e credenciais.
2. **Meta direto:** o canal recebe o código novo com o Worker. Confira as assinaturas do webhook no aplicativo Meta.
3. **QR direto:** atualize também o processo externo. O botão do painel não atualiza o computador/VPS. Pause a conexão, confira Entregas, pare o conector, faça backup e siga [atualização QR](../connectors/qr/README.md#atualizar-sem-perder-a-sessão).
4. **WhatsApp pelo Hermes:** atualize o transporte e a extensão compatível com o gateway parado. Preserve perfis, bots e diários; siga [o roteiro Hermes](../connectors/hermes/README.md#atualização-050).
5. Não ligue dois consumidores para o mesmo número. Depois da atualização, o conector informa os recursos que oferece. Conector antigo precisa ser atualizado antes de usar as funções novas.

## O que cada modo oferece

| Recurso | Meta direto | QR direto | Pelo Hermes |
|---|---|---|---|
| Imagem, vídeo, áudio e documento | Sim | Sim | Conforme adaptador instalado |
| Voz gravada no painel | OGG/Opus | OGG/Opus | Conforme adaptador; QR Hermes pode converter áudio |
| Figurinha WebP | Sim | Sim | Meta Hermes |
| Responder citando e reagir | Sim em conversa individual | Sim | Citação/reação na Meta Hermes |
| Editar/apagar mensagem enviada | Não disponível na API Meta | Sim, sujeito às regras do WhatsApp | Só se anunciado pelo adaptador |
| Marcar como lida e recibos | Sim | Sim | Não presumido; depende do gateway |
| Localização e cartão de contato | Sim em conversa individual | Sim | Meta Hermes; localização conforme adaptador |
| Grupos existentes, convite e administração | Grupos empresariais elegíveis | Sim, conforme permissões do número | Entrega de mensagens; sem administração de grupos pelo painel |
| Ligação de voz por atendente | Calling API habilitada e elegível | Não | Não; use Meta direto |
| Videochamada | Não | Não | Não |

Isso não inclui Status, Comunidades, transmissões, enquetes, pagamentos nem todas as funções do aplicativo pessoal. A Meta pode recusar uma função conforme o número, país, permissões e regras atuais. O modo QR depende do Baileys e do processo externo permanecer ligado.

## Enviar e receber arquivos

1. Abra **Conversas** e selecione o atendimento. Clique **Assumir conversa**. Isso pausa a IA e invalida respostas antigas ainda em preparação.
2. Clique **Anexar**, escolha até dez arquivos e, se desejar, escreva a legenda. Use **Automático pelo arquivo** ou **Enviar como documento**. Cada anexo gera uma mensagem; áudio e figurinha recebem o texto em uma mensagem separada.
3. Clique **Enviar**. O painel mostra o nome do arquivo e a porcentagem de upload. Arquivos maiores são enviados em partes, sem expor o bucket R2.
4. **Na fila** significa que o Wabotia recebeu o pedido. **Enviada** significa confirmação do provedor. **Entregue**, **Lida** e **Ouvida** dependem dos recibos disponibilizados pelo canal e pelas configurações do destinatário.
5. Na mensagem recebida, reproduza vídeo/áudio no próprio painel ou clique no nome para baixar. O arquivo exige login/permissão; não há link público permanente.

![Mídias e resposta citada com dados fictícios](screenshots/26-whatsapp-midias.jpg)

**Voz:** clique **Gravar áudio**, permita o microfone no navegador, grave por até dois minutos, pare, ouça a prévia e envie. O gravador produz OGG/Opus no navegador. Pode descartar a gravação antes de enviar. A primeira permissão depende do navegador; use HTTPS.

**Citação e ações:** use a seta na mensagem para responder a ela. O ícone de rosto abre reações. Editar, apagar e marcar como lida aparecem somente quando o canal oferece a ação. Edição de texto tem limite de 15 minutos no Wabotia e ainda está sujeita à aceitação do WhatsApp. Apagar no canal não apaga o registro de auditoria do atendimento.

**Localização/contato:** escolha o tipo no seletor. A localização usa coordenadas preenchidas por você; não rastreia o celular. Um cartão de contato enviado no WhatsApp é diferente do cadastro na agenda Wabotia.

### Limites de envio

| Conteúdo | Meta | QR direto no Wabotia |
|---|---|---|
| Imagem | JPG/PNG, até 5 MiB | Até 20 MiB |
| Vídeo | MP4/3GP, H.264/AAC, até 16 MiB | Até 100 MiB; prefira MP4 compatível |
| Áudio | AAC/M4A/MP3/AMR/OGG Opus, até 16 MiB | Até 100 MiB, conforme formato aceito pelo WhatsApp |
| Voz | OGG/Opus, até 16 MiB | OGG/Opus, até 16 MiB |
| Documento | PDF, TXT e Office aceitos pela Meta, até 100 MiB | Até 100 MiB |
| Figurinha | WebP 512 × 512; estática 100 KiB, animada 500 KiB | WebP 512 × 512, até 1 MiB |

O upload Wabotia aceita até 100 MiB; o canal pode impor um limite menor. O Wabotia não converte automaticamente vídeos nem documentos. O provedor ainda valida os codecs reais. Uploads incompletos expiram após 24 horas. Telegram tem limite de download de 20 MiB pela Bot API e envio de até 50 MiB neste conector. Importação de conhecimento continua com seus próprios limites.

**Se ocorrer uma falha:** o rascunho permanece. Um pedido já formado guarda a mesma identificação para repetição segura. Se aparecer **Sem confirmação**, confira **Entregas** e o WhatsApp antes de reconciliar; não crie outra mensagem para contornar o aviso. Falha de download de mídia recebida aparece na conversa e pode exigir reenvio do cliente.

## Grupos

### QR direto

1. Abra **Grupos WhatsApp**, selecione a conexão e clique **Buscar grupos**. Espere a operação terminar. O conector precisa estar ligado.
2. Pode abrir um grupo existente, criar um grupo com os participantes informados ou entrar por link de convite autorizado.
3. Dentro da conversa, escolha quando a IA responde: **Somente atendimento humano**, **Quando mencionada ou /bot** (padrão), ou **Todas as mensagens**. O controle de atendimento humano continua valendo: retome a IA quando quiser que o bot responda.
4. Atualize os dados do grupo antes de administrá-lo. Nome, descrição, convite, participantes e modo somente administradores dependem das permissões do próprio número no WhatsApp.
5. Confira o resultado por participante: a criação ou adição pode ser parcialmente aceita. Restrições de privacidade podem exigir convite. Grupo não é salvo como uma pessoa na agenda.

![Grupos com dados fictícios](screenshots/27-whatsapp-grupos.jpg)

### Meta direto

A Groups API exige conta comercial oficial elegível (OBA) e não oferece os mesmos grupos do WhatsApp pessoal. Na referência consultada, os grupos têm até oito participantes, uma empresa Cloud API e entrada por convite. Não é o recurso de coexistência com o aplicativo WhatsApp Business.

Marque **Grupos Meta habilitados na minha conta** na conexão somente depois de confirmar a elegibilidade. Assine os eventos de grupos no aplicativo Meta, além de `messages`. Use Buscar grupos/Criar grupo e obtenha o convite. Participantes entram pelo link; o painel permite remover participantes. Não há chamadas, mensagens interativas nem editar/apagar no grupo Meta.

Pelo Hermes, a política normal de entrada de grupos pode filtrar a mensagem antes de chegar ao Wabotia. Configure os grupos permitidos no Hermes. A extensão não transforma o Hermes em administrador completo de grupos. O comando `/bot` funciona somente se a mensagem for encaminhada ao Wabotia.

## Ligações de voz pela Meta

1. Use **WhatsApp direto pela Meta**. Na conta Meta, confirme acesso à Calling API, país/número elegível e as permissões do token. A documentação de produção consultada exige nível de mensagens de pelo menos 2.000 destinatários únicos por dia. A Meta é a fonte final de elegibilidade e limites.
2. No aplicativo Meta, cadastre a URL já exibida no Wabotia e assine **calls**, além de **messages**. Configure o segredo do aplicativo para validar as assinaturas. Não crie outro consumidor do número.
3. No Wabotia, abra **Conexões** e clique **Habilitar ligações de voz** na conexão Meta. A ação habilita Calling API com WebRTC; SIP fica desativado neste modo.
4. Abra uma conversa individual e assuma. Clique **Verificar permissão**. Se necessário, **Pedir permissão** envia ao cliente a solicitação para ligar. Para esse pedido, a janela de atendimento precisa estar aberta por uma mensagem recente do cliente.
5. Quando a Meta autorizar, clique **Ligar**. Permita o microfone. Use o controle de áudio, silenciar e **Encerrar**. Cobranças e limites da Meta continuam aplicáveis.
6. Quando o cliente ligar, o painel mostra o aviso e o menu **Ligações**. Abra o atendimento e escolha **Atender com microfone** ou **Recusar**. Só um responsável pode assumir a ligação.

![Controles de ligação com dados fictícios](screenshots/28-whatsapp-ligacoes.jpg)

O áudio passa por WebRTC entre navegador e a infraestrutura da Meta, não pelo Worker. Mantenha a conversa aberta; sair dela fecha o áudio e solicita encerramento. Se o navegador cair, o servidor solicita encerramento após aproximadamente 90 segundos sem sinal de presença. A rede precisa permitir WebRTC; VPN/firewall podem impedir o áudio. Nenhuma gravação da ligação é armazenada por este recurso.

**Sem confirmação:** aguarde o webhook. Só use **Confirmar encerramento** depois de verificar no WhatsApp que a chamada terminou. Isso corrige o registro; não desliga uma chamada ainda ativa. O Wabotia não inicia outra chamada automaticamente após timeout. Videochamadas e telefonia via QR não estão implementadas porque os caminhos usados não as oferecem.

## Teste final com seu número

Use destinatários e grupo de teste autorizados. Registre modo, versão do conector e resultado de cada item:

- Receber e enviar imagem, vídeo MP4, documento e áudio; gravar voz e ouvir dos dois lados. Testar arquivo maior que 20 MiB somente no tipo/canal que permitir.
- Citar, reagir, marcar como lida, editar/apagar no QR e verificar recibos sem duplicidade.
- Desligar/religar o QR e receber mensagens enviadas enquanto estava offline, preservando sessão e ordem.
- Testar grupos: participantes distintos, menção, `/bot`, IA desligada, atendimento humano e restrições de administrador.
- Na Meta elegível: permissão negada/concedida, ligar, atender, recusar, silenciar e encerrar; fechar o navegador e conferir a recuperação.
- Assumir a conversa durante resposta da IA: nenhuma resposta antiga deve sair depois da tomada humana.
- Repetir a mesma requisição API, conferir conflito com conteúdo diferente e negar a chave sem permissão. Reenviar o mesmo webhook assinado sem duplicar efeito.

Não marque um teste como homologado apenas porque o pedido entrou na fila ou porque uma simulação passou.

## Referências e API

[API Wabotia](API.md#whatsapp-mídias-grupos-e-ligações) · [Calling API Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/) · [Grupos Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/) · [Voz na coleção oficial Meta](https://www.postman.com/meta/whatsapp-business-platform/request/goznbg0/send-audio-message-by-id). Referências consultadas em 06/11/2026; regras do provedor podem mudar.
