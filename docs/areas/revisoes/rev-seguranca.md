1. **Grave — o MCP permite consultar trabalhos de outro cliente atendido pelo mesmo bot.**  
   **Local:** `src/visibility.ts:44`; `src/mcp.ts:1100`; `src/modules/os/os.ts:420`.

   **Defeito:** a autorização verifica se algum bot da chave atende a conversa solicitada, mas não se ela pertence à execução que chamou a ferramenta.

   **Cenário:** duas conversas, A e B, da mesma área têm execuções no mesmo bot. Conhecendo o ID de B, o modelo que atende A chama `os_situacao` com `conversation_id=B`. O MCP conserva esse argumento; `boundAllows` aceita B e a ferramenta devolve seus trabalhos para a execução de A. B também passa nessa verificação durante dois minutos após a execução terminar. As ferramentas públicas de tarefas e documentos herdam a mesma falha ao receberem a conversa de B.

   O cabeçalho de execução não fecha esse caminho: `src/engine.ts:1575` só o emite para o contexto de pessoa, e `src/bot-actions/actions.ts:86` exclui desse contexto as execuções de atendimento ao cliente.

   **Correção:** vincular as chamadas MCP de atendimento a uma execução autenticada e fixar área e conversa no servidor. Desconsiderar `conversation_id` fornecido pelo modelo, como já faz `src/bot-actions/customer.ts:158`, e rejeitar chamadas de atendimento sem esse vínculo.

2. **Grave — uma mensagem personalizada válida pode bloquear os lembretes da área, inclusive os do tipo embutido.**  
   **Local:** `src/modules/os/store.ts:336`; `src/modules/os/reminders.ts:35`; `src/modules/hooks.ts:146`.

   **Defeito:** o limite é conferido antes da expansão dos marcadores, mas uma falha no envio do texto expandido interrompe toda a rodada de OS.

   **Cenário:** um tipo aceita dois campos públicos de texto, `a` e `b`, com limite de 2.000 caracteres, e configura `pickup_reminder_text="{campo_a}{campo_b}"`. Tanto a definição quanto os valores passam em `src/modules/os/validation.ts:60`, `:81` e `:204`. Uma ordem contém 2.000 caracteres ASCII em cada campo e torna-se a primeira retirada pendente.

   A expansão produz 4.000 caracteres; `src/modules/api.ts:761` rejeita mensagens acima de 3.800. A ordem não recebe `pickup_reminded_at`, permanece na frente nas rodadas seguintes e impede os demais lembretes de retirada, os avisos de paralisação e a execução das extensões. Isso também suprime avisos de ordens embutidas da mesma área.

   **Correção:** limitar ou dividir o resultado da expansão antes do envio. Isolar falhas por registro e adiar registros problemáticos, permitindo progresso dos seguintes, sem marcar como entregue um aviso que falhou.

3. **Média — a decisão de aprovação de etapa envia mensagem mesmo quando a aplicação não pode notificar a conversa.**  
   **Local:** `src/modules/os/motor-routes.ts:101`; `src/modules/os/stages.ts:108`.

   **Defeito:** a rota calcula `notifyCustomer`, mas não o repassa à aprovação, que envia a mensagem da etapa por padrão.

   **Cenário:** uma aplicação com leitura e escrita de conversas acessa uma ordem cuja conversa pertence a outro atendente. Existe aprovação de etapa pendente e válida. A aplicação envia `POST /api/v1/profiles/P/service-orders/O/stage-approval/decision`, com `decision="approve"` e versões corretas. `mayNotify` retorna falso, mas `decideStageApproval` chama `customMove` sem `notify:false`; `src/modules/os/stages.ts:52` envia a mensagem ao cliente.

   A regra existente permite alterar o estado sem avisar quando a aplicação não atende a conversa, conforme `src/modules/os/os.ts:327`.

   **Correção:** repassar a autorização de notificação até `decideStageApproval` e `customMove`, preservando-a também nas retomadas idempotentes. O fluxo de resposta autenticada do cliente pode autorizar explicitamente sua própria notificação.

4. **Média — tarefas sem destinatário utilizável bloqueiam indefinidamente os lembretes seguintes.**  
   **Local:** `src/modules/os/tasks/reminders.ts:72`; `src/modules/os/tasks/reminders.ts:92`.

   **Defeito:** tarefas impossíveis de notificar permanecem no início da seleção, sem cursor, adiamento ou tratamento que permita alcançar as seguintes.

   **Cenário:** a equipe cria uma ordem de tipo com tarefas habilitadas, informando apenas telefone, sem conversa — permitido em `src/modules/os/store.ts:394`. Nela, cria dez tarefas públicas para `audience="customer"`, com lembretes vencidos anteriores aos demais. A criação é aceita por `src/modules/os/tasks/store.ts:37`, pois `mayNotify` aceita ausência de conversa em `src/modules/api.ts:624`.

   Cada rodada seleciona novamente essas primeiras tarefas. O ramo sem `conversation_id` apenas retorna à próxima iteração, deixando-as pendentes. Tarefas posteriores, inclusive com destinatários válidos, nunca são alcançadas; `has_more` continua solicitando novas rodadas.

   **Correção:** impedir o agendamento para cliente sem destinatário verificável ou manter um estado de adiamento/reavaliação separado. A seleção precisa avançar sobre registros temporariamente impossíveis de entregar, sem marcá-los como notificados.

## Resultado dos oito caminhos de ataque

“Consegui” indica um caminho demonstrado pela leitura do código; não foram executados testes, requisições ou alterações.

1. **Equipe da área A acessar dados da área B — não consegui.**  
   A autorização confere a área em `src/security.ts:150`, e o pai é carregado com `profile_id` em `src/modules/os/store.ts:208`. Tarefas, pessoas, documentos e lançamentos acrescentam o pai às consultas: `tasks/store.ts:20`, `people/store.ts:73`, `documents/access.ts:41` e `entries/store.ts:113`, todos sob `src/modules/os/`. Os parâmetros da rota prevalecem sobre o corpo em `src/modules/hooks.ts:356`. Os cursores dos filhos validam seu contexto; mesmo o cursor numérico legado não remove o filtro de área. Nada encontrado nesse caminho.

2. **Pessoa sem papel ler valores sensíveis — não consegui.**  
   `src/modules/os/privacy.ts:44` exige pessoa autenticada, papel explícito `os:sensitive` e ausência de atuação por bot, módulo ou credencial limitada. O administrador não recebe exceção. Downloads repetem a autorização e conferem a classificação em `src/modules/os/documents/access.ts:57`; o envio rejeita documento sensível em `documents/delivery.ts:32`.

   As listas filtram registros sensíveis antes da paginação, e os totais de lançamentos reutilizam esse filtro em `entries/store.ts:48` e `:104`. A busca de ordens não pesquisa `extra_json` (`store.ts:254`); a exportação inclui definições, não valores de atendimentos (`src/area-templates/engine.ts:220`). O histórico novo guarda referências e nomes de campos, sem seus valores. Nada encontrado em leitura direta, exportação, histórico, erros, busca ou contagem que revele valores classificados como sensíveis.

3. **Cliente pelo WhatsApp acessar outro cliente — consegui pelo MCP/Hermes, conforme o achado 1.**  
   Nos caminhos diretos, telefone alegado não substitui a identidade: a consulta usa `verifiedPhone` em `src/modules/os/store.ts:1074`. Número de ordem adivinhado permanece condicionado à conversa ou ao telefone verificado em `store.ts:995` e `stage-replies.ts:22`. Botões conferem conversa e versão em `store.ts:957`, `:969`, `stage-replies.ts:20` e `stages.ts:99`. A reutilização de passo web já concluído é rejeitada em `src/web-steps.ts:838`, com confirmação condicional em `:886`.

4. **Aplicação limitada ultrapassar sua autorização — consegui no envio provocado pela decisão de etapa, conforme o achado 3.**  
   A aplicação pode modificar o estado, mas consegue produzir uma mensagem apesar de `mayNotify=false`. Não encontrei dispensa dos escopos declarados de leitura/escrita: eles são exigidos em `src/modules/os/public.ts:79` e nas rotas binárias em `src/modules/api.ts:1574` e `:1605`. As rotas de modelos exigem administrador humano em `src/modules/api.ts:1642`.

5. **IA receber dados sensíveis ou de outra conversa — consegui receber dados de outra conversa pelo achado 1.**  
   Não consegui obter valores classificados como sensíveis. A proibição independe do modo de mascaramento em `src/modules/os/privacy.ts:44`; as projeções públicas removem campos privados em `:116`, e documentos sensíveis são barrados antes da leitura. O adaptador de IA direto fixa a conversa da execução em `src/bot-actions/customer.ts:158`; a falha confirmada está no caminho MCP.

6. **Modelo alterar outra área, ligar seus módulos ou executar conteúdo — não consegui.**  
   O manifesto aceita apenas propriedades declaradas em `src/area-templates/validation.ts:219`; referências de menus ficam restritas ao próprio manifesto em `:247`. A prévia inclui a área no hash (`engine.ts:176`) e a aplicação grava a procedência nessa mesma área (`engine.ts:208`). HTML e esquemas executáveis são rejeitados em `validation.ts:22`; marcadores de mensagens são limitados aos nomes permitidos e campos públicos não sensíveis em `src/modules/os/validation.ts:80`.

   O papel `admin` existente é global (`src/security.ts:147`); selecionar outra área com esse papel não demonstra fuga introduzida pelo importador. Nada encontrado nas peças de modelos.

7. **Negação de serviço barata — consegui pelos achados 2 e 4.**  
   Não encontrei ausência de limite nos vetores examinados de corpo, quantidade de campos ou arquivo: há limite geral de corpo em `src/index.ts:238`, manifesto de 128 KiB em `src/area-templates/validation.ts:217`, até 20 tipos e 24 campos por tipo em `src/modules/os/validation.ts:146` e `:92`, e contagem real de até 10 MiB no upload em `src/modules/binary.ts:14`. As coleções filhas têm paginação e limites de quantidade. Os caminhos confirmados de bloqueio estão nos lembretes.

8. **Persistir JSON inválido ou etapa inexistente que quebre leituras posteriores — não consegui.**  
   Os valores extras passam por validação de estrutura, tipo e tamanho em `src/modules/os/validation.ts:178` e são serializados pelo servidor. A transição precisa existir e partir da etapa atual em `src/modules/os/stages.ts:62`; o destino é resolvido na definição antes da gravação em `:36`. As mutações usam controle de versão e as migrações acrescentam restrições de persistência. O achado 2 quebra processamento posterior de notificações com valores válidos, não a leitura de JSON ou a existência da etapa.

Nas implementações próprias de `people/`, `documents/`, `entries/`, `area-templates/`, `binary.ts` e `queue-tools.ts`, nada encontrado além dos efeitos do caminho compartilhado já apontado. Esses arquivos foram lidos integralmente. Nas migrações `0100` a `0105`, nada encontrado de destrutivo; são aditivas. Não há nova classe de Durable Object nos arquivos revisados.

## Afastamentos do contrato

- **Achado 1:** a conversa de atendimento pode vir do argumento do modelo, contrariando a identidade conferida no servidor exigida em `docs/areas/CONTRATO-MOTOR.md:951` e o isolamento entre titulares exigido em `:1504`.
- **Achado 2:** trabalhos personalizados podem suprimir notificações do embutido, contrariando a preservação dos momentos de envio em `docs/areas/CONTRATO-MOTOR.md:423`.
- **Achado 3:** a aplicação que não atende a conversa consegue enviar aviso, contrariando a proteção expressamente preservada em `docs/areas/CONTRATO-MOTOR.md:1375`.
- **Achado 4:** a próxima rodada não alcança o trabalho restante; repete as mesmas tarefas inviáveis, frustrando a continuação prevista em `docs/areas/F0-ENTREGA.md:43`.

Arquivos lidos inteiros — notação `{a,b}` agrupa nomes: `docs/areas/{CONTRATO-MOTOR,F0-ENTREGA}.md`; `docs/areas/relatos/{motor-a,motor-c,motor-d,motor-l,motor-m,motor-o,motor-p,motor-t,motor-w,motor-modelo-condominio,motor-modelo-ensino,motor-modelo-juridico,motor-modelo-obras,motor-modelo-saude,motor-modelo-servicos}.md`; `src/modules/os/{contracts,definition,model,os,public,privacy,store,mutations,stages,stage-replies,work-types,validation,motor-routes,forms,reminders,extensions,extension-runtime}.ts`; `src/modules/os/tasks/{extension,model,reminders,stages,store}.ts`; `src/modules/os/people/{extension,model,privacy,store}.ts`; `src/modules/os/entries/{extension,model,store}.ts`; `src/modules/os/entries/README.md`; `src/modules/os/documents/{access,model,store,extension,transport,delivery,cleanup}.ts`; `src/modules/os/documents/INTEGRACAO.md`; `src/area-templates/{engine,index,validation}.ts`; `src/area-templates/models/{advogados,arquitetos,assistencia-tecnica,clinica-medica,clinica-veterinaria,condominios,construtoras,engenheiros,escolas,escritorio-advocacia,exemplos,lavanderia-costura,oficina-mecanica,professores,servicos}.ts`; `src/modules/{api,binary,hooks,queue-tools,schedule}.ts`; `src/{security,visibility,bot-tools}.ts`; `src/bot-actions/{actions,catalog,customer,describe}.ts`; `migrations/{0100_os_work_types,0101_os_tasks,0102_os_people,0103_os_documents,0104_os_entries,0105_os_area_templates}.sql`.