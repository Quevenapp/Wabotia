# Canais: segunda leva

A segunda leva acrescenta comentários do Instagram/Facebook, Telegram por bot próprio, avaliações do Google, e-mail como canal e mensagens diretas do TikTok. A composição está em `src/c2-entry/install.ts`, importada por `src/index.ts`; este continua sendo o `main` do Worker. O registro mantém a mesma classe `Coordinator` e usa o D1, R2, cron e bindings existentes.

O estado das verificações, os limites de aceite e a origem das evidências estão em [CANAIS-SEGUNDA-LEVA-ACEITE.md](CANAIS-SEGUNDA-LEVA-ACEITE.md). Há formatos de fornecedores ainda **a conferir com a conta real**; implementação e demonstração não significam homologação remota. Em especial, o transporte de envio do canal de e-mail permanece bloqueado até confirmar seu contrato REST.

## Ativação e compatibilidade

Abra `/app?canais=2` para acessar o catálogo da segunda leva. Essa entrada apenas mostra as opções: não ativa conexões. O catálogo também aparece quando a área projeta recursos da segunda leva. Sem esse uso, os encaixes novos não acrescentam controles às telas antigas. DMs do Instagram/Facebook continuam separadas dos comentários. Google sozinho não transforma a lista de conversas em multicanal.

O painel carrega o registro e as telas da segunda leva sob demanda, após essa entrada explícita ou quando o status da área informa seu uso. O registro termina antes de a área mostrar esses dados. Os cenários de demonstração também ficam fora do pacote inicial e só são carregados ao usar a demonstração.

Telegram e e-mail são conexões próprias. Google e TikTok são importados pela integração Zernio; comentários exigem ativação explícita na conexão Instagram/Facebook. Configurações exigem administração da área. Tokens e segredos não retornam à tela: aparece somente **configurado**.

## Comportamento por canal

| Canal | Entrada e identidade | Resposta e limites locais |
|---|---|---|
| Comentários Instagram/Facebook | Uma conversa por publicação e autor; identidade `comment-author`, diferente da DM. | Ação humana com comentário alvo e escolha pública/privada. Bot nunca responde em público. Privada: uma tentativa, até 168 horas de timestamp válido; tentativa remota consome a vez, mesmo com falha ou resultado indeterminado. |
| Telegram | Somente chat privado. Cliente inicia pelo bot; identidade pelo ID de usuário, sem telefone inventado. | Sem janela. Texto de até 4.096 caracteres por entrega, incluindo assinatura; divisão ordenada. Download de até 20.000.000 bytes; foto enviada até 10.000.000; demais mídias até 50.000.000, sujeitos também à política local. |
| Google | Avaliações próprias, sem conversa, contato, fila ou bot. Reconciliação limitada ao marco de ativação; não importa histórico anterior. | Administrador ou pessoa com acesso a Avaliações e concessão `google.reply`. Versão reconferida antes da publicação. Limite inicial do Vinki: 4.000 caracteres. Sugestão de IA não publica. |
| E-mail | Remetente do envelope agrupa operacionalmente a conversa. `From`, `Reply-To` e autenticação recebida são informações para a equipe. | Remetente nunca confirmado como pessoa; bot e confirmação automática desligados por padrão. Assunto até 200 caracteres, texto até 50.000. Transporte de saída pendente de confirmação do contrato. |
| TikTok | Cliente inicia; identidade opaca da conta. Eco local converge com a entrega; saída pelo aplicativo é externa. | Texto de até 6.000 caracteres ou uma imagem JPG/PNG até 3.000.000 bytes. Texto com imagem são duas entregas e duas vagas. Prazo inferior a 48 horas desde a última entrada válida. |

No Telegram, contato compartilhado pelo próprio usuário após pedido válido é somente sugestão de junção para a equipe. Contato de terceiro não prova telefone. Callbacks são vinculados à conversa, ao sujeito, ao menu, à época e à validade; repetição não executa novamente a opção. Um bloqueio do bot impede envio. Recusa 429 comprovada respeita o prazo de retry; timeout após possível envio é indeterminado.

Na resposta privada de comentário, a DM só é vinculada quando o retorno comprova conta, sujeito e thread. Sem esses campos, a situação é **privado enviado; vínculo pendente**. Não há junção automática de identidades e a saída privada não abre janela de bot. Ocultar/mostrar depende da confirmação do formato remoto no adaptador.

No Google, página parcial, timeout ou ausência em uma consulta não comprovam exclusão. Exclusão exige tombstone confirmado; restauração exige estado posterior. Avaliações ficam na web, dentro da área Avaliações, conservando Atendimento. O push não traz o nome do autor e abre a área web.

### Contagem conservadora do TikTok

Até confirmação do fornecedor, contam no máximo **dez envios ou tentativas contabilizáveis nas últimas 48 horas corridas**, além da janela de resposta. Nova mensagem do cliente renova o prazo, mas não zera a contagem. Pessoa, bot, automação, menu, assinatura, saída externa e resultado indeterminado obedecem à mesma regra.

Vagas são reservadas no mesmo lote da outbox. Com uma vaga restante, uma intenção de texto mais imagem é recusada inteira; a décima entrega isolada pode prosseguir e a décima primeira é bloqueada. Recusa local antes da tentativa libera a reserva. Tentativa remota permanece contada. O contador da tela vem do servidor; a transferência ao humano não envia aviso fora da quota.

## E-mail e dados pessoais

O [guia manual de recebimento](CANAIS-EMAIL-RECEBIMENTO.md) explica DNS, Email Routing, teste e os bloqueios atuais. E-mail como canal é diferente de [Enviar conversa por e-mail](EMAIL.md#enviar-conversa-por-e-mail): não anexa transcrição automaticamente e tem cota própria.

HTML recebido vira texto por parser, sem execução nem carregamento remoto. O runtime limita o bruto a 25 MiB; o parser tem limite adicional de **8 MiB** para proteger a memória. Acima deste limite local, o bruto fica em quarentena e não abre atendimento. Há até 32 anexos, sujeitos ao tipo e tamanho aceitos; recusas aparecem como aviso. Não existe promessa de antivírus ou inspeção universal do conteúdo binário.

E-mail não prova identidade, mesmo com cabeçalho `dmarc=pass`, endereço cadastrado ou junção humana. O bot do canal não recebe ficha, histórico privado, conteúdo anterior da conversa nem dados dos módulos. Resposta automática, lista, devolução, bloqueado e teste não abrem atendimento nem disparam bot. Identificadores, nomes, perfis e endereços são dados pessoais e seguem a máscara da IA.

Junção de contatos continua humana e sujeita às permissões existentes. Nenhum canal desta leva habilita Agenda, Pedido, cobrança ou outros módulos: eles permanecem exclusivos do WhatsApp.

## Entrega e atualização

Respostas passam pela outbox, com ordem por recurso, idempotência e reautorização antes da chamada remota. `sent` significa confirmação aceita pelo leitor do adaptador, não garantia de entrega na caixa postal ou leitura. Recusa comprovada pode gerar espera; `unknown` não é reenviado automaticamente. Uma nova intenção humana precisa respeitar tentativa única e quotas.

O atualizador distribui módulos, export `email` e migrações aditivas `0144`–`0147`. Não configura domínio, DNS/MX ou Email Routing e não pede token de zona. Não cria Queue, banco, bucket, binding ou classe de Durable Object. O nome do Worker deve permanecer estável, pois a regra de recebimento aponta para ele.

As hipóteses exatas dos leitores e as verificações externas pendentes estão em [CANAIS-FORMATOS-PENDENTES.md](CANAIS-FORMATOS-PENDENTES.md). Não houve publicação ou implantação neste aceite.
