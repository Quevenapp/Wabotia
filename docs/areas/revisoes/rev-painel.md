1. **`web/modules/os/work/QuoteEditor.tsx:40` — grave.** O orçamento é salvo sem a versão que o editor carregou, permitindo sobrescrever alterações concorrentes silenciosamente.

   **Cenário:** duas pessoas abrem o mesmo orçamento; a primeira salva novos preços; a segunda salva seu rascunho antigo → os preços anteriores substituem os novos, sem conflito. O comando relê a ordem atual antes de gravar (`src/modules/os/os.ts:350`), e `saveQuote` não compara uma versão recebida do editor.

   **Correção:** acrescentar versão esperada ao DTO e à validação do comando, mantendo compatibilidade dos clientes antigos. No editor novo, enviar a versão carregada e preservar o rascunho quando houver conflito.

2. **`web/modules/os/work/WorkListPage.tsx:212` — média.** A atualização do catálogo desmonta formulários abertos e perde rascunhos sem confirmação.

   **Cenário:** alguém preenche uma ordem personalizada enquanto outro administrador altera uma configuração da área → a atualização periódica de `/status` muda `settings_revision`; o catálogo fica temporariamente sem dados e a linha 223 substitui toda a tela por carregamento. O formulário é desmontado, apesar de estar sujo. O mesmo acontece em `ConversationWorkOrders.tsx:28`.

   **Correção:** atualizar o catálogo em segundo plano, preservando a tela e a definição usada pelo formulário aberto. Desmontar imediatamente apenas quando mudar o escopo de área ou registro, com a guarda correspondente.

3. **`web/modules/os/work-api.ts:133` — média.** “Meus prazos” usa caminho, filtros e resposta incompatíveis com a entrega de T.

   **Cenário:** abrir a tela com tarefas atribuídas → W chama `/work-tasks`, mas T declara `/service-orders/my-tasks` (`src/modules/os/tasks/extension.ts:16`). Mesmo corrigindo apenas o caminho, T rejeita `assignee`, `period` e `type_id`, e retorna `Task`, sem os metadados exigidos pelos links da tela.

   **Correção:** unificar caminho, filtros e DTO entre W e T. Implementar os filtros e metadados na consulta agregada do servidor. Registrar o descritor existente, sozinho, não resolve essa incompatibilidade.

4. **`web/modules/os/work-api.ts:89` — média.** O painel usa exclusivamente a coleção comum para documentos, tornando documentos sensíveis inoperáveis.

   **Cenário:** uma pessoa com `os:sensitive` marca um arquivo como restrito e salva → a reserva em `/documents` recebe `403 sensitive_forbidden` (`src/modules/os/documents/store.ts:55`). Documentos restritos já existentes também não aparecem, pois a lista comum consulta somente `sensitive=0`.

   **Correção:** integrar `/private-documents` para listagem, reserva, upload, confirmação, download e arquivamento autorizados. Manter o envio ao cliente restrito à coleção compartilhável.

5. **`web/modules/os/work-api.ts:79` — média.** As escritas de tarefas sensíveis são encaminhadas à rota comum, que sempre as recusa.

   **Cenário:** pessoa autorizada cria uma tarefa restrita, ou tenta editar/concluir uma tarefa restrita existente → W chama `/tasks`; T exige `/private-tasks` e responde `403`, inclusive para quem tem o papel (`src/modules/os/tasks/store.ts:34` e `:68`).

   **Correção:** selecionar a operação privada conforme a classificação original e proposta da tarefa, incluindo ações rápidas de conclusão, reabertura e cancelamento.

6. **`web/modules/os/work/WorkDetailPage.tsx:250` — média.** O acesso aos campos restritos depende de definições que a resposta comum nunca contém.

   **Cenário:** ordem com campo sensível e usuário com `os:sensitive` → `workOrderAdditions` remove todos os campos sensíveis de `order.fields` (`src/modules/os/work-types.ts:96`), portanto o botão nunca aparece. Mesmo montado, `PrivateFieldsDialog.tsx:28` obteria uma lista vazia de controles.

   **Correção:** disponibilizar metadados autorizados dos campos do snapshot, separadamente dos valores comuns, e usá-los no diálogo privado. Não substituir o snapshot pela definição atual do tipo.

7. **`web/modules/os/work/WorkDetailPage.tsx:49` — média.** Alterar a revisão do tipo impede montar ou editar orçamentos de ordens anteriores.

   **Cenário:** uma ordem foi aberta na revisão 1; o administrador apenas renomeia um rótulo, gerando revisão 2 → `type` vira `undefined` e o botão de orçamento da linha 266 desaparece, embora a política do snapshot continue permitindo a operação.

   **Correção:** obter capacidades e política de orçamento do snapshot autorizado da ordem. A revisão atual do cadastro não pode determinar se uma ordem antiga continua operável.

8. **`web/modules/os/work/WorkListPage.tsx:260` — média.** Selecionar o tipo embutido apresenta registros de todos os tipos na tela legada.

   **Cenário:** a área possui OS e processos personalizados; selecionar “Ordens de serviço” → `ServiceOrdersPage` consulta sem `type_id` (`ServiceOrdersPage.tsx:654`). Processos aparecem como OS e abrem no detalhe antigo, sem campos extras e transições próprias.

   **Correção:** permitir que a tela legada receba o filtro explícito `type_id=service_order` nesse contexto. Preservar a semântica global de `counts`, conforme o contrato.

9. **`web/modules/os/work-api.ts:69` — média.** O fluxo novo não permite registrar orçamento de trabalho sem conversa vinculada.

   **Cenário:** criar um trabalho no balcão, informando telefone, e clicar em “Enviar orçamento” → W envia `{}`; o servidor tenta notificar e retorna `409 no_conversation` (`src/modules/os/store.ts:809`). A tela antiga enviava `notify: false` nesse caso.

   **Correção:** aceitar `QuoteSendRequest` no cliente e enviar `notify: false` quando não houver conversa, apresentando a ação como registro sem envio pelo WhatsApp.

10. **`web/modules/os/tasks/TaskDialog.tsx:70` — média.** Após conflito, os formulários filhos não oferecem recuperação preservando o rascunho e continuam usando a versão antiga.

    **Cenário:** outra pessoa altera a tarefa durante a edição → salvar mostra `version_conflict`, mas todas as tentativas seguintes usam `initial.version`. Para obter a versão atual, é necessário fechar o diálogo, descartar o rascunho e atualizar a coleção. O mesmo padrão ocorre em `people/WorkPeopleTab.tsx:49` e `entries/WorkEntriesTab.tsx:75`.

    **Correção:** manter a versão-base em estado separado e oferecer recarga do registro com comparação/reconciliação do rascunho. Se um lançamento já tiver sido retificado, informar o sucessor sem apagar o texto digitado.

11. **`web/modules/os/types/FieldsEditor.tsx:169` — média.** O editor de opções transforma e apara o texto a cada tecla, alterando o que a pessoa digita.

    **Cenário:** tentar escrever `alta: Muito urgente` → o espaço digitado depois de “Muito” é removido imediatamente pelo `trim()`, produzindo “Muitourgente” na digitação sequencial. Digitar um identificador ainda sem `:` também insere o separador automaticamente e interfere na continuação.

    **Correção:** manter o conteúdo bruto da textarea no rascunho e converter para opções ao validar/salvar, preservando entradas parciais.

12. **`web/modules/os/components/ExtraFields.tsx:124` — média.** Limpar um campo numérico opcional envia string vazia em vez de ausência de valor.

    **Cenário:** campo inteiro opcional contém `10`; a pessoa apaga o conteúdo e salva → `parseExtra` mantém `""`; o servidor exige número ou `null` e retorna `invalid_fields` (`src/modules/os/validation.ts:194`).

    **Correção:** converter explicitamente o campo numérico vazio para `null`. Não omitir a chave durante edição, pois isso conservaria o valor anterior.

13. **`web/modules/os/ConversationWorkOrders.tsx:39` — média.** A lista da conversa limita a consulta a 50 trabalhos e ignora `next_cursor`.

    **Cenário:** uma conversa possui 51 trabalhos abertos → apenas os 50 mais recentes aparecem, sem indicação de truncamento nem ação para alcançar o restante.

    **Correção:** oferecer paginação ou “Carregar mais”, usando o cursor devolvido e mantendo o escopo da conversa.

14. **`web/modules/os/work/QuoteEditor.tsx:25` — média.** O editor substitui a validade padrão configurada no tipo por sete dias.

    **Cenário:** tipo com `default_valid_days=30`, ordem ainda sem orçamento → o editor começa com `7` e envia esse valor explicitamente. O servidor deixa de aplicar os 30 dias do snapshot (`src/modules/os/store.ts:817`).

    **Correção:** usar o padrão autorizado do snapshot ou permitir valor vazio e omitir `valid_days`, deixando o servidor resolver a política.

15. **`web/modules/os/work/WorkListPage.tsx:117` — média.** Os filtros especiais `open` e `all` colidem com identificadores válidos de etapas.

    **Cenário:** um tipo contém uma etapa com ID `open` → selecioná-la aplica “Abertas” e remove o filtro `stage`, exibindo também outras etapas. Uma etapa chamada `all` sofre o mesmo problema com “Todas”.

    **Correção:** usar valores distintos para filtros especiais e etapas, por exemplo `filter:open` e `stage:open`, sem restringir IDs válidos do contrato.

## Partes sem achados adicionais

- **Área somente com o embutido:** nada encontrado no fluxo operacional legado e nas alterações de configuração/menu, considerando a comparação disponível em `_antes/`. Foram lidos os componentes legados, os seletores de experiência e os registros web.
- **HTML e armazenamento:** nada encontrado de inserção de texto do servidor como HTML ou persistência de valores sensíveis em armazenamento do navegador nos componentes revisados.
- **Respostas atrasadas e falhas de leitura:** nada encontrado de substituição por resposta de uma chave anterior em `useWorkResource`. `ResourceState` trata rejeições 404 e `not_implemented`; o problema de desmontagem está no achado 2.
- **Paginação das abas:** nada encontrado em `ChildCollection` e nas abas de tarefas, pessoas, documentos, lançamentos e histórico. A exceção está na lista da conversa.
- **Celular:** nada encontrado na leitura de `work.css`, `os.css` e da estrutura dos componentes. Não houve validação visual.
- **Modelos de área:** nada encontrado na leitura de `AreaTemplatesPage.tsx` e `template-import.ts` quanto à apresentação de erros, invalidação da prévia após mudanças e envio do hash de aplicação.

## Afastamentos do contrato

- As ordens antigas deixam de conservar a operação de orçamento após revisão do tipo, contrariando a seção 3, regra 6, do contrato — achado 7.
- A recuperação de conflitos dos formulários filhos não atende à preservação com recarga prevista em `painel.md`, seção 4 — achado 10.
- Os complementos de API adotados por T e D não foram coordenados com W: consulta agregada, tarefas privadas e documentos privados possuem consumidores incompatíveis — achados 3 a 5. São diferenças de interface, não ausência de registro central.
- A lista não implementa os filtros por responsável e prazo geral nem o resumo da próxima tarefa previstos em `painel.md`, seção 3. A limitação está declarada em `W-ENTREGA.md`, mas muda o comportamento entregue; depende de ampliar os DTOs e a consulta do servidor.

**Arquivos lidos inteiros:** `docs/areas/CONTRATO-MOTOR.md`, `docs/areas/F0-ENTREGA.md`, `docs/areas/painel.md`, `docs/areas/relatos/{motor-w.md,motor-t.md,motor-d.md}`; `web/modules/os/{W-ENTREGA.md,work-api.ts,work-contracts.ts,work-hooks.tsx,work-navigation.ts,work-vocabulary.ts,work.css,os.css,shared.ts,ServiceOrdersPage.tsx,ServiceOrdersSettingsPage.tsx,ConversationServiceOrders.tsx,ConversationWorkOrders.tsx}`; `web/modules/os/components/{AssigneeField.tsx,ChildCollection.tsx,ExtraFields.tsx,StagePill.tsx}`; `web/modules/os/work/{WorkListPage.tsx,WorkDetailPage.tsx,WorkFormDialog.tsx,PrivateFieldsDialog.tsx,QuoteEditor.tsx}`; `web/modules/os/types/{WorkTypesPage.tsx,type-draft.ts,FieldsEditor.tsx,StagesEditor.tsx,ResourcesEditor.tsx}`; `web/modules/os/tasks/{MyDeadlinesPage.tsx,TaskDialog.tsx,WorkTasksTab.tsx}`; `web/modules/os/people/WorkPeopleTab.tsx`; `web/modules/os/documents/WorkDocumentsTab.tsx`; `web/modules/os/entries/WorkEntriesTab.tsx`; `web/modules/os/history/WorkHistoryTab.tsx`; `web/{menu-tree.ts,workspace-navigation.ts}`; `web/admin/{AdminArea.tsx,shared.tsx}`; `web/admin/area-templates/{AreaTemplatesPage.tsx,template-import.ts}`; `web/lib/{routes.ts,api.ts}`; `web/app/hooks.ts`; `web/modules/conversation.tsx`; `src/modules/os/{privacy.ts,work-types.ts,motor-routes.ts}`; `src/modules/os/tasks/{extension.ts,model.ts,store.ts}`; `src/modules/os/people/{store.ts,privacy.ts}`; `src/modules/os/documents/{extension.ts,access.ts}`; versões disponíveis em `_antes/web/` dos seis arquivos comparados: `menu-tree.ts`, `workspace-navigation.ts`, `admin/AdminArea.tsx`, `lib/routes.ts`, `modules/conversation.tsx` e `modules/os/ServiceOrdersSettingsPage.tsx`.