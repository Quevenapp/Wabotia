# Bot por provedor de IA, sem Hermes

Uma conexão **Provedor de IA** liga o Wabotia direto à API da Anthropic, da OpenAI, da DeepSeek ou de outro serviço compatível com a OpenAI. Não há VPS, Docker, Hermes nem plugin: basta a instalação do Wabotia na Cloudflare e uma chave de API. O Hermes continua disponível e as conexões Hermes existentes não mudam.

## O que faz e o que não faz

O bot de provedor de IA é um **atendente que conversa**. A cada mensagem, o Wabotia envia ao modelo as instruções da área, as 12 últimas mensagens, as fontes do Conhecimento, os menus e as categorias de protocolo, e recebe a decisão do Atendente (responder, perguntar, mostrar menu, consultar ou abrir protocolo, transferir). As regras são as mesmas do Atendente no Hermes, inclusive o JEV.

| | Hermes | Provedor de IA |
| --- | --- | --- |
| Servidor próprio | VPS ou computador com o Hermes | nenhum |
| Instalação | plugin ou túnel | chave de API no painel |
| Custo | servidor + modelo | só o uso do modelo, cobrado pelo provedor |
| Atendente, transferência, conversa com a equipe | sim | sim |
| Especialista e item de menu do tipo bot | sim | não |
| Ferramentas, ações em outros sistemas | sim | não |
| Arquivos gerados pelo bot | sim | não |
| Áudio | transcrito pelo Hermes | aviso pedindo texto, ou equipe |
| Imagens | conforme o modelo | Anthropic e OpenAI sim; DeepSeek não; compatível conforme a opção |

Quem precisa que o bot consulte boletos, pedidos ou outros sistemas continua usando o Hermes como especialista. Um Atendente de provedor de IA pode consultar especialistas do Hermes.

## Conectar

1. Crie a chave de API no site do provedor e deixe saldo ou cobrança ativos.
2. No painel: **Hermes e canais → Nova conexão → Serviço: Provedor de IA (sem servidor)**.
3. Escolha o provedor e cole a chave. Na **Outra API compatível com OpenAI** (OpenRouter, Groq e semelhantes), informe também a URL da API, à qual o Wabotia acrescenta `/chat/completions`, e se o modelo entende imagens.
4. Escolha o modelo. **Buscar modelos da conta** pergunta ao provedor, com a chave digitada (ou, na edição, a já cadastrada), quais modelos a conta tem, e passa a sugeri-los no campo. A chave usada na busca não é guardada.
   - **Anthropic**: Claude Opus 5.5 (padrão, mais capaz), Claude Sonnet 5.5 ou Claude Haiku 5.5 (mais barato). A busca mostra só os que a conta enxerga.
   - **OpenAI**: a lista deixa de fora modelos de imagem, voz e embeddings. Ainda é possível digitar qualquer nome.
   - **DeepSeek** e APIs compatíveis: a lista vem como o provedor publica; sem lista, digite o nome (na DeepSeek, por exemplo, `deepseek-chat`).
5. Escolha o **Esforço de raciocínio**: quanto o modelo pensa antes de responder. Mais esforço deixa a resposta mais cuidadosa, mais lenta e mais cara.
   - **Anthropic**: Baixo (padrão, recomendado para conversa), Médio ou Alto.
   - **OpenAI** e APIs compatíveis: Padrão do modelo (o campo não é enviado), Baixo, Médio ou Alto. Só modelos com raciocínio aceitam; com outro modelo, o **Testar conexão** acusa o erro.
   - **DeepSeek**: não há escolha.
   - Níveis acima de Alto não são oferecidos: podem passar do prazo de 60 segundos de cada resposta.
6. Deixe marcada **Apenas mensagens (não receber áudio e vídeo)**, ou desmarque (veja abaixo).
7. Salve e clique **Testar conexão**. O teste confere chave, modelo e endereço e cria o bot, desabilitado, com o nome da conexão. Na OpenAI e na DeepSeek, o modelo precisa estar na lista da conta; no formato OpenAI, o teste ainda faz uma chamada curta, que também valida o esforço. Uma conexão tem um único bot; para usar dois modelos, crie duas conexões.
8. **Ativar** a conexão. Em **Atendente e especialistas**, habilite o bot e escolha **Usar como Bot Atendente**, ou defina-o como bot de uma linha.

A chave fica cifrada no cofre da instalação e nunca é devolvida ao painel. Para trocá-la, pause a conexão, edite e preencha **Nova chave de API**; vazio mantém a atual. Editar exige testar de novo antes de reativar. O provedor não pode ser trocado: crie outra conexão.

Para remover a conexão, pause-a e use **Excluir conexão** no cartão. O bot dela deixa de existir e a chave é apagada; conversas, mensagens e execuções anteriores continuam no histórico, e a conta no provedor não é alterada. A exclusão é recusada enquanto o bot for o Atendente, o bot de uma linha ou estiver atendendo uma conversa: troque-o antes. O mesmo vale para conexões Hermes.

## Áudio, vídeo e imagens

- **Apenas mensagens ligada (padrão):** quem manda áudio ou vídeo recebe "No momento este atendimento recebe apenas mensagens de texto. Por favor, escreva sua mensagem." A conversa continua com o bot e a equipe não é chamada. Vários áudios seguidos geram um único aviso; um novo aviso só sai depois de outra mensagem enviada.
- **Desligada:** áudio e vídeo vão para a equipe humana, como qualquer anexo que o bot não entende.
- **Imagens** (até 2 por mensagem, até 5 MB cada) vão ao modelo quando ele as entende; caso contrário, a conversa vai para a equipe.
- **Documentos** vão para a equipe, como antes.

## Falhas

- Provedor fora do ar, limite de uso ou demora (HTTP 408, 409, 429, 5xx ou mais de 60 segundos): o Wabotia tenta de novo a cada ciclo, com intervalo mínimo de 10 segundos, por até 3 minutos desde a mensagem. Depois, transfere para a equipe.
- Chave recusada, sem saldo, modelo inexistente, recusa do modelo ou resposta cortada: transfere na hora. O motivo aparece em **Execuções de bots**.
- Uma pessoa que assume a conversa durante a chamada cancela a resposta do bot.

As respostas de uma área de atendimento são processadas em série. Com muitos clientes ao mesmo tempo, a espera cresce na proporção do tempo de resposta do modelo; Claude Haiku 5.5 e modelos menores respondem mais rápido.

## Detalhes técnicos

- Conexão `kind: "ai"`; configuração `provider`, `model`, `base_url`, `vision`, `effort`, `text_only`; segredo `api_key` ([API](../src/openapi.ts)).
- Modelos da conta: `POST /api/v1/profiles/{perfil}/ai-models` (administrador, 10 por minuto), com `{provider, base_url?, api_key?, connection_id?}`; responde `{data:[ids]}`. Fica fora dos comandos idempotentes para a chave não ir aos recibos.
- Chamadas em [src/ai-provider.ts](../src/ai-provider.ts): formato OpenAI (`/chat/completions`, modo JSON na OpenAI e na DeepSeek, `reasoning_effort` quando escolhido) e SDK oficial da Anthropic (`@anthropic-ai/sdk`) com saída estruturada no formato do Atendente e `output_config.effort` (padrão `low`).
- Execução em [src/engine.ts](../src/engine.ts) (`aiRun`): a resposta chega na mesma passada, sem consulta posterior. Sem efeito colateral no provedor, uma chamada interrompida é simplesmente repetida; o envio ao cliente não duplica, porque a mensagem é identificada pela execução.
- Sem migração de banco, sem Durable Object novo, sem binding ou secret novo: chega pela atualização normal do painel.
- Testes: `tests/ai-provider.test.ts`.
