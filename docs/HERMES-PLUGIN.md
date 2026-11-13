# Plugin Wabotia para o Hermes Agent

Liga os bots de um Hermes Agent ao Wabotia sem túnel Cloudflare, Access, DNS ou porta aberta. O modo por URL ([HERMES-CLOUDFLARE.md](HERMES-CLOUDFLARE.md)) continua existindo e as conexões já criadas não mudam.

Estado: o lado do servidor e o painel estão implementados e cobertos por `tests/hermes-link.test.ts`. O plugin (`public/hermes-plugin/`) e o instalador **ainda não foram executados contra um Hermes real**; veja a seção 8.

## 1. Decisão

O plugin é um **conector de saída**: roda dentro do gateway do Hermes, abre a conexão do Hermes para o Wabotia e executa, na API local do Hermes (`127.0.0.1:8642`), as mesmas operações que o Worker faz pela internet no modo URL.

Ele é registrado como plugin de plataforma (`kind: platform`, `ctx.register_platform`) para ganhar ciclo de vida no gateway (`connect`/`disconnect`) e linha no `hermes status`. Ele **não** é um canal de chat: não usa `handle_message` e `send` recusa.

Motivo: o motor do Wabotia não troca mensagens soltas com o bot. Cada execução (`bot_runs`) envia `input` + `instructions` que mudam por fase (`attendant`, `answer`, `specialist`) e espera um JSON estruturado; depende de `Idempotency-Key` durável, `stop`, `waiting_for_approval` e download de artefatos (`src/engine.ts`, `src/integrations.ts`). Um canal de chat perderia tudo isso. Transportar o contrato `/v1/runs` existente mantém o motor intacto: muda só o caminho da requisição.

| | Modo URL | Modo plugin |
| --- | --- | --- |
| Quem inicia a conexão | Worker → Hermes | Hermes → Worker |
| Infra no cliente | túnel, Access, 2 subdomínios, backend admin `:9119` | nenhuma |
| Chaves do Hermes | guardadas no Wabotia | ficam na máquina do Hermes |
| Credencial no Wabotia | 2 chaves Hermes + par Access | hash de 1 token de vínculo |
| Semântica de execução | `/v1/runs` | `/v1/runs` (igual) |

## 2. Instalação

1. Painel: **Conexões → Conectar Hermes**, em "Como ligar ao Hermes" escolha **Plugin no Hermes** (padrão para conexões novas) e salve. A conexão nasce pausada com `config.transport = "link"`. O modo não muda depois de criada.
2. No cartão da conexão, **Gerar comando de instalação**. O painel mostra o comando com um código de pareamento de uso único, válido por 15 minutos.
3. Na máquina do Hermes (Linux, macOS ou WSL2), com o usuário do Hermes:

   ```sh
   curl -fsSL https://SUA_INSTALACAO/hermes-plugin/install.sh | bash -s -- https://SUA_INSTALACAO wabp_CODIGO [perfil ...]
   ```

   O script baixa o plugin para `~/.hermes/plugins/wabotia/`, troca o código pelo token, grava `WABOTIA_URL` e `WABOTIA_LINK_TOKEN` em `~/.hermes/.env`, habilita a API local em `127.0.0.1`, cria a `API_SERVER_KEY` do perfil `default` e dos perfis informados quando ainda não existe (chaves existentes são preservadas), executa `hermes plugins enable wabotia` e ativa `gateway.platforms.wabotia.enabled`. Ele não reinicia serviços nem abre portas.
   **Hermes em Docker** (por exemplo a imagem da Hostinger, com os dados em `/opt/data`): o `hermes` não existe no host. Baixe o script no host e execute dentro do contêiner, com o usuário dono da pasta de dados; o instalador recusa rodar com outro usuário, porque o gateway não leria os arquivos:

   ```sh
   curl -fsSL https://SUA_INSTALACAO/hermes-plugin/install.sh | docker exec -i -u hermes CONTEINER bash -s -- https://SUA_INSTALACAO wabp_CODIGO
   ```

   O plugin fica em `$HERMES_HOME/plugins/wabotia`, dentro do volume, e sobrevive à recriação do contêiner. Não é preciso rede `host`: a conexão é de saída e a API local é alcançada dentro do próprio contêiner.
4. Reinicie o gateway do Hermes pelo método já usado (em Docker, `docker restart CONTEINER`).
5. No cartão: **Testar conexão → Descobrir bots → Ativar**.

Só perfis com `API_SERVER_KEY` viram bots executáveis. Para incluir outros perfis, repita o comando com um código novo e os nomes ao final. Ainda não há instalador para Hermes nativo no Windows.

Para o agente também usar as ferramentas do Wabotia, configure o MCP ([API.md](API.md#mcp-para-o-hermes-agent)); são recursos independentes.

## 3. Pareamento

`POST /api/hermes-link/pair`, sem autenticação além do código (20 tentativas por IP a cada 10 minutos):

```json
{ "code": "wabp_<conexão>_<32 hex>", "host": "vps-01", "plugin_version": "1.0.0", "hermes_version": "" }
```

Resposta `200`:

```json
{ "link_token": "wabl_<conexão>_<64 hex>", "connection_id": "…", "poll_seconds": 25 }
```

- Código inválido, usado, expirado ou de outra conexão: `404 pairing_not_found`, sempre a mesma resposta.
- A troca roda serializada por conexão: um código gera um único token.
- O Worker guarda só o hash do token, no cofre da conexão (`secrets`, `connection:<id>`). `host`, versões e data ficam em `config.link`.
- O token vale para **uma conexão** e só para as rotas `/api/hermes-link/*`. Não abre a API v1 nem o MCP.
- **Parear novamente** emite outro código; o token antigo vale até a nova troca. **Revogar plugin** (`POST …/connections/{id}/link-revoke`) apaga o hash: o próximo poll recebe `401` e o plugin encerra o laço.

Rotas do painel (administrador, com `Idempotency-Key`): `POST /api/v1/profiles/{perfil}/connections/{id}/link-code` → `{connection_id, code, expires, command}` e `…/link-revoke` → `{id, revoked}`.

## 4. Protocolo do vínculo

Long-poll por HTTPS com `Authorization: Bearer wabl_…`.

### 4.1 Buscar trabalho

`GET /api/hermes-link/poll` — o Worker segura a resposta por até 25 segundos (`?wait=N` reduz) e responde `200 {"jobs":[Job,…]}`, com a lista vazia quando não há trabalho. No máximo 4 jobs por resposta.

- O poll atualiza `connections.last_seen` (presença no painel), no máximo a cada 30 segundos.
- Um poll novo substitui o anterior da mesma conexão, que responde vazio. Isso cobre reconexões em que o poll antigo ficou órfão.
- `401`: vínculo revogado ou pareado de novo. O plugin para.
- Outras falhas: nova tentativa com espera progressiva de 1 s a 60 s.

```json
{
  "id": "uuid",
  "op": "runs.create",
  "profile": "wabotia",
  "body": { "input": "…", "instructions": "…" },
  "idempotency_key": "wabotia:RUN_ID",
  "deadline_ms": 12000
}
```

### 4.2 Operações (lista fechada)

O plugin nunca recebe caminho ou URL. Para perfil diferente de `default` o prefixo local é `/p/<perfil>`.

| `op` | Campos | Execução local |
| --- | --- | --- |
| `profiles.list` | — | o próprio plugin lista os perfis (substitui o backend `:9119`) |
| `capabilities.get` | `profile` | `GET /v1/capabilities` |
| `runs.create` | `profile`, `body`, `idempotency_key` | `POST /v1/runs` + `Idempotency-Key` |
| `runs.get` | `profile`, `run_id` | `GET /v1/runs/{run_id}` |
| `runs.stop` | `profile`, `run_id` | `POST /v1/runs/{run_id}/stop` |
| `artifacts.download` | `profile`, `artifact_id` | `GET /v1/artifacts/download/{artifact_id}` |

`profiles.list` responde `{"profiles":[{"name","display_name","api_enabled"}]}`. A `API_SERVER_KEY` de cada perfil é lida do `.env` local a cada chamada e nunca é enviada ao Wabotia. Em **Descobrir bots**, todos os perfis viram bots cadastrados e os com `api_enabled` têm as capacidades verificadas (limite de 20).

### 4.3 Devolver resultado

`POST /api/hermes-link/results`

```json
{ "id": "uuid", "ok": true, "http_status": 200, "body": { "run_id": "…" } }
```

Erro: `{"id","ok":false,"http_status":401,"code":"…"}`, com `code` em `local_unreachable`, `local_unauthorized`, `local_error`, `timeout`, `bad_op`, `bad_profile`, `file_too_large` ou `upload_failed`. O Worker converte qualquer erro em `502 hermes_error`, como no modo URL. Resultado de job desconhecido ou já concluído é aceito sem efeito (`{"received":false}`).

Artefatos: `PUT /api/hermes-link/artifacts/{job_id}` com o corpo binário, `Content-Length` e o `Content-Type` original, até 20 MB. O Worker só aceita arquivo para um job `artifacts.download` em espera (`409 job_not_waiting` caso contrário), grava em uma chave temporária do R2 e conclui o job; o plugin não envia `results` nesse caso. O download no Hermes é de uso único: se o envio falhar, o plugin **não** repete e devolve `upload_failed`; vale a regra existente `artifact_unknown`.

### 4.4 Garantias

- Entrega de jobs é "pelo menos uma vez": um job entregue e sem resposta volta a ser oferecido após 5 segundos, enquanto o prazo não vence. O plugin guarda os últimos 200 resultados e repete o mesmo resultado sem executar de novo.
- `runs.create` é seguro para repetir porque o Hermes aplica a `Idempotency-Key` durável (exigida em **Descobrir bots**).
- Sem nenhum poll há mais de 60 segundos, o Worker falha na hora com `502` ("Hermes offline"), sem enfileirar.
- Com o plugin presente, o Worker espera o resultado por 12 segundos (25 para artefatos); estourou, `502`.
- O motor trata essas falhas como já trata as do modo URL: consulta de execução fica "Hermes offline; aguardando reconexão" e criação sem confirmação vira `unknown` para reconciliação.
- O estado do vínculo fica em memória. Um deploy do Worker derruba os jobs em espera, que falham por prazo.

## 5. Segurança

- O plugin só fala com `127.0.0.1` (API do Hermes) e com `WABOTIA_URL`, que precisa ser `https` sem caminho; não segue redirecionamentos.
- `profile` é validado contra os perfis locais; `run_id` contra `^[A-Za-z0-9_.:-]{1,200}$` e `artifact_id` contra `^[A-Za-z0-9_-]{8,200}$`.
- Vazamento do `wabl_` permite se passar pelo Hermes daquela conexão (responder execuções), mas não ler a API do Wabotia. Mitigação: **Revogar plugin**.
- O instalador é servido pela própria instalação e não contém segredo; o código de pareamento vai como argumento.
- A conexão por plugin recusa receber chaves do Hermes (`connection.save` com `secrets`).
- Aprovações de ferramentas continuam sob as políticas do Hermes.

## 6. Plugin

Servido em `/hermes-plugin/` a partir de `public/hermes-plugin/`:

- `plugin.yaml`: `name: wabotia`, `kind: platform`, `requires_env: WABOTIA_URL, WABOTIA_LINK_TOKEN`; opcional `WABOTIA_HERMES_API` (padrão `http://127.0.0.1:8642`, só loopback).
- `link.py`: o vínculo, sem importar nada do Hermes. Testes em `tests/hermes_plugin_test.py` (`python3 -m unittest tests/hermes_plugin_test.py`).
- `adapter.py`: `WabotiaAdapter(BasePlatformAdapter)`; `connect()` inicia o laço do vínculo, `disconnect()` cancela.
- `install.sh`: instalador da seção 2.

## 7. Servidor

- `src/hermes-link.ts`: códigos, token, autenticação e o estado do vínculo (`HermesLinkHub`).
- `src/coordinator.ts`: caminhos `/link-*` atendidos por uma **instância própria da classe `Coordinator`** (`idFromName("hermes-link:" + connection_id)`), que não grava perfil nem agenda alarme. É outra instância porque a do perfil dispara as execuções e não pode esperar por si mesma. **Não criar classe nova de Durable Object**: `src/release.ts` recusa pacotes cujo `durable_migrations` difere de `v1/Coordinator`, o que tiraria a versão do botão **Atualizar Wabotia**.
- `src/integrations.ts`: `hermesRequest`, `hermesArtifact` e `discover` desviam para o vínculo quando `config.transport === "link"`.
- `src/index.ts`: rotas `/api/hermes-link/{pair,poll,results,artifacts/:job}`.
- Painel: `web/admin/ConnectionDialog.tsx` e `web/admin/ConnectionsPage.tsx`.

Distribuição: chega como uma versão nova do Wabotia, instalada por **Sistema e atualizações → Atualizar Wabotia**. Não há migração de banco, mudança de Durable Object, bindings ou secrets novos. O plugin é instalado só na máquina do Hermes.

## 8. Validação

Validado em 13/11/2026 contra um Hermes Agent v0.22.6 em Docker (imagem `ghcr.io/hostinger/hvps-hermes-agent`, dados em `/opt/data`, somente o perfil `default`) e uma instalação de teste do Wabotia:

- Testes Python de `link.py`: 10 passando (Python 3 no host da VPS).
- Instalador executado de dentro do contêiner com `su … hermes`, pareamento, carregamento do plugin após reiniciar o contêiner, **Testar conexão**, **Descobrir bots** (perfil `default`, com idempotência durável anunciada) e **Ativar**.

Ainda não validado:

- Uma execução completa de bot pelo vínculo (`runs.create` → `runs.get` até `completed`), parada, aprovação e download de artefato.
- Revogação observada no log do gateway.
- Vários perfis: se um único gateway atende todos em `:8642` com `/p/<perfil>` (o instalador não verifica `gateway.multiplex_profiles`, como faz `scripts/prepare-hermes.py`) e `hermes -p PERFIL config set API_SERVER_KEY`.
- Hermes instalado direto no host (sem Docker), macOS e a forma `docker exec -u hermes` a partir do host.
- Agentes hospedados na nuvem da Nous: não se sabe se aceitam plugins de usuário.

## 9. Fora desta versão

- Instalador para Windows nativo e atualização automática do plugin.
- WebSocket no lugar do long-poll.
- Wabotia como canal de chat do Hermes (`send_message`, entrega de cron em uma conversa).
- Configurar o MCP no mesmo comando de instalação.
