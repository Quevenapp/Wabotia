Corrigi a causa das três falhas: faltava `location` no ambiente dos novos testes, embora eles executassem a geração real de links. Acrescentei uma URL controlada, restauração dos globais após cada teste e quatro verificações dos destinos dos links. Nenhuma asserção anterior foi removida ou relaxada.

A correção está em [tests/os-web-review.test.ts](/Volumes/Dev/wabotia/codex/corr-painel/tests/os-web-review.test.ts:95). A suíte ainda precisa ser executada novamente fora da área restrita.

Segue o relato completo acumulado. Na coluna “Teste”, os cenários referem-se a esse arquivo, salvo indicação diferente; representam cobertura escrita, não uma nova execução de Vitest.

| Achado | Veredito | O que mudou / situação atual | Teste |
|---|---|---|---|
| **1. Orçamento sem versão esperada — grave** | **Confirmado e não corrigido integralmente** | O painel envia a versão-base, preserva o rascunho e oferece comparação/aceitação da versão atual. O servidor ainda ignora a versão recebida; a proteção contra sobrescrita permanece pendente. | Envio da versão; conflito simulado mantém preços digitados e só avança a versão após confirmação. |
| **2. Atualização do catálogo perde rascunhos** | Confirmado e corrigido | `useWorkResource` mantém os dados durante atualização do mesmo escopo; lista e conversa preservam a definição capturada ao abrir o formulário. Mudança de escopo descarta os dados anteriores. | Atualização do catálogo, isolamento entre áreas, resposta atrasada e preservação do tipo capturado. |
| **3. “Meus prazos” incompatível com servidor** | Não é real no estado atual: já integrado | O cliente usa `/service-orders/my-tasks`; o servidor aceita os filtros e acrescenta os metadados dos pais. Evidências: `web/modules/os/work-api.ts:169` e `src/modules/os/tasks/store.ts:171`. | Contrato da chamada no teste novo; integração existente em `tests/os-integration.test.ts:36`. |
| **4. Documentos restritos usam coleção comum** | Não é real no estado atual: já integrado | Listagem, reserva, upload, confirmação, download e arquivamento selecionam a rota privada. Envio ao cliente continua pela coleção comum. Evidências: `web/modules/os/work-api.ts:124` e `web/modules/os/documents/WorkDocumentsTab.tsx:57`. | Verificações das rotas privadas e da rota comum de envio. |
| **5. Escritas de tarefas restritas** | Confirmado e corrigido | A integração privada já existia. Foi reforçada para considerar tanto a classificação original quanto a proposta, e o diálogo mantém a classificação restrita após recuperação de conflito. | Rotas de conclusão, reabertura, cancelamento e mudança para sensível; recuperação do diálogo. |
| **6. Campos restritos sem metadados do snapshot** | **Confirmado e não corrigido** | A resposta comum remove as definições sensíveis; `/private-fields` retorna valores e versão, sem definições. O painel continua sem os metadados necessários. | Inspeção do contrato e das projeções. O teste com definições fornecidas artificialmente verifica apenas o comportamento condicional da tela; não comprova integração real. |
| **7. Revisão do tipo bloqueia orçamento antigo** | **Confirmado e não corrigido** | O detalhe ainda depende da definição atual com revisão igual à ordem. Faltam capacidades/política provenientes do snapshot autorizado. | Inspeção de `web/modules/os/work/WorkDetailPage.tsx:49` e `:266`; sem teste de integração que demonstre solução. |
| **8. Seleção do embutido mistura tipos** | Confirmado e corrigido | `ServiceOrdersPage` recebe `typeId="service_order"` nesse contexto. A entrada legada sem parâmetro conserva sua consulta anterior; contagens globais não foram alteradas. | Compara a consulta filtrada com a consulta legada. |
| **9. Orçamento no balcão tenta notificar** | Confirmado e corrigido | Sem conversa vinculada, envia `notify: false` e apresenta “Registrar orçamento sem envio pelo WhatsApp”. | Aciona o botão e verifica o corpo enviado; preserva também a chamada padrão do cliente. |
| **10. Filhos sem recuperação de conflito** | Confirmado e corrigido | Tarefas, pessoas e lançamentos mantêm rascunho, recarregam o registro e exigem aceitação antes de trocar a versão-base. Lançamentos já retificados mostram o sucessor e bloqueiam escrita no antecessor. | Recuperação dos três diálogos, busca paginada, cadeia de sucessores e bloqueio do antecessor. |
| **11. Opções são normalizadas a cada tecla** | Confirmado e corrigido | O rascunho conserva `options_text`; a conversão ocorre ao preparar o salvamento, sem enviar esse campo auxiliar. | Digitação caractere a caractere e verificação do DTO final. |
| **12. Limpar número opcional envia string vazia** | Confirmado e corrigido | Valores numéricos vazios viram `null`; chaves ausentes permanecem ausentes e zero continua válido. | Inteiro, decimal, espaços, ausência, zero e obrigatório. |
| **13. Conversa mostra apenas 50 trabalhos** | Confirmado e corrigido | A lista usa `Pager` e `next_cursor`, mantendo área e conversa na consulta. | Acesso ao 51º registro, cursor, escopo e links das duas páginas. |
| **14. Validade fixa em sete dias** | Confirmado e corrigido | Orçamento novo começa com validade vazia e omite `valid_days`, permitindo aplicar o padrão do snapshot. Orçamento existente conserva sua validade. | Ausência da chave no envio e preservação dos 30 dias existentes. |
| **15. Etapas `open`/`all` colidem com filtros** | Confirmado e corrigido | Valores internos separados: `stage:*` e `filter:*`. | Etapas chamadas `open` e `all` continuam enviadas como etapas. |
| **Afastamento: responsável, prazo geral e próxima tarefa na lista** | **Confirmado e não corrigido** | A consulta/DTO ainda não fornecem os filtros e resumo necessários. Não foi introduzida filtragem parcial no navegador. | Inspeção de `src/modules/os/contracts.ts:421` e `web/modules/os/work/WorkListPage.tsx:36`. |

Os demais afastamentos correspondem aos achados **3–5, 7 e 10**, tratados acima. O arquivo de revisão não contém uma seção adicional de “Suspeitas não confirmadas”.

Mudanças que ficaram para outras peças:

| Peça | Arquivo e mudança necessária | Motivo |
|---|---|---|
| **corr-motor / corr-f0** | Em `src/modules/os/contracts.ts:281`, acrescentar `version?: number` a `QuoteRequest`. Em `src/modules/os/store.ts:662`, validar a versão recebida em `saveQuote`, por exemplo com `checkVersion(order, data.version, false)`, preservando o replay idempotente existente em `os.ts`. | Fechar o achado 1, mantendo compatibilidade com clientes antigos que omitem a versão. |
| **corr-motor / corr-f0** | Ampliar `PrivateFields` em `contracts.ts:300` e a projeção autorizada em `privacy.ts:62` com definições sensíveis do snapshot. Depois, adaptar o botão e `PrivateFieldsDialog` para consumir esse contrato privado. | Resolver o achado 6 sem expor metadados sensíveis na resposta comum nem usar o cadastro atual. |
| **corr-motor / corr-f0** | Ampliar `WorkOrderAdditions` em `contracts.ts:134` e sua projeção em `work-types.ts:91` com capacidades/política de orçamento derivadas do snapshot e autorizadas. Depois, substituir a dependência do catálogo no detalhe. | Resolver o achado 7 sem reinterpretar ordens antigas. |
| **corr-motor / corr-f0** | Ampliar `OrderQuery`, o DTO da lista e `listOrders` em `store.ts:225` com responsável, intervalo de prazo e resumo da próxima tarefa autorizada, preservando paginação, `profile_id` e contagens globais. | Viabilizar os filtros e resumo faltantes no painel. |

Verificação atualizada:

- **TypeScript passou:** `npm_config_offline=true npx --no-install tsc --noEmit`.
- **`git diff --check` passou.**
- Reprodução isolada confirmou o erro sem `location` e os quatro links corretos com a URL controlada.
- O arquivo de regressão transpila sem erros de sintaxe.
- O log externo anterior registra **build aprovado e 225/228 testes aprovados**. Os três restantes falharam pela ausência de `location`; **não houve nova execução da suíte**.
- Sem commit, rede, Vitest ou migrações. Testes antigos permaneceram intactos; alterações limitadas a `web/` e ao novo teste web.