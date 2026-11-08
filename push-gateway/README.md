# Gateway de push do Wabotia

Worker Cloudflare que recebe notificações de **qualquer servidor Wabotia** e as repassa ao Firebase Cloud Messaging (FCM), que entrega aos aparelhos Android e iOS (via APNs). Ele guarda a conta de serviço do projeto Firebase do aplicativo publicado nas lojas, para que os servidores não precisem dela.

## Por que existe

O aplicativo Wabotia nas lojas pertence a um único projeto Firebase, mas cada empresa opera o próprio servidor (`wabotia.queven.com.br`, `wabotia.fagoo.com.br` etc.). Enviar notificações exige a chave privada desse projeto, que não pode ser distribuída a todas as instalações. O gateway resolve isso: o servidor envia a notificação pronta (token do aparelho, título, corpo e dados de navegação) para `POST /v1/push`, e o gateway assina e entrega ao FCM. A Queven opera uma instância pública em `https://push.wabotia.queven.app`, usada por padrão. Quem compila o próprio aplicativo pode publicar o próprio gateway ou configurar o servidor no modo `fcm` (conta de serviço própria, sem gateway).

## Rotas

| Rota | Uso |
|---|---|
| `GET /health` | `{service:"wabotia-push-gateway", version}` |
| `POST /v1/push` | Corpo `{messages:[...]}` com até 100 itens. Resposta `{results:[{token,status,error?}]}` na mesma ordem, com `status` `ok`, `unregistered` (token inexistente; o servidor desativa o dispositivo) ou `error`. |

Cada item de `messages`:

| Campo | Regra |
|---|---|
| `token` | texto de 20 a 4096 caracteres, sem espaços |
| `platform` | `android` ou `ios` |
| `title` / `body` | textos de até 200 / 500 caracteres; ao menos um com conteúdo |
| `data` | objeto com até 20 chaves, valores texto (chaves até 64 e valores até 1000 caracteres) |
| `priority` | `high` ou `normal` (padrão `normal`) |
| `collapse_key`, `channel`, `category` | textos opcionais (até 100 / 50 / 50 caracteres) |
| `time_sensitive` | booleano opcional (nível de interrupção no iOS) |

Erros vêm como `{error:{code,message,index?}}`: `400` (`invalid_json`, `invalid_request`, `invalid_message` com o `index` do item), `401` (`unauthorized`), `413`, `429` (`rate_limited`, com `Retry-After` em segundos) e `503` (`setup_required`, gateway sem conta de serviço).

### Limite por IP

Cada IP pode enviar 600 mensagens por minuto. O contador fica **na memória de cada isolado** do Cloudflare: não é compartilhado entre regiões nem entre isolados, portanto o limite efetivo é aproximado e serve para conter abuso grosseiro, não como cota exata. Um servidor Wabotia envia bem menos que isso.

## Publicar o próprio gateway

Requisitos: Node 22 e uma conta Cloudflare (o plano gratuito basta).

```sh
cd push-gateway
npm install
npx wrangler login
npx wrangler secret put FCM_SERVICE_ACCOUNT    # cole o JSON da conta de serviço
npx wrangler secret put GATEWAY_SHARED_SECRET  # opcional; veja abaixo
npm run deploy
```

A conta de serviço é criada no console do Firebase em **Configurações do projeto → Contas de serviço → Gerar nova chave privada** (papel *Firebase Cloud Messaging API Admin*). O JSON precisa conter `client_email`, `private_key`, `project_id` e `token_uri`. Sem o segredo, ou com JSON inválido, o gateway responde `503 setup_required`. Ao trocar a chave, publique o segredo novamente; o Worker recarrega sozinho.

`GATEWAY_SHARED_SECRET` é opcional. Quando definido, `POST /v1/push` exige `Authorization: Bearer <segredo>` (comparado em tempo constante). Use-o quando o gateway for privado de uma empresa; a instância pública da Queven não exige segredo, como os serviços de push de outros produtos auto-hospedados.

O arquivo `.npmrc` desta pasta ativa `legacy-peer-deps`, porque o npm 10.9 falha ao resolver os peer deps opcionais do Vitest 4.1 em um projeto novo; as versões são as mesmas do repositório raiz.

Para desenvolver localmente: crie `.dev.vars` com `FCM_SERVICE_ACCOUNT='{...}'` e rode `npm run dev` (porta 8787). `npm test` executa os testes dentro do `workerd` com o FCM simulado; `npm run check` roda o TypeScript.

## Apontar um servidor Wabotia para o gateway

No painel do servidor, em **Sistema e atualizações → Notificações dos aplicativos**:

1. Modo: `gateway`.
2. URL do gateway: o endereço do seu Worker (por exemplo `https://wabotia-push-gateway.sua-conta.workers.dev`). O padrão é `https://push.wabotia.queven.app`.
3. Segredo do gateway: o mesmo valor de `GATEWAY_SHARED_SECRET`, se você o definiu.
4. Conteúdo: `preview` ou `minimal` (veja Privacidade).
5. Use **Enviar teste** (ou `POST /api/v1/system/push/test`) para confirmar.

Pela API: `POST /api/v1/system/push/configure` com `{mode:"gateway", gateway_url, gateway_secret, preview}` (administrador, com `Idempotency-Key`). O aplicativo precisa estar compilado com o `google-services.json` / `GoogleService-Info.plist` do **mesmo** projeto Firebase cuja conta de serviço está no gateway; caso contrário o FCM responde `unregistered` para todos os tokens.

## Privacidade

O gateway é um repassador: processa a mensagem na memória, envia ao FCM e descarta. Ele **não** armazena tokens, títulos, corpos nem `data`, e os registros de execução contêm apenas contagens e status (`3 mensagem(ns) ok=2 unregistered=1 error=0`). Ainda assim, ao usar um gateway operado por terceiros, o operador poderia em tese ler o tráfego. Por isso o servidor oferece o modo de conteúdo **`minimal`**: a notificação sai como "Nova mensagem" sem nome, telefone ou trecho do texto, e o aplicativo busca o conteúdo diretamente no seu servidor ao abrir. Recomenda-se `minimal` com gateways de terceiros e `preview` apenas com gateway próprio ou modo `fcm` direto. Em todos os modos, o FCM (Google) e o APNs (Apple) recebem a notificação, como em qualquer aplicativo móvel.

## Estrutura

- `src/index.ts`: rotas, validação, segredo compartilhado e limite por IP.
- `../src/push-fcm.ts`: cliente FCM compartilhado com o servidor (OAuth RS256 e envio com 5 chamadas simultâneas). Mantido no repositório raiz, sem dependências do servidor.
- `test/gateway.test.ts`: testes com o plugin Vitest do Cloudflare e FCM simulado.
