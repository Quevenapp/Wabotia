# Jurídico: calendários e prazos

Extensão `juridico`, desligada por padrão, dependente de `os`. O processo continua sendo um trabalho do motor; cada prazo cria uma tarefa comum sensível, com responsável e vencimento. Não há novo Durable Object, binding, banco, bucket ou serviço externo.

**Cálculo auxiliar: confira o calendário, a regra e o resultado com o advogado antes de usar.** Registrar conferência significa registrar uma ação humana; não certifica a correção jurídica do resultado.

## Uso

1. Depois da integração abaixo, ative `os` e `juridico` em Módulos. O tipo de trabalho usado pelo processo precisa ter tarefas habilitadas em seu snapshot.
2. Em Pessoas e acessos, conceda `os:sensitive` e `juridico:lawyer` aos advogados. Conceda também `juridico:curator` a quem mantém calendários. Administrador e acesso `*` não substituem esses papéis. O responsável precisa ser uma pessoa ativa da área com os dois primeiros papéis.
3. Abra Gestão → Jurídico → Prazos → Calendários. Cadastre nome, âmbito efetivo (UF, município, órgão, tribunal e unidade), fuso IANA, cobertura e dias da semana não úteis. Não há calendário global compartilhado entre áreas.
4. A carga opcional inclui exclusivamente nove datas nacionais fixas: 01/01, 21/04, 01/05, 07/09, 12/10, 02/11, 15/11, 20/11 e 25/12. Cada ocorrência e o calendário ficam marcados **“Confira antes de usar”**. A lista não comprova aplicabilidade histórica ou ao órgão. Feriados móveis e locais devem ser cadastrados e conferidos pelo curador.
5. Cadastre feriados nacionais, estaduais, municipais, do tribunal, suspensões e recesso com intervalo inclusivo, fonte e âmbito. Escolha o efeito: contagem, início, vencimento ou os três. Recesso não significa suspensão automática de todos os prazos.
6. Em Novo prazo, selecione processo, providência, advogado e calendário. O advogado informa o termo inicial; o sistema não o infere de mensagens, publicações ou ciência. Informe quantidade, regras de início e vencimento, horário limite e antecedência do aviso.
7. Simule e leia a memória diária. Crie a tarefa pendente de conferência. Abra o detalhe, confira os dados e registre a conferência em uma ação separada. Para cumprir, registre uma referência da providência (por exemplo, documento ou protocolo); a evidência permanece privada.
8. Use a lista por vencimento, responsável ou processo, os filtros de responsável/estado e a paginação. Os avisos destinados à pessoa autenticada ficam em “Avisos para mim”. Ler um aviso não cumpre a tarefa.

## Semântica da contagem

- Datas civis são `YYYY-MM-DD`, entre 2000 e 2100; não usam o fuso do servidor.
- Primeiro ajusta-se o termo inicial se ele for não útil para **início**: avançar, recuar ou recusar. Depois se inclui ou exclui esse termo ajustado. Exemplo: sábado ajustado para segunda e início excluído faz a contagem começar na terça.
- Contam-se de 1 a 366 dias úteis para **contagem**. Dias da semana configurados, feriados e intervalos com efeito de contagem são excluídos. Ocorrências sobrepostas não descontam duas vezes.
- Ao atingir a quantidade, aplica-se a regra de **vencimento**. Isso importa para ocorrências que só afetam o vencimento. Pode avançar, recuar ou recusar; recuo anterior ao início é rejeitado.
- O horário limite é obrigatório, sem padrão de 23:59. Fuso e horário são guardados na memória. Horários inexistentes ou ambíguos em transições de fuso são recusados.
- A antecedência vai de 0 a 60 dias úteis para contagem, recuados desde o vencimento. Zero significa no próprio dia. O horário do aviso deve ser anterior ou igual ao limite. A cobertura também precisa abranger esse recuo.
- Cobertura insuficiente impede criação. Em recálculo, mantém a data anterior e abre aviso de erro para conferência. Não há extrapolação silenciosa além da cobertura.
- Limites: 100 calendários por área, cobertura de até 3.660 dias, 300 ocorrências por calendário, memória diária de até 750.000 bytes e limite de 500 tarefas por trabalho herdado do motor.

## Revisões, recálculo e cumprimento

Salvar um calendário sempre cria uma versão nova com cópia integral; versões antigas não são editadas pelas rotas. O comando exige a revisão lida. Prazos guardam calendário, regra, algoritmo `business-days-v1`, caminho diário, fontes, termo ajustado, vencimento local/UTC e aviso. A criação da tarefa, do prazo e da primeira memória é uma única transação através de `commitChild`; histórico/eventos levam apenas identificadores, versões e nomes de campos.

O agendador encontra tarefas abertas cujo calendário tem revisão nova. O recálculo cria outra memória e um aviso interno durável. O detalhe compara a data anterior com a nova e oferece todas as memórias anteriores. Mesmo que a data não mude, a revisão exige nova conferência.

Se a nova data for posterior, a tarefa conserva a anterior até a conferência; se for anterior, a tarefa é antecipada e o aviso exige atenção. O aviso fatal também conserva o instante mais cedo enquanto houver pendência. A conferência usa a revisão atual e só então adota integralmente o novo cálculo. Enquanto o recálculo estiver na fila, a conferência é bloqueada.

Tarefa cumprida ou cancelada não é recalculada. Gatilhos aditivos protegem os vínculos jurídicos contra reabertura, mudança genérica de prazo/responsável, arquivamento, exclusão ou retirada de sigilo. As rotas genéricas ainda podem concluir/cancelar uma tarefa; conclusão por elas não produz referência jurídica de cumprimento. O fluxo recomendado é registrar cumprimento em Prazos. A extensão não impede encerramento do trabalho com prazo aberto.

## Avisos e privacidade

O canal entregue nesta versão é a **caixa interna do painel**, destinada ao responsável. A inserção em `jur_alerts` é a entrega durável; não há marca de “enviado” separada nem chamada de rede. A unicidade por área/prazo/revisão/tipo evita repetição. Falha de inserção mantém o item elegível para outra rodada. A tela consulta avisos a cada 30 segundos quando visível e ao atualizar. O agendador existente roda no Coordinator (normalmente a cada minuto, com acionamento periódico pelo núcleo); não é um serviço com garantia de disparo no segundo exato.

Avisos de recálculo/erro entram na mesma transação da revisão. Avisos fatais aparecem quando chega a antecedência, inclusive se o disparo foi retomado depois do vencimento. Só destinatário pode listar/reconhecer; reconhecimento não significa cumprimento. Avisos de revisões substituídas e tarefas encerradas permanecem guardados, mas saem da caixa corrente. Há até 100 avisos não lidos por consulta; ao reconhecer, os seguintes aparecem.

Todas as tabelas novas têm `profile_id`; referências compostas conferem área, processo e tarefa. Rotas privadas exigem pessoa humana, `os:sensitive` e papel jurídico. Atuação por bot, mesmo sem máscara e em nome de administrador, aplicação, conector ou credencial limitada é recusada. `bot.deny` exclui todas as leituras e operações jurídicas; `bot.sensitive` acrescenta classificação das operações, sem substituir a barreira do manipulador.

As projeções de `os/privacy.ts` filtram os DTOs; a tarefa é sempre `sensitive=true`, `client_visible=false`, `audience=staff`, com título genérico, sem narrativa jurídica. Não há rota pública, menu WhatsApp ou ferramenta IA desta extensão. A consulta comum do cliente continua autorizada pelo telefone verificado da conversa e não recebe esses filhos. Cadastro de parte, advogado ou representante não concede acesso externo.

O papel de advogado autoriza os prazos **da área**, não uma ACL por processo. Para casos que exijam equipes segregadas, use áreas separadas. Não coloque segredos nos campos públicos `item`/`problem` do motor. Conteúdo jurídico não é publicado em mensagens, eventos ou histórico comum.

## API da extensão

Base: `/api/v1/profiles/{profile}/juridico`. Escritas usam `Idempotency-Key` e o Coordinator existente. O perfil vem da sessão/caminho; campos extras no corpo são rejeitados.

| Método | Caminho | Uso |
|---|---|---|
| GET | `/calendars` | Até 100 calendários, revisão atual e alerta da carga inicial |
| POST | `/calendars` | `{calendar, seed_national?}`; exige curador |
| PUT | `/calendars/{id}` | `{revision, calendar}`; nova revisão |
| GET | `/assignees` | Advogados ativos com acesso sensível |
| POST | `/preview` | `{calendar_id, calendar_revision, rule}`; cálculo sem tarefa |
| POST | `/deadlines` | `{order_id, calendar_id, calendar_revision, title, assignee, rule}` |
| GET | `/deadlines` | `sort=due|assignee|process`, `state=open|done|cancelled|all`, `assignee`, `order_id`, `cursor`; páginas de dez |
| GET | `/deadlines/{id}` | Detalhe e memória; `revision=N` recupera memória anterior |
| POST | `/deadlines/{id}/confirm` | `{version, task_version, checked:true}` |
| POST | `/deadlines/{id}/complete` | `{version, task_version, evidence}` |
| GET | `/alerts` | Caixa interna do solicitante |
| POST | `/alerts/{id}/acknowledge` | Reconhecimento pelo destinatário |

`rule` contém `start_date`, `days`, `include_start`, `start_non_working`, `due_non_working`, `due_time`, `alert_days`, `alert_time`. As políticas de ajuste são `next|previous|reject`. `calendar` contém `name`, `jurisdiction`, `from`, `to`, `timezone`, `weekend` (domingo=0) e `events`. Cada evento contém `id`, `name`, `from`, `to`, `kind`, `effect`, `source`; categorias e efeitos são os apresentados na tela.

Erros principais: `400 invalid_request`, `403 sensitive_forbidden|forbidden`, `404 not_found`, `409 module_disabled|feature_disabled|version_conflict`, `422 calendar_coverage|start_non_working|due_non_working|due_before_start|ambiguous_time|alert_after_due|calculation_limit`. Erros de validação identificam campos, sem reproduzir valores privados.

## Integração: linhas exatas, ainda não aplicadas

Nenhum arquivo preexistente foi alterado. Aplicar as migrações **0106, 0107 e 0108**, após 0100/0101. O glob atual de migrações já as encontra. A extensão precisa da implementação real de `commitChild` e das tarefas comuns; o esqueleto F0 que responde 501 não basta.

Em `src/modules/registry.ts`, junto aos imports:

```ts
import { juridicoModule } from "./juridico/definition";
```

Dentro de `modules`:

```ts
  juridicoModule,
```

Em `src/modules/runtime.ts`, no bloco de integração:

```ts
import { registerJuridico } from "./juridico/juridico";
registerJuridico();
```

Essa chamada registra exatamente `juridicoReads`, `juridicoWrites`, `juridicoCommands` e **um** `onSchedule("juridico", scheduleJuridico)`. Não acrescentar a `os/extensions.ts`, não criar `onSchedule("os")` e não repetir os registros manualmente. A rodada própria limita a dez itens/200 instruções e mede SQL dos serviços chamados; o orçamento agregado com os demais módulos deve ser conferido na integração.

Em `src/modules/os/definition.ts`, se ainda ausentes da integração M/T, acrescentar em `events`:

```ts
    "os.task.created",
    "os.task.updated",
```

E em `grants`, se ainda ausente:

```ts
    { id: "sensitive", label: "Acesso sensível", description: "Acesso humano explícito aos campos e filhos sensíveis do motor." },
```

As rotas de tarefa comuns e privadas continuam dependendo do registro de `tasksExtension` previsto em `docs/areas/F0-ENTREGA.md`. Jurídico usa `public.ts`/`privacy.ts` e os tipos públicos; não importa stores internos para operar o motor.

Em `web/workspace-navigation.ts`, dentro de `sections`:

```ts
  ["juridico", "Prazos", CalendarClock],
```

Dentro de `workspaceGroups`:

```ts
  { id: "juridico", label: "Jurídico", icon: CalendarClock, pages: ["juridico"] },
```

Dentro de `pageModules`:

```ts
  juridico: "juridico",
```

Dentro de `railPages`:

```ts
  { page: "juridico", label: "Prazos", icon: CalendarClock },
```

`CalendarClock` já está importado. Não acrescentar a `adminPages`: advogado não precisa ser administrador. As permissões finas são conferidas no servidor.

Em `web/lib/routes.ts`, dentro de `pageSlugs`:

```ts
  juridico: "prazos-juridicos",
```

Em `web/admin/AdminArea.tsx`, junto aos imports:

```tsx
import { PrazosPage } from "../modules/juridico/PrazosPage";
```

Dentro do `switch` das páginas:

```tsx
    case "juridico":
      return <PrazosPage />;
```

Sem item novo de menu WhatsApp, rota pública ou permissão de credencial de conversa. Não registrar esta extensão no catálogo de ferramentas IA. O OpenAPI central e o modo demonstração não foram alterados; esta tabela documenta as rotas entregues.

## Diferenças em relação ao levantamento, seção 9

- Escopo reduzido a calendários, contagem, tarefa, memória, revisão e avisos pedidos. Não há novo cadastro de caso, partes ou documentos, nem ACL por caso, política de guarda, substituto, revisor independente ou auditoria jurídica separada.
- Regras são explícitas e imutáveis dentro de cada memória, sem um catálogo de regras aprovadas. Não há inferência do regime aplicável nem cálculo de termo inicial.
- Calendários são versões completas, sem fluxo rascunho/aprovação separado; curador salva e advogado confere cada cálculo. Isso evita equiparar salvar calendário a validar um prazo.
- A tarefa nasce imediatamente, pendente de conferência. No recálculo mantém-se a data mais cedo até revisão, conservando a proposta prudencial do levantamento e evitando prorrogação silenciosa.
- O canal de aviso é uma caixa durável no painel, sem envio externo, substituto ou confirmação de entrega por provedor. Não há dado jurídico em mensagens.
- Acrescentou-se um marcador de revisão e gatilhos em `os_tasks` pela migração aditiva para impedir edição genérica dos campos protegidos sem mudar arquivos existentes do motor.
- O fuso é explícito e o horário limite obrigatório. Exceções não representáveis (interrupção/reinício, expediente parcial complexo, regimes sem regra cadastrada) exigem controle humano fora desta contagem.

## Fora desta entrega e pontos a conferir

**Consulta de andamentos nos tribunais fica somente documentada.** Uma futura integração precisa de adaptador por fonte, autorização por caso, limites, proveniência, deduplicação e revisão humana. Publicação pública não comprova intimação ou ciência; nunca deve gerar prazo confirmado automaticamente. DataJud, diários e portais não são consultados por esta extensão.

Também ficam fora: peticionamento, assinatura digital, IA jurídica, prazo universal para qualquer regime, ACL por caso, bloqueio de encerramento do processo, política de retenção/eliminação, alerta externo ou escalonamento, aplicativos móveis, demonstração e publicação no OpenAPI central. A abrangência jurídica de cada calendário e regra, a suficiência dos avisos internos e a necessidade de segregação por caso devem ser conferidas pelo escritório.

Validação local permitida: `npx tsc --noEmit` e `node scripts/juridico-check.mjs`. O script verifica algoritmo, migrações em SQLite em memória, gatilhos, codificação e sintaxe dos arquivos novos; não substitui D1/Coordinator nem teste visual no navegador. As suítes `tests/juridico-calculation.test.ts` e `tests/juridico-deadlines.test.ts` ficam para o executor Vitest externo, junto da regressão de OS. Não executar Vitest/Wrangler nesta máquina.

## Relato por arquivo e verificação local

Todos os 20 arquivos são novos. Nenhum arquivo preexistente, branch ou registro central foi alterado; não houve commit, push, rede ou aplicação das migrações em uma instalação.

| Arquivo (relativo à raiz) | Entrega |
|---|---|
| `src/modules/juridico/definition.ts` | Dependência de OS, padrão desligado, papéis, navegação declarada e bloqueio do bot |
| `src/modules/juridico/model.ts` | Esquemas estritos, datas civis, limites e carga nacional marcada para conferência |
| `src/modules/juridico/calculation.ts` | Contagem reproduzível, fontes, ajustes, fuso e antecedência |
| `src/modules/juridico/access.ts` | Barreira humana/sensível, papéis, pai autorizado e responsáveis elegíveis |
| `src/modules/juridico/calendars.ts` | Calendários por área, revisões e gravação idempotente |
| `src/modules/juridico/store.ts` | Tarefa atômica, memórias, diferenças do calendário, conferência e cumprimento |
| `src/modules/juridico/scheduler.ts` | Recálculo limitado, caixa durável do responsável, reconhecimento e medição de SQL |
| `src/modules/juridico/juridico.ts` | Descritores de rotas/comandos e função de registro para o integrador |
| `web/modules/juridico/PrazosPage.tsx` | Lista por vencimento/responsável/processo, avisos, detalhe e revisões |
| `web/modules/juridico/Calendars.tsx` | Cadastro e edição de calendários e ocorrências |
| `web/modules/juridico/CreateDeadline.tsx` | Formulário explicado, simulação e criação vinculada ao trabalho |
| `web/modules/juridico/shared.tsx` | Apresentação da memória diária e datas no fuso explícito |
| `web/modules/juridico/juridico.css` | Estilos limitados ao módulo, usando os tokens existentes |
| `migrations/0106_juridico_calendars.sql` | Calendários e versões |
| `migrations/0107_juridico_deadlines.sql` | Prazos, memórias, vínculo composto e proteções das tarefas |
| `migrations/0108_juridico_alerts.sql` | Avisos internos duráveis e índices |
| `tests/juridico-calculation.test.ts` | Regras de contagem, tipos de ocorrência, cobertura, fuso e validação |
| `tests/juridico-deadlines.test.ts` | Criação, isolamento, papéis, cliente/bot, recálculo, cumprimento, atomicidade, avisos e orçamento |
| `scripts/juridico-check.mjs` | Verificação offline permitida, sem runtime Cloudflare ou serviço externo |
| `docs/JURIDICO.md` | Uso, API, linhas exatas de integração, diferenças e limites |

Resultados locais: `npx tsc --noEmit` **aprovado**; `node scripts/juridico-check.mjs` **aprovado** (cálculo, todas as migrações em SQLite em memória, proteções das tarefas, 20 arquivos em UTF-8 sem BOM/LF e sintaxe TypeScript); `git diff --check` **aprovado** e `git diff --name-only` vazio. SQLite emitiu apenas seu aviso de recurso experimental do Node.

Vitest, Wrangler, integração HTTP completa, orçamento agregado do alarme e inspeção visual no navegador não foram executados. A execução externa dos testes e a aplicação das linhas de registro continuam pendentes. Dúvidas operacionais documentadas: aplicabilidade jurídica das datas/regras e suficiência da caixa interna, inclusive quando o responsável fica inativo; esta versão não transfere responsabilidade nem escala avisos automaticamente.
