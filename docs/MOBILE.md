# Aplicativos Android e iOS

Os aplicativos nativos **Wabotia** para Android (Kotlin/Jetpack Compose) e iOS (Swift/SwiftUI) ficam em [`mobile/android`](../mobile/android) e [`mobile/ios`](../mobile/ios). Eles são clientes da mesma API REST do painel e funcionam com **qualquer instalação Wabotia**: na primeira tela a pessoa digita o endereço do seu servidor (por exemplo `wabotia.queven.com.br` ou `wabotia.fagoo.com.br`), depois entra com o e-mail e a senha de atendente cadastrados em **Pessoas**.

O que os aplicativos oferecem:

- **Conversas:** fila, atendimentos próprios, conversas com a IA e concluídas; assumir, transferir para outro atendente, devolver à IA, concluir, notas internas e etiquetas.
- **Mensagens WhatsApp:** texto, fotos e vídeos da galeria ou câmera, documentos, áudio gravado (OGG/Opus), localização atual do aparelho, cartão de contato, citação, reação, editar/apagar/marcar como lida conforme o canal, recibos de entrega e leitura.
- **Ligações de voz:** iniciar, atender e recusar ligações da Meta Calling API com WebRTC nativo, silenciar, viva-voz e encerrar.
- **Protocolos:** abertos, em andamento, atrasados e concluídos; andamento público, prazo da primeira resposta, responsável e conclusão.
- **Bots:** conversar com os bots habilitados no perfil (execuções da Equipe Bot) e acompanhar resultados e anexos.
- **Notificações push:** novas mensagens, atendimentos na fila, transferências, protocolos abertos, protocolos vencendo ou atrasados e ligações recebidas.
- **Disponibilidade:** marcar presença e ausência.

Este guia descreve a parte do servidor (autenticação móvel, dispositivos e push), o gateway de notificações e como compilar os aplicativos. A homologação em aparelhos reais com número WhatsApp real continua sendo a etapa final com o proprietário.

## 1. Atualize o servidor

Os aplicativos exigem a versão **0.8.0** ou superior do Wabotia. Atualize em **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. A migração `0008_mobile.sql` é aditiva: cria as tabelas de dispositivos, cursores de push e alertas de protocolo e acrescenta colunas à tabela de sessões. Conversas, agenda, credenciais e histórico são preservados.

## 2. Autenticação móvel

O painel web usa cookie de sessão com verificação de origem. Os aplicativos usam um **token de sessão de usuário** (`Authorization: Bearer wabu_...`), diferente das chaves de aplicação (`Bearer` das integrações servidor-servidor). O token identifica uma pessoa cadastrada em **Pessoas**, com os mesmos perfis e papel do painel; aplicações continuam sem registrar presença ou operar como humanos.

| Método e rota | Uso |
|---|---|
| `GET /api/health` | Confirma que o endereço é um servidor Wabotia (`service: "wabotia"`, versão). |
| `GET /api/auth/status` | `initialized` e `configured`; um servidor sem administrador orienta a concluir a instalação pelo navegador. |
| `POST /api/auth/mobile/login` | Corpo `{email, password, device:{platform:"android"\|"ios", name, app_version}}`. Retorna `{token, expires, user:{id,name,email,role,profiles}}`. Limite de 10 tentativas por IP a cada 10 minutos. |
| `POST /api/v1/auth/mobile/refresh` | Troca o token atual por um novo (o antigo é revogado) e estende a validade por 30 dias. Use quando faltar menos de 7 dias. |
| `POST /api/v1/logout` | Revoga o token atual (também funciona com Bearer). Remova o dispositivo antes de sair. |
| `GET /api/v1/me` | Identidade autenticada. |

O token tem 30 dias; expira sem uso. É armazenado apenas como hash no servidor e, no aparelho, no Keychain (iOS) ou em `EncryptedSharedPreferences` (Android). Escritas pelo token móvel não exigem cabeçalho `Origin`. Todas as outras rotas da [API](API.md) funcionam da mesma forma que no painel, inclusive `Idempotency-Key` nas escritas.

## 3. Dispositivos e notificações push

Cada instalação do aplicativo gera um identificador próprio (UUID) e registra o token do provedor após o login e sempre que o token muda.

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
xcodebuild -scheme Wabotia -destination "generic/platform=iOS" -derivedDataPath build build
```

Coloque o `GoogleService-Info.plist` em `mobile/ios/Wabotia/Resources/`. O `project.yml` usa assinatura automática com a equipe configurada em `DEVELOPMENT_TEAM`. Ative no App ID as capacidades **Push Notifications** e **Background Modes → Remote notifications**. Ligações recebidas chegam como notificação sensível ao tempo com as ações Atender e Recusar; a conexão de áudio começa ao abrir o aplicativo.

## 5. Limites conhecidos

- Ligações de voz exigem WhatsApp direto pela Meta com Calling API habilitada, como no painel. QR e Hermes não fazem chamadas. Não há videochamada.
- O push do iOS usa Firebase Cloud Messaging por meio do APNs. Sem PushKit, a ligação recebida não toca como chamada nativa na tela bloqueada; ela aparece como notificação de alta prioridade.
- Mensagens em conversas sob controle da IA não geram notificação.
- O áudio gravado no iOS é convertido para OGG/Opus no aparelho; se a conversão falhar, o aplicativo envia M4A/AAC como áudio comum.
- O aplicativo guarda um único servidor por vez. Para usar outro servidor, saia da conta e informe o novo endereço.
