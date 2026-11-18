# Ensino

Extensão desligada por padrão, dependente de `os`. Turmas, diário, notas, boletins informativos e comunicados. Não emite histórico escolar oficial nem censo escolar. Nenhum arquivo preexistente foi alterado nesta entrega; os registros abaixo cabem ao integrador.

## Preparação e uso

1. Integre os registros deste guia e aplique, na ordem, `0112_ensino_turmas.sql`, `0113_ensino_diario.sql` e `0114_ensino_comunicados.sql`. Reutilize D1, Coordinator e credenciais existentes.
2. Ligue OS e Ensino. Conceda `ensino:secretaria` à secretaria e `ensino:professor` aos professores. Administração e `*` não substituem esses papéis. A secretaria que vincula responsáveis também precisa de acesso ao motor e de `os:sensitive`; professores não precisam desse papel global de sigilo.
3. Configure um tipo personalizado de matrícula com `features.people=true`, `features.customer_open=false`, todos os extras sensíveis e nenhuma mensagem automática de etapa. Na matrícula, a pessoa central (`customer_name`) é o aluno. Use textos administrativos genéricos em `item` e `problem`, sem informação pedagógica ou familiar. Notas, frequência e boletins ficam exclusivamente nesta extensão. Não copie informações escolares para Conhecimento, notas comuns, tarefas públicas ou mensagens.
4. Em Gestão → Ensino, cadastre a turma, período letivo, vigência, professor, horários semanais, períodos avaliativos sem sobreposição, vagas e regra de cálculo. Datas são civis `YYYY-MM-DD`; horários seguem Brasília, como o núcleo de atendimento. Não há configuração de fuso por turma. Domingo é 0. O professor precisa estar ativo e ter o papel na área.
5. Enturme pelo ID da matrícula. Datas inicial e final são inclusivas. Para transferir, encerre a participação e abra a enturmação na outra turma a partir do dia seguinte. Não reduza o intervalo para antes de lançamentos existentes. Não se deduplica aluno por nome; identidades entre matrículas diferentes precisam de conferência humana.
6. Cadastre o responsável em Pessoas ligadas da matrícula, com telefone normalizado pelo motor, `sensitive=true`, `client_visible=false`. Em Ensino, escolha essa pessoa, confira identidade e poderes pedagógicos e defina a validade da autorização. Parentesco, telefone principal da ordem e cadastro da pessoa, isoladamente, não autorizam. Um telefone compartilhado precisa de conferência presencial/humana antes da autorização.
7. Cadastre as aulas previstas a partir dos horários. Marque como realizadas antes de fazer a chamada. Aula fora do horário exige marcar extraordinária. Para reposição, cancele a substituída e cadastre a nova. Não há geração automática de calendário nem integração com feriados/Agenda.
8. Cadastre avaliações por disciplina e período, nota máxima e peso. Registre nota, ausência ou dispensa. Zero é uma nota válida; campo vazio ou ausência não vira zero. A secretaria publica uma revisão do boletim depois do fim do período, quando não há notas nem chamadas pendentes.
9. Adicione no menu do WhatsApp o tipo **Boletim e frequência** (`ensino_boletim`). O responsável recebe acesso de uso único, válido para troca em 5 minutos. A consulta dura no máximo 15 minutos desde o pedido. O navegador guarda o token somente em memória; recarregar ou fechar exige novo acesso. Cada novo pedido revoga a credencial anterior da conversa.
10. Professores preparam comunicados das próprias turmas. A secretaria confere texto e destinatários, publica e aciona **Enviar avisos pendentes / tentar bloqueados**. O painel executa lotes de dez, mostra bloqueios e permite repetir. É necessário assumir as conversas ou ser administrador para enviar; o papel escolar não dá permissão de atendimento. Fora da janela, valem as regras existentes de notificação e consentimento da finalidade `order`; não se cria consentimento automático. “Na fila” não significa entregue nem lido: consulte Entregas de mensagens para o resultado do canal.

O WhatsApp recebe apenas o acesso pessoal e avisos genéricos. Conteúdo de boletins, frequência e comunicados aparece na consulta autenticada, nunca no retorno da ferramenta. O bot dispõe somente de `ensino_pedir_boletim`, que chama a ação `ensino_boletim` na conversa autenticada e devolve uma confirmação neutra. Não aceita telefone, aluno ou matrícula como autoridade.

## Regras de cálculo e correção

- Escala final fixa de 0 a 10. Cada avaliação é normalizada por `nota / nota_máxima × 10`.
- Média simples: cada avaliação regular não dispensada pesa 1. Ponderada: soma das notas normalizadas × pesos dividida pela soma dos pesos. Pesos são positivos, com até duas casas.
- Recuperação: desligada, maior entre a média anterior e a recuperação, ou combinação dessas duas notas com pesos explícitos. Há no máximo uma avaliação de recuperação por disciplina/período. Sem recuperação cadastrada, vale a média regular. Recuperação cadastrada sem nota fica pendente. O limite configurado aplica-se ao resultado após recuperação, inclusive no modo “maior”.
- Arredondamento somente ao final: metade para cima, truncamento ou para cima, com 0 a 2 casas. O cálculo intermediário é racional exato (`BigInt`), sem arredondamento de notas normalizadas. O boletim exibe entradas, pesos, fração exata, regra, arredondamento e resultado.
- Dispensa exclui a avaliação do denominador; só dispensas ou ausência de avaliações não geram uma nota final. Não há aprovação/reprovação automática nem percentual legal presumido.
- Frequência considera aulas realizadas durante a enturmação. Chamada ausente é pendente e impede fechar o percentual. Canceladas e previstas não entram no denominador. A turma escolhe se justificada conta como presença. Não registre diagnóstico ou texto médico: a justificativa é apenas a categoria.
- Correção de presença ou nota exige `reason=correction` e acrescenta revisão; a anterior permanece. Boletim publicado guarda fotografia dos resultados, frequências e regra. Alterar regra ou nota não altera publicações anteriores; a secretaria publica outra revisão. O responsável recebe apenas a revisão mais recente de cada período.

## Autorização, persistência e limites

Toda consulta de domínio usa a área do contexto; IDs de outra área/turma/família não autorizam. Professores são filtrados antes de paginar e em cada detalhe/escrita. Aplicações, atores de módulo, credenciais e atuação `via` bot são recusados no painel, independentemente de escopos. A credencial do responsável só alcança seu próprio `subject` nas duas rotas `/access` e é novamente conferida no manipulador.

Autorização do responsável é registro próprio (`ensino_guardians`), referenciando pessoa e matrícula existentes; guarda HMAC do telefone com chave da instalação e versão da pessoa. Toda consulta/envio revalida área, telefone verificado, vigência, revogação, versão, classificação sensível e arquivamento da pessoa. Mudar o telefone, a classificação ou qualquer campo da pessoa ligada exige nova autorização. Trocar a sessão da conversa ou desligar o módulo também invalida a consulta. Dois responsáveis têm autorizações independentes.

Como o contrato público do motor não autoriza responsáveis, a extensão usa `authorizedOrder`/`projectOrderForStaff` e a rota pública de pessoas **com o ator humano** ao vincular. As verificações posteriores fazem joins somente de leitura em `os_people`/`os_orders`, com área e chaves compostas. Não há escrita direta nessas tabelas, importação de `store.ts`/`model.ts` do motor, ator humano fabricado ou ampliação da autorização genérica da OS. `projectChildForStaff` e `projectChildForBot` conferem a classificação da pessoa. Autorizar em Ensino não torna o responsável titular da OS.

Escritas usam o Coordinator existente, `Idempotency-Key`, versão da turma e lote D1 atômico. O CHECK da auditoria impede confirmação parcial quando o CAS falha. Se o lote foi confirmado e o recibo do Coordinator falhou, o despacho recupera a referência da auditoria antes de revalidar o lançamento, sempre depois de conferir a autorização atual. Respostas de mutações são `{id,class_id,version}`. Auditoria guarda IDs, operação, autor, versão e HMAC canônico do pedido; não guarda notas ou conteúdo no histórico/eventos gerais. Consultas de responsável registram acesso, sem copiar conteúdo. A extensão não publica eventos com conteúdo escolar.

Limites: 100 vagas por turma, 500 enturmações históricas, 1.000 aulas, 8 períodos, 100 avaliações por período, 100 comunicados, 10 autorizações vigentes por matrícula. Listas de turmas/aulas/avaliações/alunos do responsável usam cursor vinculado à área e escopo, padrão 50 e máximo 100; não usam OFFSET. Listas auxiliares são limitadas pelas coleções. Até 100 matrículas por telefone; acima disso, requer conferência da secretaria. Comunicados deduplicam telefone por publicação, inclusive quando irmãos têm o mesmo responsável. Capacidade é conferida no banco nos pontos em que a ocupação muda. Não há novo agendador: a fila existente entrega os avisos que a secretaria enfileirou.

## API

Base `P=/api/v1/profiles/{profile}/ensino`, `C=P/classes/{id}`. IDs de caminho prevalecem sobre o corpo. Todas as escritas salvo envio em lote incluem `version` da turma; criação da turma inicia em 1. Corpos desconhecidos são rejeitados. Os esquemas de escrita estão em `src/modules/ensino/openapi.ts`.

| Rotas | Uso |
|---|---|
| `GET/POST P/classes`, `GET/PATCH C` | Listar/criar/consultar turma; alterar professor, horário, regra e efeito das justificativas |
| `GET/POST C/enrollments` | Alunos e enturmação por `order_id,start_date,end_date` |
| `POST C/enrollments/{enrollment_id}/end` | Encerrar participação com `end_date` |
| `GET/POST C/enrollments/{enrollment_id}/guardians` | Autorizações; criar com `person_id,valid_until,identity_confirmed=true` |
| `POST C/enrollments/{enrollment_id}/guardians/{guardian_id}/revoke` | Revogar |
| `GET/POST C/lessons`, `PATCH C/lessons/{lesson_id}` | Aulas: data, horários, situação; correção com motivo codificado |
| `GET/POST C/lessons/{lesson_id}/attendance` | Chamada: `enrollment_id,status,reason` |
| `GET/POST C/assessments` | Avaliações: período, disciplina, título, data, escala, peso, modalidade |
| `GET/POST C/assessments/{assessment_id}/grades` | Notas: `enrollment_id,status,score,reason` |
| `GET C/enrollments/{enrollment_id}/reports/{period_id}` | Prévia calculada, só equipe autorizada |
| `POST C/enrollments/{enrollment_id}/reports` | Publicar nova revisão, `period_id`; só secretaria |
| `GET/POST C/notices` | Rascunhos coletivos com `text,audience_date` |
| `POST C/notices/{notice_id}/publish` | Revisão humana com `reviewed=true`; só secretaria |
| `POST C/notices/{notice_id}/send` | Até dez avisos; `retry=true` reabre bloqueados; retorna totais por estado |
| `GET P/access/{id}/students` | Somente credencial de responsável deste `id` |
| `GET P/access/{id}/students/{enrollment_id}` | Últimos boletins publicados, frequência atual e comunicados autorizados |

O pedido por bot usa a rota existente `POST /api/v1/profiles/{profile}/conversations/{conversation_id}/actions`, corpo `{ "action": "ensino_boletim" }`. Não há rota pública com dados escolares. A página pública `/ensino/acesso` apenas troca o segredo enviado no fragmento do link pela credencial existente em `POST /api/credentials/claim`. O claim retorna token, metadados de sessão e `{ready,expires_at}`, sem boletim.

## Registros exatos para o integrador

**`src/modules/registry.ts`:** importar e acrescentar ao array `modules`:

```ts
import { ensinoModule } from "./ensino/definition";
// dentro de modules:
ensinoModule,
```

**`src/modules/runtime.ts`:** acrescentar após os imports existentes (mesclar imports repetidos de `./api`):

```ts
import { onRead, onRoute, onCommand, onMenuChoice, onConversationAction, onMcpTool, onCredentialClaim } from "./api";
import { ensinoReads, ensinoWrites, ensinoCommands, ensinoTool, requestAccess, customerAction, claimAccess } from "./ensino/ensino";
for (const r of ensinoReads) onRead("ensino", r.path, r.handler, r.options);
for (const r of ensinoWrites) onRoute("ensino", r);
for (const c of ensinoCommands) onCommand("ensino", c.op, c.handler);
onMenuChoice("ensino_boletim", async (ctx, c, _item, { rowId }) => { await requestAccess(ctx, c, `menu:${rowId}`); });
onConversationAction("ensino", "ensino_boletim", (ctx, actor, c, data, { requestId }) => customerAction(ctx, actor, c, data, requestId));
onMcpTool("ensino", ensinoTool);
onCredentialClaim("ensino", claimAccess);
```

**`src/index.ts`:** importar o middleware e registrá-lo logo depois de `const app = new Hono<Bindings>();`, antes das rotas. O prefixo de conversa já está em `BOUND_ROUTES`; não abrir as rotas escolares nessa lista.

```ts
import { ensinoNoStore } from "./modules/ensino/ensino";
app.use("/api/v1/profiles/:profile/ensino/*", ensinoNoStore);
```

**Pré-requisito P/M/I, se ainda não integrado:** em `src/modules/os/extensions.ts`, importar `import { peopleExtension } from "./people/extension";` e acrescentar `peopleExtension,` ao array `osExtensions`. Em `src/modules/os/definition.ts`, incluir em `grants`:

```ts
{ id: "sensitive", label: "Dados sensíveis", description: "Permite leitura humana dos campos e pessoas classificados como sensíveis no motor." },
```

Não conceder `os:sensitive` aos professores por conveniência. Se os eventos de Pessoas ainda não estiverem integrados, acrescentar ao array `events` de `src/modules/os/definition.ts` as linhas `"os.person.created",`, `"os.person.updated",` e `"os.person.archived",`. Ensino não implementa as operações de cadastro/edição do motor.

**`web/workspace-navigation.ts`:** `BookOpen` já é importado. Acrescentar:

```ts
// sections:
["ensino", "Ensino", BookOpen],
// workspaceGroups:
{ id: "ensino", label: "Ensino", icon: BookOpen, pages: ["ensino"] },
// pageModules:
ensino: "ensino",
// pageDescriptions:
ensino: "Turmas, frequência, notas, boletins e comunicados escolares.",
```

Não incluir em `adminPages`: professores e secretaria precisam acessar. Não há extensão no painel genérico da conversa, para evitar expor conteúdo pedagógico nesse painel.

**`web/lib/routes.ts`**, dentro de `pageSlugs`: `ensino: "ensino",`.

**`web/admin/AdminArea.tsx`:** importar e acrescentar ao switch:

```tsx
import { EnsinoPage } from "../modules/ensino/EnsinoPage";
case "ensino": return <EnsinoPage />;
```

**`web/main.tsx`:** importar e inserir como primeiro ramo do render, antes de `location.pathname.startsWith("/app")`:

```tsx
import { ResponsiblePage } from "./modules/ensino/ResponsiblePage";
location.pathname === "/ensino/acesso" ? <ResponsiblePage /> :
```

**`src/modules/openapi.ts`:** importar, acrescentar os spreads e o encaminhamento dentro de `describeModuleOperation`, após a checagem inicial de operação conhecida:

```ts
import { ensinoOperations, ensinoSchemas, describeEnsinoOperation } from "./ensino/openapi";
// moduleSchemas:
...ensinoSchemas,
// moduleOperations:
...ensinoOperations,
// describeModuleOperation:
if (path.startsWith("/profiles/{profile}/ensino/")) return describeEnsinoOperation(path, method, entry, success);
```

**`docs/API.md`:** acrescentar `Ensino: rotas, permissões e corpos em [ENSINO.md](ENSINO.md#api).`.

Não registrar agendador, recurso Cloudflare ou classe de Durable Object. O item do menu vem de `definition.menu_item_types`; a escola escolhe adicioná-lo à sua configuração, sem mudar menus de outras áreas. O demo não simula registros escolares nesta entrega.

## Diferenças em relação à seção 9 do levantamento

- Sem cadastros paralelos de aluno/responsável: matrícula central e pessoas ligadas são reutilizadas; acrescenta-se só a autorização pedagógica explícita, revogável e com validade.
- Consulta usa a infraestrutura de credenciais existente, em vez de PDF/R2 ou passo web comum. Isso evita conteúdo escolar em anexos compartilháveis, formulários, respostas à IA e rotas anônimas. Link de troca de 5 minutos e sessão de até 15 seguem os limites atuais dessa infraestrutura.
- O responsável escolhe entre seus alunos na página autenticada. Frequência atual pode mostrar pendências; boletim só aparece depois de publicado. A regra usa a versão da turma e uma cópia completa no boletim, sem tabela própria de regras.
- Sem expressões configuráveis: apenas métodos enumerados, cálculo racional, recuperação pela maior nota ou média ponderada e limite explícito. Não há conceitos qualitativos ou aprovação automática.
- O comunicado livre fica no portal, após revisão humana; WhatsApp recebe aviso fixo. Assim o texto de um comunicado não entra no contexto de IA. Envio em lotes acionados pela secretaria conserva a autorização de atendimento de quem envia; não se inventa ator para o agendador.
- Correções têm motivo codificado, não justificativa livre que poderia receber dados de saúde. Notas e frequência preservam revisões. A auditoria geral mantém somente referências.

## Fora desta entrega e validação

Fora: censo escolar, histórico escolar oficial, certificados, diário qualitativo, cadastro permanente entre matrículas, integração financeira, Agenda, feriados, geração automática de aulas, professores substitutos com vigência, PDF/exportação, política automatizada de eliminação e demo. A transferência entre turmas é feita em dois comandos explícitos, sem apagar histórico. Dados do motor já existentes continuam submetidos às permissões do motor; esta extensão não muda suas rotas globais.

Verificações locais: `npx tsc --noEmit` e `node scripts/ensino-verify.mjs`. O script é offline, não grava arquivos, verifica cálculos conhecidos, sintaxe dos arquivos novos, UTF-8/LF e os DDL novos em SQLite em memória, com chaves compostas, capacidade e rollback do CAS. Pais mínimos reproduzem as chaves do motor; isso não substitui D1/Coordinator.

Os testes `tests/ensino-model.test.ts`, `tests/ensino-orders.test.ts` e `tests/ensino-whatsapp.test.ts` ficam para o verificador externo. A fixture local registra Ensino apenas nos testes e usa o D1 da suíte. Vitest, Wrangler, migrações em ambiente real, teste visual no navegador e envio real pelo canal não foram executados. Nenhum commit, push ou troca de branch.

Decisões da escola: efeito das justificativas, pesos e limite de recuperação, períodos avaliativos, conferência de responsáveis/telefones compartilhados e política de guarda. Não foram presumidas normas, percentuais ou prazos legais.
