# Canais: formatos e provas externas pendentes

Todos os exemplos e testes desta leva usam dados sintéticos: **formato do plano; a conferir com a conta real**. Nenhuma chamada real a Telegram, Zernio, Google, Meta, e-mail ou push foi feita neste aceite. Esta lista registra hipóteses do código, não especificações remotas confirmadas.

| Fronteira e leitor único | Hipótese usada / o que conferir | Tratamento conservador |
|---|---|---|
| Comentários — `src/c2/comments-provider.ts` | Envelope `comment.received`, conta/plataforma/perfil, autor, pai, publicação e timestamp. Resposta pública `POST /v1/inbox/comments/{postId}` com `commentId`; privada no sufixo `/{commentId}/private-reply`. | Só eventos reconhecidos são aceitos; comentário não se torna DM por semelhança de IDs. |
| Ocultação de comentário — mesmo leitor | Método `PATCH`, corpo com `accountId`, `platform`, `hidden` e confirmação remota. | `comments_visibility_contract` precisa confirmar o formato esperado; ausência resulta em `provider_contract_unverified`, sem presumir ocultação. |
| Vínculo da privada — mesmo leitor | Retorno `privateReply` com comentário, publicação, conta, plataforma, perfil, conversa e participante comprovadamente associados. | Campos incompletos deixam **privado enviado; vínculo pendente**. Tentativa remota continua consumida; não há segunda tentativa nem junção automática. |
| Telegram — `src/c2/telegram-provider.ts` e política de bytes em `telegram-media.ts` | Formatos de `getMe`, `setWebhook`, `deleteWebhook`, `getFile`, mensagens, edições, callbacks e bloqueio; tamanho/retorno de arquivos e semântica de 429. | Somente chat privado. URLs com token ficam na fronteira remota; timeout após possível envio é `unknown`. Limites locais conservadores: download 20.000.000 bytes; foto 10.000.000; demais envios 50.000.000. |
| Google — `src/c2/google-provider.ts` | `review.new/updated/deleted/restored`, versões/datas, `GET /v1/inbox/reviews` com `reviews`/`nextCursor`, filtro temporal, `POST`/`DELETE` de reply e retorno `success`. | Sem importar histórico anterior à ativação; ausência/página parcial não apaga avaliação. Limite de resposta 4.000 caracteres é do Wabotia. |
| TikTok — `src/c2/tiktok-provider.ts` | Elegibilidade da conta/região; `message.received/sent`; anexos/CDNs permitidos; envio e ID remoto; distinção entre eco local e saída externa. | Não presumir eventos de entregue, lido ou `message.failed`. Somente texto ou JPG/PNG conforme limites locais. |
| Quota TikTok — `src/c2/tiktok.ts` | Quando a quota remota de dez envios reinicia. | Dez tentativas contabilizáveis nas últimas 48 horas corridas; nova entrada renova a janela, sem zerar o contador. Texto mais imagem exige duas vagas atômicas. |
| Envio de e-mail — `src/c2/email-provider.ts` | REST `raw` com MIME completo em base64; `result.id`; `result.status` igual a `accepted` ou `queued`; 429 como recusa sem aceitação; cabeçalhos e anexos preservados. | `EMAIL_PROVIDER_CONTRACT.confirmed=false` na composição atual. Envio do canal, novo e-mail e entrega do teste de recebimento dependem dessa confirmação. UI não habilita hipótese de transporte. |
| Email Routing — runtime `email`, `src/c2/email-ingress.ts` | Nomes atuais do painel Cloudflare, MX de subdomínio junto de provedor externo e comportamento de reentrega após falha do handler. | Configuração manual pelo dono; preservar MX existentes; não prometer retry da Cloudflare. R2/D1 não são uma transação. |

## Como fechar uma pendência

Em uma rodada futura autorizada, conferir o contrato na conta correta, capturar somente exemplos saneados e registrar conta de teste, data, operação, retorno e limite observado. Manter aliases e leitura de retorno no adaptador único indicado, atualizar fixtures sintéticas e repetir as provas afetadas mais o fechamento integrado necessário. Não guardar token, segredo de webhook, MIME de cliente, endereço pessoal ou URL Telegram com token na evidência.

Não basta um HTTP 2xx para afirmar entrega, nem um teste unitário para afirmar compatibilidade com fornecedor. E-mail com `Authentication-Results` declarando sucesso continua sem prova de pessoa; essa restrição não é pendência a ser removida por homologação.

## Limites de entrega já assumidos

O sistema deduplica a entrada e a reserva local. A outbox conserva ordem, versão, autorização, janela e quota. Uma queda após possível efeito remoto pode produzir resultado indeterminado: a aplicação não promete entrega remota exatamente uma vez e não repete `unknown` automaticamente. Privada de comentário consome a tentativa após iniciar a chamada; TikTok mantém tentativa remota na contagem. Google sem resposta inequívoca mantém o estado de publicação indeterminado.

O bruto de e-mail aceita até 25 MiB, mas o parsing local aceita até 8 MiB. A mensagem codificada e o corpo REST também têm tetos próprios de 25 MiB. Esses limites locais e os avisos de anexo não são alegações de antivírus nem de limite universal do fornecedor.

Prova em aparelho, revisão visual/acessibilidade, envio/recebimento real e configuração de roteamento não foram realizados neste aceite. A compilação e os testes nativos informados pelo orquestrador estão registrados separadamente em [CANAIS-SEGUNDA-LEVA-ACEITE.md](CANAIS-SEGUNDA-LEVA-ACEITE.md).
