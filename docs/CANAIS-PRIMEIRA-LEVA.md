# Canais — primeira leva

Esta leva acrescenta mensagens diretas do Instagram e do Facebook à caixa de entrada, canais na ficha, junção reversível de contatos e envio de conversa por e-mail. A referência de compatibilidade é `20e15da9`. O estado das provas está em [CANAIS-ACEITE.md](CANAIS-ACEITE.md); implementação disponível e aceite concluído são estados diferentes.

## Alcance e operação

| Recurso | Comportamento desta leva |
|---|---|
| WhatsApp | Conserva transporte oficial/QR, namespace por conexão, modelos, módulos e apresentação em área só WhatsApp |
| Instagram e Facebook | Somente mensagens diretas, iniciadas pelo cliente, na conta empresarial importada |
| Ficha do contato | Mostra canais e conta; conversas continuam separadas e cada histórico exige autorização |
| Juntar com outro contato | Somente pessoa autorizada, com prévia e confirmação; desfazer depende de manifesto intacto |
| Enviar conversa por e-mail | Exportação autorizada, com prévia e confirmação quando exigida; não é um canal de entrada |
| Comentários, avaliações, Telegram, e-mail como canal e TikTok | Contratos declarados e desligados; sem conexão utilizável nesta leva |

A configuração social fica na integração Zernio existente, separada de **Buscar telefones**. A descoberta consulta contas; a importação confirma a conta e cria seu vínculo local. Não importa conversas antigas. Instagram/Facebook não nascem pelo formulário genérico de conexão e não entram em `meta_numbers`. Conta, área e plataforma devem coincidir; quando informado, o perfil do fornecedor também é conferido.

Credenciais continuam na integração existente. Não há nova infraestrutura, classe de Durable Object, dependência, publicação ou implantação prevista por esta leva. As quatro migrações aditivas são `0140` a `0143`, de responsabilidade da base.

## Janela, conteúdo e módulos

| Idade da última mensagem válida do cliente | Instagram/Facebook |
|---|---|
| Menos de 24 horas | Texto humano, mídia e automação conforme capacidades |
| De 24 horas até antes de 168 horas | Apenas texto livre escrito por pessoa autenticada, com `HUMAN_AGENT` |
| 168 horas ou mais; horário ausente ou inválido | Envio bloqueado |

O servidor define a origem humana e reconfere a janela imediatamente antes do envio. Campos enviados pelo cliente, um ator com aparência de usuário, uma ficha juntada ou mensagem em outro canal não concedem a extensão. Menus, bot, aplicação, automação, anexos e reações não usam os sete dias.

Limites locais conservadores ficam em `SOCIAL_LOCAL_LIMITS`, em `src/channels.ts`: 640 caracteres por entrega, incluindo assinatura; imagem até 3 MiB; áudio, vídeo e documento até 8 MiB. Os MIME permitidos são uma lista fechada; documentos sociais começam com PDF. Texto maior e texto acompanhado de imagem geram entregas ordenadas com chaves próprias. A assinatura social é texto simples. Menus compatíveis usam até três botões ou até treze respostas rápidas; os demais viram texto numerado. Formatos e limites remotos estão **a conferir com a conta real**, conforme [CANAIS-ZERNIO.md](CANAIS-ZERNIO.md).

Os módulos de negócio permanecem exclusivos do WhatsApp, inclusive quando a ficha social é juntada a um cadastro com telefone. As guardas do servidor complementam os controles da interface. Protocolos próprios e pesquisa de satisfação textual continuam possíveis em DM, sem ampliar o histórico acessível ao cliente.

## Identidade e junção

A chave social é área, namespace cadastral, canal, conta empresarial, namespace do sujeito e ID opaco. Nesta leva, o namespace do sujeito é `dm`. Nome e `username` são apresentação mutável; nunca são prova de telefone nem motivo para junção automática. A primeira mensagem cria contato, identidade e vínculos no mesmo lote da inbox e mensagem. IDs de perfil são dados pessoais: não substituem telefone, não aparecem desnecessariamente na ficha e participam do mascaramento para IA.

A junção exige `contacts:merge`, acesso às duas fichas, mesma área e namespace, versões e fingerprint da prévia. Por padrão, só preenche campos vazios. Uma ficha com vínculo ERP deve sobreviver; dois vínculos ERP diferentes impedem a operação. Jobs pendentes, restrições e colisões incompatíveis também impedem. A origem é arquivada como alias, sem apagar seu cadastro ou usar restrição de identidade como arquivo.

O adaptador central em `src/customer/merge-relations.ts` move apenas as relações previstas e guarda restauração cifrada. Não copia conteúdo privado nem concede papéis dos módulos. Novas referências cadastrais da outra frente exigem revisão explícita dessa allowlist antes do aceite.

Juntar não transfere credenciais entre canais. O cliente social continua restrito à identidade autenticada; o cliente WhatsApp, à prova telefônica efetiva da conversa. Desfazer exige nova chave idempotente e manifesto intacto: nova mensagem ou alteração relevante posterior retorna `409 merge_changed`. Restrições de dados impedem leitura e restauração que ressuscite uma ficha restrita. Não há promessa de eliminação física imediata de snapshots.

## Permissões e rotas

Todas as rotas de área abaixo usam `/api/v1/profiles/:profile`. Leituras conservam a autorização anterior; mutações passam pelo Coordinator e exigem `Idempotency-Key`. Replays são reautorizados.

| Rota | Uso |
|---|---|
| `GET /status` | Canais conectados/de conversa, modo multicanal e disponibilidade de transcrição |
| `GET /conversations?channel=...` | Filtro de canal validado antes da paginação |
| `GET /conversations/:id` | Canal, conta, janela, transcrição e outras conversas autorizadas |
| `GET /connections/:id/capabilities` | Capacidades antigas e novas derivadas do registro |
| `POST /connections` | Validação por canal e imutabilidade do canal existente |
| `POST /router/accounts/:id/discover-channels` | Descoberta social administrativa |
| `POST /router/accounts/:id/channel-connections` | Importação idempotente de conta social |
| `GET /contacts/:id/profile` | Ficha com canais e possibilidade de junção |
| `POST /contacts/:id/merge-preview` | Prévia do par de fichas |
| `POST /contacts/:id/merge` | Confirmação com versões, token e escolhas de campos |
| `POST /contacts/:id/merges/:mergeId/undo` | Desfazer com conferência do manifesto |
| `POST /conversations/:id/email/preview` | Prévia sem envio |
| `POST /conversations/:id/email` | Reserva e envio de uma transcrição |

Os webhooks Zernio existentes conservam a assinatura antes do processamento; não há nova rota pública alternativa. `conversations:email` e `contacts:merge` são permissões explícitas, fora da expansão de `*`; administradores começam autorizados. Aplicações precisam de leitura e exportação explícitas e não possuem destino `self`. Aplicações, bots e execuções delegadas não juntam contatos; bots e execução automática não exportam.

## Apresentação e demonstração

Área só WhatsApp mantém avatar, subtítulo, filtro, modelos e janela anteriores. A única ação adicional prevista é **Enviar conversa por e-mail**, para quem tem a permissão. Em área multicanal, o selo do canal ocupa o canto inferior direito do avatar e o estado, o superior direito. Cabeçalho e composer identificam o canal/conta; a janela vem do servidor. O filtro de canal participa do cache, reinicia paginação e descarta respostas atrasadas de outro filtro.

Android e iOS mantêm uma aba **Conversas**, canais da ficha somente para leitura e transcrição com prévia. Junção fica na web. Campos ausentes são tratados como servidor antigo; canal desconhecido não vira WhatsApp por exclusão. Push recebe o título pronto do servidor; o Android não acrescenta outro prefixo nem altera seus canais de notificação.

A demonstração web usa `/app?demo=1&channels=multichannel`. Sem `channels`, permanece a vitrine anterior. O encaixe em `web/lib/demo.ts` delega para `web/lib/demo-channels.ts`; não reescreve cenários dos módulos. Cenários adicionais: `whatsapp`, `legacy`, `email-unavailable`, `email-forbidden`, `email-unknown`, `email-failed` e `email-queued`.

As fixtures incluem menos de 24 h, 25 h e 168 h, duas conversas da mesma ficha, e-mail repetido, falta de configuração/permissão, mídia indisponível e eventos repetidos. São dados sintéticos e não comprovam formatos do fornecedor. O [registro de aceite](CANAIS-ACEITE.md) diferencia provas automatizadas, demonstração e pendências em aparelhos/contas reais.
