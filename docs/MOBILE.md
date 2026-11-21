# Aplicativos Android e iOS

Os aplicativos nativos **Vinki** para Android (Kotlin/Jetpack Compose) e iOS (Swift/SwiftUI) ficam em [`mobile/android`](../mobile/android) e [`mobile/ios`](../mobile/ios). Eles são clientes da mesma API REST do painel e funcionam com **qualquer instalação Vinki**: na primeira tela a pessoa digita o endereço do seu servidor (por exemplo `wabotia.queven.com.br` ou `wabotia.fagoo.com.br`), depois entra com o e-mail e a senha de atendente cadastrados em **Pessoas**.

Quem ainda não tem um servidor pode tocar em **Conhecer o app (demonstração)** na mesma tela: o app abre uma instalação fictícia, em memória, com dados de exemplo (fila, conversas, protocolos, equipe, ligações). Nenhuma chamada sai do aparelho, nenhuma conta é criada, o aparelho não é registrado para notificações e uma faixa no topo de todas as telas avisa que é demonstração, com **Sair** para voltar à primeira tela. É também o caminho para a revisão das lojas sem depender de uma conta no servidor de produção. Regras em [`mobile/README.md`](../mobile/README.md).

O que os aplicativos oferecem:

- **Conversas:** fila, atendimentos próprios, conversas com a IA e concluídas; assumir, transferir para outro atendente, devolver à IA, concluir, notas internas e etiquetas.
- **Mensagens WhatsApp:** texto, fotos e vídeos da galeria ou câmera, documentos, áudio gravado (OGG/Opus), localização atual do aparelho, cartão de contato, citação, reação, editar/apagar/marcar como lida conforme o canal, recibos de entrega e leitura.
- **Ligações:** histórico das ligações registradas. Os aplicativos não iniciam nem atendem ligações desde a 0.17.0.
- **Protocolos:** abertos, em andamento, atrasados e concluídos; andamento público, prazo da primeira resposta, responsável e conclusão.
- **Bots:** conversar com os bots habilitados no perfil (execuções da Equipe Bot) e acompanhar resultados e anexos.
- **Notificações push:** novas mensagens, atendimentos na fila, transferências, protocolos abertos, protocolos vencendo ou atrasados.
- **Disponibilidade:** marcar presença e ausência.
- **Atendimento do dia:** os módulos básicos ligados na área (fila de senhas, agenda, mensalidades, reservas, mesas, entregas, pedidos, ordens de serviço), caixa simples, cadastro básico de clientes e equipamentos (painéis de senha e impressora). O ERP fica no navegador; no celular, consulta-se pelo assistente (seção 6).

Este guia descreve a parte do servidor (autenticação móvel, dispositivos e push), o gateway de notificações e como compilar os aplicativos. A homologação em aparelhos reais com número WhatsApp real continua sendo a etapa final com o proprietário.

## 1. Atualize o servidor

Os aplicativos exigem a versão **0.8.0** ou superior do Vinki. Atualize em **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. A migração `0008_mobile.sql` é aditiva: cria as tabelas de dispositivos, cursores de push e alertas de protocolo e acrescenta colunas à tabela de sessões. Conversas, agenda, credenciais e histórico são preservados.

## 2. Autenticação móvel

O painel web usa cookie de sessão com verificação de origem. Os aplicativos usam um **token de sessão de usuário** (`Authorization: Bearer wabu_...`), diferente das chaves de aplicação (`Bearer` das integrações servidor-servidor). O token identifica uma pessoa cadastrada em **Pessoas**, com os mesmos perfis e papel do painel; aplicações continuam sem registrar presença ou operar como humanos.

| Método e rota | Uso |
|---|---|
| `GET /api/health` | Confirma que o endereço é um servidor Vinki (`service: "wabotia"`, versão). |
| `GET /api/auth/status` | `initialized` e `configured`; um servidor sem administrador orienta a concluir a instalação pelo navegador. |
| `POST /api/auth/mobile/login` | Corpo `{email, password, device:{platform:"android"\|"ios", name, app_version}}`. Retorna `{token, expires, user:{id,name,email,role,profiles}}`. Limite de 10 tentativas por IP a cada 10 minutos. |
| `POST /api/v1/auth/mobile/refresh` | Troca o token atual por um novo (o antigo é revogado) e estende a validade por 30 dias. Use quando faltar menos de 7 dias. |
| `POST /api/v1/logout` | Revoga o token atual (também funciona com Bearer). Remova o dispositivo antes de sair. |
| `GET /api/v1/me` | Identidade autenticada. |

O token tem 30 dias; expira sem uso. É armazenado apenas como hash no servidor e, no aparelho, no Keychain (iOS) ou em `EncryptedSharedPreferences` (Android). Escritas pelo token móvel não exigem cabeçalho `Origin`. Todas as outras rotas da [API](API.md) funcionam da mesma forma que no painel, inclusive `Idempotency-Key` nas escritas.

## 3. Dispositivos e notificações push

Cada instalação do aplicativo gera um identificador próprio (UUID) e registra o token do provedor após o login e sempre que o token muda. No modo de demonstração nada disso acontece: não há servidor, o aparelho nunca é registrado e o app não pede permissão de notificações.

| Método e rota | Uso |
|---|---|
| `PUT /api/v1/devices/{id}` | Cria ou atualiza o dispositivo da pessoa autenticada: `{platform, provider:"fcm", token, name, app_version, profiles:[], enabled:true}`. `profiles` vazio recebe de todos os perfis autorizados. Não exige `Idempotency-Key`. |
| `GET /api/v1/devices` | Dispositivos da própria pessoa. |
| `DELETE /api/v1/devices/{id}` | Remove o dispositivo (chame antes de sair da conta). |
| `POST /api/v1/devices/{id}/test` | Envia uma notificação de teste para esse dispositivo. |

### O que é notificado

| Evento | Quem recebe | Conteúdo |
|---|---|---|
| `message.received` em conversa com atendente | O responsável | Nome ou telefone e prévia do texto (ou "Anexo") |
| `message.received` em conversa na fila | Todas as pessoas do perfil | Idem |
| `conversation.updated` com `state: waiting` | Todas as pessoas do perfil | "Novo atendimento na fila" |
| `conversation.updated` com `action: transfer` | O novo responsável | "Atendimento transferido para você" |
| `ticket.created` | Responsável ou todas as pessoas | "Protocolo WA-… aberto" |
| `ticket.updated` | Responsável (exceto quem alterou) | O que mudou: "Protocolo atribuído a você", novo estado ou novo andamento; sem mudança relevante, nada é enviado |
| Protocolo vencendo (sem primeira resposta) | Responsável ou todas as pessoas | "Protocolo WA-… vence em N min" |
| Protocolo atrasado | Responsável ou todas as pessoas | "Protocolo WA-… atrasado" |
| `call.updated` com `status: ringing` | Todas as pessoas do perfil | "Ligação recebida", prioridade alta, categoria `CALL` |

Mensagens em conversas com a IA e conversas concluídas não geram push. Cada notificação carrega `data` com `type` (`message`, `queue`, `transfer`, `ticket`, `ticket_due`, `call`, `test`), `profile_id`, `conversation_id`, `ticket_id`, `call_id` e `server` para abrir a tela correta. O aplicativo em primeiro plano usa a consulta de eventos (`GET /profiles/{perfil}/events?after=`) e não depende do push.

A entrega é feita pelo coordenador de cada perfil a partir da tabela `events`, com cursor em `push_cursors`, registro em `push_log` e deduplicação dos alertas de prazo em `ticket_alerts`. Na atualização para 0.8.0 o cursor começa no fim do histórico (nada antigo é reenviado) e eventos com mais de 10 minutos são ignorados. Cada execução envia no máximo 20 segundos de notificações e continua no ciclo seguinte. Um token recusado pelo provedor como inexistente (`UNREGISTERED`) desativa o dispositivo; outros erros só ficam registrados em `last_error`. Falhas de rede não geram repetição automática da mesma notificação. Registros de `push_log` com mais de 7 dias são apagados pelo cron. Cada pessoa pode ter até 10 dispositivos (os mais antigos são removidos) e o registro é limitado a 30 chamadas por minuto.

Os eventos `conversation.updated` (ação `transfer`) passam a trazer `owner` e `actor`; `ticket.updated` traz `actor`, `number`, `previous_status`, `owner`, `previous_owner` e `text_added`. São campos aditivos, também entregues aos webhooks das integrações.

### Modo de envio: gateway ou FCM direto

O aplicativo publicado nas lojas pertence a um único projeto Firebase. Para que **qualquer servidor** envie notificações sem receber as credenciais desse projeto, o servidor envia as notificações para um **gateway de push** que guarda as credenciais e as repassa ao Firebase Cloud Messaging (Android e iOS/APNs). O gateway é um Worker Cloudflare em [`push-gateway/`](../push-gateway), operado pela Queven em `https://push.wabotia.queven.app`. Quem compilar o próprio aplicativo pode operar o próprio gateway ou configurar FCM direto.

Em **Sistema e atualizações → Notificações dos aplicativos**, o administrador escolhe:

| Campo | Valores |
|---|---|
| Modo | `off` (sem push), `gateway` (padrão), `fcm` (conta de serviço própria) |
| URL do gateway | Padrão `https://push.wabotia.queven.app` |
| Conta de serviço FCM | JSON da conta de serviço com papel *Firebase Cloud Messaging API Admin*; somente no modo `fcm`; guardado criptografado e nunca exibido |
| Conteúdo | `preview` (nome e trecho da mensagem) ou `minimal` (apenas "Nova mensagem"); recomendado `minimal` ao usar um gateway de terceiros |
| Alerta de protocolo | Minutos antes do vencimento (padrão 60; 0 desativa) |

API correspondente: `GET /api/v1/system/push` e `POST /api/v1/system/push/configure` (administrador, `Idempotency-Key`), além de `POST /api/v1/system/push/test`.

Contrato do gateway (`POST {gateway}/v1/push`):

```json
{
  "messages": [
    {
      "token": "token FCM do aparelho",
      "platform": "android",
      "title": "Maria",
      "body": "Preciso de ajuda com o pedido",
      "data": { "type": "message", "profile_id": "…", "conversation_id": "…", "server": "https://wabotia.exemplo.com.br" },
      "priority": "high",
      "collapse_key": "conversa-…",
      "channel": "messages",
      "category": "MESSAGE",
      "time_sensitive": false
    }
  ]
}
```

Para `platform: "android"` o gateway (e o modo FCM direto) envia ao Firebase uma mensagem **só de dados** (`title` e `body` dentro de `data`, prioridade alta): o serviço do aplicativo monta a notificação no canal certo e, para ligações, mostra a tela cheia com Atender e Recusar mesmo em segundo plano. Para `platform: "ios"` vai o bloco `notification` com cabeçalhos APNs (`category`, `interruption-level`, `thread-id`).

Resposta: `{"results":[{"token":"…","status":"ok"|"unregistered"|"error","error":"…"}]}`. Até 100 mensagens por chamada; o gateway valida o formato dos tokens, limita por IP e não guarda o conteúdo. O gateway não autentica o servidor remetente (como os serviços de push de outros produtos auto-hospedados); por isso o modo `minimal` existe. Para exigir um segredo compartilhado, publique o gateway com `GATEWAY_SHARED_SECRET` e informe o mesmo valor na configuração do servidor.

Publicar o próprio gateway:

```sh
cd push-gateway
npm install
npx wrangler secret put FCM_SERVICE_ACCOUNT   # cole o JSON da conta de serviço
npx wrangler deploy
```

## 4. Compilar os aplicativos

### Android

Requisitos: JDK 17, Android SDK (plataforma 35, build-tools 35.0.0). O projeto usa Gradle Kotlin DSL com wrapper.

```sh
cd mobile/android
./gradlew assembleDebug          # Windows: gradlew.bat assembleDebug
```

Coloque o `google-services.json` do projeto Firebase em `mobile/android/app/`. Sem o arquivo, o aplicativo compila e funciona, mas não recebe push (o plugin do Google só é aplicado quando o arquivo existe). O pacote é `br.com.queven.wabotia`. A assinatura de publicação segue a chave de upload da conta Play do proprietário.

### iOS

Requisitos: macOS com Xcode 16 ou superior e [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`). Alvo mínimo iOS 15, incluindo iPhone 7. A camada `Core/Compatibility.swift` mantém controles equivalentes para navegação, galerias, compartilhamento e texto multilinha.

```sh
cd mobile/ios
xcodegen generate
xcodebuild -scheme Vinki -destination "generic/platform=iOS" -derivedDataPath build build
```

Coloque o `GoogleService-Info.plist` em `mobile/ios/Wabotia/Resources/`. O `project.yml` usa assinatura automática com a equipe configurada em `DEVELOPMENT_TEAM`. Ative no App ID as capacidades **Push Notifications** e **Background Modes → Remote notifications**.

## 5. Ordem de serviço nos aplicativos

Os dois aplicativos trazem a ordem de serviço por modelo, com as mesmas telas e as mesmas regras do painel. A entrada **Ordens de serviço** só aparece quando o módulo Ordem de Serviço está ligado na área e a conta da pessoa tem acesso (`GET /api/v1/capabilities`). Se um administrador desliga o módulo, qualquer rota responde `409 module_disabled`: a entrada some na hora e a tela diz que o módulo precisa ser ligado em **Gestão → Módulos**.

- **Lista:** filtros de modelo, busca (número, cliente ou item), situação (abertas, concluídas, canceladas, todas) e etapa. O filtro de etapa só aparece com um modelo escolhido. As ordens do modelo simples (`service_order`) abrem a ficha antiga, de estados fixos, que continua igual.
- **Abrir ordem:** escolher o modelo, buscar o cliente no cadastro, escolher o objeto do serviço (veículo, equipamento, imóvel, animal, evento) entre os do cliente ou cadastrar um novo, preencher os campos próprios do modelo (texto, número, Sim/Não, data e escolha), o item e a descrição. Um campo é obrigatório na abertura quando o modelo o marca como obrigatório ou quando a regra de etapa o exige desde a etapa inicial. Campos restritos (`sensitive`) não aparecem nem são enviados. Pelo atalho da conversa, a ordem já sai ligada à conversa do cliente.
- **Ficha:** avançar e voltar de etapa. Voltar e cancelar pedem um motivo, que fica no histórico. A ficha mostra o checklist de cada etapa: só a etapa atual é marcável, e o item que pede foto abre a câmera e envia a foto para os documentos da ordem antes de marcar. Também mostra os campos da ordem (com aviso dos que a próxima etapa vai pedir), o objeto, o histórico e o orçamento, só para leitura (itens, total e situação da aprovação). Quando a ordem está ligada a uma conversa e o servidor oferece o envio do orçamento (`next_statuses` contém `quoted`), aparece **Enviar ao cliente pelo WhatsApp**. Montar o orçamento, registrar a resposta do cliente, cobrança, notas e as demais abas ficam no painel.
- **Sem conexão:** a última lista e as fichas abertas ficam guardadas no aparelho (por área, apagadas ao sair da conta) e aparecem para leitura com o aviso da hora da cópia. Mudanças feitas sem conexão não ficam numa fila: a tela avisa que precisa de conexão e a pessoa tenta de novo quando a internet voltar.
- **Demonstração:** além das ordens simples, há dois modelos fictícios: uma oficina mecânica (ordens `OF-1` a `OF-5`), com veículo como objeto, checklist com foto na etapa "Recebido" e o campo "Mecânico responsável" pedido na etapa "Pronto", e uma assistência de celulares (`CEL-1` e `CEL-2`), com um campo restrito que não aparece. A busca de cliente encontra os contatos das conversas de exemplo (por exemplo, "Mariana Costa"). As ordens e as fotos ficam em memória, como as conversas. No simulador do iOS não há câmera: o item que pede foto mostra o aviso para liberar a câmera.
- **Depois de abrir:** a ficha da ordem nova abre em seguida (no iOS 15, a tela de abertura só fecha e a ordem aparece na lista).

Rotas usadas (todas em `/api/v1/profiles/{p}/`, escritas com `Idempotency-Key`):

| Rota | Uso |
| --- | --- |
| `GET service-orders/types`, `GET service-orders/types/{id}` | Modelos (etapas, campos, regras por etapa, checklist). `404` indica servidor antigo: o aplicativo usa só a lista simples. |
| `GET service-orders?type_id=&type_ids=&stage=&status=&open=&q=&cursor=` | Lista. |
| `GET service-orders/{id}?history=none`, `GET service-orders/{id}/history` | Ficha e histórico. |
| `GET contacts?q=&identity=all&namespace=team` | Busca do cliente no cadastro. |
| `GET service-orders/object-types`, `GET service-orders/objects?contact_id=&type_id=` | Objeto do serviço do cliente. |
| `POST service-orders` | Abrir a ordem (`type_id`, `extra`, `object` com `mode` `existing` ou `new`). |
| `PATCH service-orders/{id}` | Campos da ordem (`version`, `extra`). |
| `POST service-orders/{id}/stage`, `POST service-orders/{id}/stage-approval` | Mudar de etapa (`transition_id`, `version`, `note`). |
| `GET service-orders/{id}/requirements?transition_id=` | Campos que faltam quando a etapa recusa com `missing_fields`. |
| `POST service-orders/{id}/documents`, `PUT {upload_url}`, `POST service-orders/{id}/documents/{doc}/complete` | Foto do checklist (JPEG até 10 MB, lado maior até 1600 px; o `PUT` leva `Upload-Version` e `Idempotency-Key`; o `upload_url` só é seguido no mesmo servidor). |
| `GET service-orders/{id}/documents/{doc}/content` | "Ver foto" de um item já marcado (só com conexão). |
| `POST service-orders/{id}/checklist` | Marcar ou desmarcar item (`photo_document_id` quando o item pede foto). |
| `POST service-orders/{id}/quote/send` | Enviar o orçamento pelo WhatsApp (`notify: true`). |

## 6. O que fica no app e o que vai para a web e para o bot

Os aplicativos servem para o que dá para fazer sem computador: atender os canais, controlar os equipamentos (painéis de senha e impressoras) e os recursos básicos do dia. Tudo o que é avançado (ERP, relatórios, configurações dos módulos) fica no painel, no navegador, e no celular se consulta pelo bot. Exemplo que guia o desenho: um barbeiro com o painel de senha ligado no WhatsApp, a agenda, o caixa e o cadastro básico dos clientes, tudo pelo celular.

A aba **Atendimento** mostra, nas duas plataformas, a mesma lista (`ui/service/ServiceHub.kt` no Android, `ServiceHub` em `Features/Service/ServiceView.swift` no iOS):

| Grupo | Entrada | Aparece quando |
| --- | --- | --- |
| Módulos da área | Fila de senhas (guichê: chamar, rechamar, finalizar), Agenda, Mensalidades, Reservas, Mesas, Entregas, Pedidos, Ordens de serviço | o módulo está ligado na área (`queue`, `agenda`, `mensalidade`, `reserva`, `mesas`, `entrega`, `pedido`, `os`) |
| Do dia a dia | Caixa | a parte Financeiro do ERP (`erp-financeiro`) está ligada **e** a pessoa é administradora ou tem o papel `erp:financeiro` (o controle de caixa é do Financeiro) |
| Do dia a dia | Clientes, Equipamentos | sempre |
| Gestão | Perguntar ao assistente, Abrir no navegador | sempre (o navegador some na demonstração, que não tem painel) |
| Linhas e menus | Linhas de atendimento; Menus e Linhas dos bots | linhas sempre; menus e bots só para administrador |

"Administrador" é o `actor.role` que vem em `GET /api/v1/profiles/{p}/capabilities` (o papel atual); só sem ele (servidor antigo) vale o `user.role` gravado no login. Módulo desligado com a tela aberta: a rota responde `409 module_disabled`, a entrada some e a tela diz qual módulo ligar em **Gestão → Módulos**.

**O ERP saiu do app.** A antiga área Gestão (clientes do ERP, produtos e estoque, pedido rápido, contas) foi tirada das duas plataformas, com a demonstração e os testes dela. No lugar:

- **Perguntar ao assistente** abre a conversa interna com o bot da área (a mesma de Equipe → Bots, `internal-chats` com `bot:<id>`). Com um bot só ligado, a conversa abre direto; com mais de um, a pessoa escolhe. O bot consulta o ERP em linguagem natural com as operações de leitura que o administrador concedeu a ele no painel (Bots → acesso ao ERP). Sem bot ligado, a tela diz para criar um em **Gestão → Bots**.
- **Abrir no navegador** leva ao painel na tela certa: `/app/erp` (ou `/app/gestao/inicio` sem ERP). As telas do básico também têm o link para a versão completa: controle de caixa (`/app/erp/financeiro-empresa?area=controle-caixa`), mesas (`/app/gestao/mesas`), entregas (`/app/gestao/entregas`) e filas e painéis (`/app/gestao/filas`).
- Quem atualizar o app perde a cópia sem conexão da antiga Gestão: no Android a pasta `noBackupFiles/erp-cache` é apagada ao sair da conta; no iOS a cópia ficava na pasta privada, que já é apagada ao sair.

### Caixa simples

Usa o controle de caixa do Financeiro que o servidor já tem (o mesmo do painel e da frente de caixa); nenhuma rota nova foi criada.

- **Abrir:** conta do tipo Caixa (`GET erp/v1/financeiro/accounts`, só `kind: cash`) e o troco inicial → `POST erp/v1/financeiro/actions/session_open` (`account_id`, `change_cents`). Sem conta do tipo Caixa, a tela pede para cadastrar uma no painel.
- **Lançar entrada e saída:** `POST …/actions/session_move` com `kind` `supply` (entrada) ou `withdrawal` (saída), `amount_cents`, `posted_on` (hoje em Brasília) e a forma de pagamento e a descrição na observação (`note`: "Pix · Corte e barba", até 240 caracteres). As formas vêm de `GET erp/v1/documentos/sales_orders/pagamento`; sem elas (parte Vendas desligada), o app usa Dinheiro, Pix, Cartão de débito e Cartão de crédito.
- **Fechar com conferência:** o app mostra o dinheiro esperado na gaveta (troco + entradas em dinheiro − saídas em dinheiro; lançamento sem forma conhecida conta como dinheiro), a pessoa digita o que contou e vê "Confere", "Sobrou" ou "Faltou". `POST …/actions/session_close` leva em `values` o contado na forma Dinheiro e, nas outras formas, a soma dos lançamentos. Sem formas do servidor, `values` vai vazio e a conferência por forma fica no painel.
- O caixa aberto é o da pessoa (`GET erp/v1/financeiro/controle-caixa?state=open`, detalhe em `…/controle-caixa/{id}`). Toda ação leva `command_id` UUID, que também é a `Idempotency-Key`: depois de uma queda, tocar de novo repete com a mesma chave e o servidor não lança duas vezes. Versão antiga (outro aparelho mexeu) volta `409` e a tela pede para atualizar. Sangria com conferido, reabrir, excluir e os caixas das outras pessoas ficam no painel.

### Clientes, mesas, entregas e equipamentos

- **Clientes:** o cadastro de contatos da área (`GET contacts?q=&limit=50`, `GET contacts/{id}`, `POST contacts`, `PATCH contacts/{id}` com `expected_version`), só com nome, telefone (com `phone_mode: human_br`, aceita "(11) 99999-0000"), e-mail e observação. Documento, endereço, histórico e o cadastro do ERP ficam em Contatos, no painel.
- **Mesas** (módulo `mesas`): o mapa das mesas por setor (`GET mesas`), abrir uma mesa livre com pessoas e nome do cliente (`POST mesas/tabs`) e pedir a conta (`POST mesas/tabs/{id}/bill`). Só o papel Garçom (ou administrador) opera; os outros veem. Lançar itens, receber, transferir e juntar ficam no painel.
- **Entregas** (módulo `entrega`): o entregador vê as entregas dele (`GET entrega/mine`), sai para entregar (`POST entrega/deliveries/{id}/start`) e confirma com o código do cliente quando a loja pede (`POST …/delivered`); a equipe vê as abertas (`GET entrega/deliveries`) e confirma sem código. O envio contínuo da posição pelo GPS não está no app: o rastreio fica no painel.
- **Equipamentos:** a impressora térmica (parear, imprimir um teste e ver a situação, a mesma tela de antes) e, para o administrador com a fila ligada, os painéis de senha: **parear painel ou totem pelo código** (o aparelho em "Usar este aparelho como painel ou totem" mostra o código; o app chama `POST /api/v1/pairings/lookup` e `POST /api/v1/pairings/{id}/approve` com a área e as permissões que o aparelho pediu, só para o cliente `senhapp`), a lista dos pareados com a situação e **Desligar** (`DELETE /api/v1/pairings/{id}`), e **Criar painel de TV** (`POST queue/displays`; o link com a chave aparece uma vez para enviar à TV) e desligar (`DELETE queue/displays/{id}`).
- **Ordens de serviço** continuam no app como estavam (trabalho de campo do técnico), dentro da aba Atendimento quando o módulo está ligado.

**Demonstração:** a área de exemplo continua com as partes do ERP ligadas e a pessoa administradora. O caixa começa fechado, com a conta "Caixa do salão" e as formas Dinheiro, Pix e cartões; abrir, lançar e fechar funcionam em memória. Clientes lista, cadastra e edita os contatos de exemplo. Mesas e Entregas não estão na demonstração (os módulos não vêm ligados nela). No iOS, `WABOTIA_DEMO=caixa` (ou `clientes`, `equipamentos`, `assistente`) abre direto a tela no build de depuração.

## 7. Limites conhecidos

- Não há ligações ao vivo: o servidor não as oferece pela Zernio e os aplicativos mostram só o histórico. Para receber ligações do WhatsApp, use o encaminhamento da própria Zernio.
- O push do iOS usa Firebase Cloud Messaging por meio do APNs.
- Mensagens em conversas sob controle da IA não geram notificação.
- O áudio gravado no iOS é convertido para OGG/Opus no aparelho; se a conversão falhar, o aplicativo envia M4A/AAC como áudio comum.
- O aplicativo guarda um único servidor por vez. Para usar outro servidor, saia da conta e informe o novo endereço.
- A demonstração não recebe notificações e seus dados vivem só na memória: recomeçam a cada entrada e a cada abertura do app.
