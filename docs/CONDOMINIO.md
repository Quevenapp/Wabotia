# Condomínio

A extensão `condominio` depende de `os`, começa desligada e usa apenas os recursos existentes da instalação. Uma área representa um condomínio. Aplique as migrações aditivas `0115_condominio_cadastro.sql`, `0116_condominio_comunicados.sql` e `0117_condominio_assembleias.sql`, integre os registros abaixo, aplique o modelo **Condomínios** e habilite OS e Condomínio.

## Entrega consolidada

São vinte arquivos novos em relação à base versionada. O módulo está implementado, mas os registros centrais continuam reservados ao integrador; sem eles, as telas e rotas não entram na aplicação de produção.

| Arquivos | Conteúdo |
| --- | --- |
| `src/modules/condominio/definition.ts`, `common.ts`, `condominio.ts` | Declaração, dependência de OS, papéis, barreiras de acesso, credencial do morador e registro de rotas, comandos, menu e agendador. |
| `src/modules/condominio/cadastro.ts` | Blocos, unidades, pessoas, vínculos com papel e período, telefone verificado, veículos e animais. |
| `src/modules/condominio/works.ts` | Ocorrências, encomendas e visitantes vinculados à unidade no motor, com projeções distintas para administração, portaria e morador. |
| `src/modules/condominio/notices.ts` | Públicos por condomínio, bloco ou unidades, aprovação e fila de avisos com revalidação e tentativas limitadas. |
| `src/modules/condominio/assemblies.ts` | Convocação, pauta, presença, procuração, habilitação, voto único por unidade, apuração e ata. |
| `web/modules/condominio/CondominioPage.tsx`, `MoradorPage.tsx`, `shared.tsx`, `condominio.css` | Painel por papel e portal autenticado do morador, com seleção de unidade. |
| `migrations/0115_condominio_cadastro.sql`, `0116_condominio_comunicados.sql`, `0117_condominio_assembleias.sql` | Dezessete tabelas novas, todas com `profile_id`, e relações internas compostas por área. |
| `tests/condominio-{cadastro,works,notices,assemblies}.test.ts`, `tests/condominio-fixture.ts` | Vinte e oito testes funcionais e fixture local de integração. |
| `docs/CONDOMINIO.md` | Guia de operação, registros exatos para integração, decisões de desenho, limites e evidências de validação. |

## Operação

1. Conceda explicitamente `condominio:admin` à administração, `condominio:mesa` à mesa e `condominio:portaria` à portaria. Ser administrador global não substitui essas concessões dentro da extensão. Para restringir a portaria, conceda **somente** seu papel; não conceda acesso geral, OS ou financeiro à mesma conta.
2. Em Gestão → Condomínio → Cadastro, cadastre blocos, unidades e pessoas. Cada vínculo tem papel (`proprietario`, `inquilino`, `dependente`, `funcionario`), início inclusivo e fim exclusivo. Uma pessoa pode ter várias unidades; coproprietários são pessoas distintas. Encerrar um vínculo revoga as operações seguintes, inclusive se a unidade já tiver sido selecionada. Um vínculo futuro encerrado nunca entra em vigência.
3. Ligue o telefone a uma pessoa escolhendo uma conversa individual do WhatsApp e confirmando a conferência humana. O servidor usa `verifiedPhone`, nunca um telefone digitado. Um telefone vigente identifica uma única pessoa; pode chegar a várias unidades dessa pessoa. Para trocar o titular, encerre o vínculo telefônico anterior. Telefones compartilhados devem ser regularizados pela administração antes de usar o portal.
4. Cadastre veículos e animais com responsável que tenha vínculo vigente na unidade. Não inclua documentos pessoais nem informação veterinária. Esses cadastros não autorizam entrada física.
5. Acrescente ao menu do atendimento o tipo **Minha unidade** (`cond_unit`). Ele envia um link pessoal, com quinze minutos para abertura e uma hora de sessão. A interface usa o mecanismo existente de credenciais do módulo. Token permanece em memória; recarregar exige novo link. A página pública de entrada não mostra dados: todas as leituras posteriores exigem credencial e revalidam telefone, pessoa e períodos. O endereço HTTPS público da instalação precisa estar configurado.
6. Com mais de uma unidade, o morador escolhe. Ocorrência e visitante podem ser abertos no portal; recebimento de encomenda é da equipe. O servidor sobrescreve o extra `unidade` usando o cadastro. Os tipos esperados são `area_condominios__ocorrencia`, `area_condominios__encomenda` e `area_condominios__visitante`, produzidos pelo modelo existente.

O vínculo com o motor fica em `cond_works`. A criação e a etapa usam `ctx.run` com ator técnico de alcance exclusivo `os`; autorização e projeções usam `os/public.ts` e `os/privacy.ts`. Nenhuma tabela de outro módulo é acessada diretamente. A portaria recebe somente nome, unidade, telefone e metadados necessários à operação (identificador, tipo, etapa, versão e ações manuais). Não recebe relato, orçamento, campos extras, notas, documentos, veículos, animais ou dados eleitorais. Transições continuam sujeitas às regras do snapshot do motor.

Os registros próprios do morador exigem **a mesma pessoa e o mesmo vínculo original**. Compartilhar uma unidade não libera relatos de outros moradores; um novo período de ocupação não herda o histórico anterior. Veículos e animais são mostrados apenas ao responsável. Não use o menu genérico `os_open` para aberturas que precisem de unidade validada: ele continua sendo o fluxo independente do modelo, sem o cadastro desta extensão. As ocorrências devem ser abertas pelo portal Condomínio.

## Comunicados

Prepare título, texto e público: todos, um bloco ou até cem unidades explícitas. Revise o conteúdo e aprove antes de iniciar o envio. Não coloque dados individuais no texto coletivo. Comunicados aprovados são imutáveis; para corrigir, prepare outro. O portal mostra apenas comunicados destinados às unidades vigentes do morador.

O envio considera vínculos vigentes com `notices=true`, exclui dependentes e deduplica por telefone. Esse sinalizador de cadastro **não cria consentimento do canal**. O consentimento, a janela e o modelo de notificação são conferidos pela fila do atendimento, usando `notification: true`. No WhatsApp vai somente “Há um comunicado do condomínio…”, sem título, texto, voto ou situação financeira. O morador lê o conteúdo no portal autenticado.

O agendador próprio de Condomínio processa até cinco telefones por rodada. Revalida o público antes de cada envio, usa chave estável e só marca `queued` depois de inclusão durável na fila. `queued` significa enfileirado, não entregue ou lido. Falhas aparecem no painel e admitem no máximo três tentativas explícitas. Falhas no envio externo depois do enfileiramento continuam sendo tratadas pelo núcleo. O agendador de OS não é substituído. Não há chamada direta a provedor externo nesta extensão.

## Assembleia

1. A mesa prepara título, convocação, horário e até cinquenta pautas. Cada pauta tem duas a dez opções e prazo de encerramento. Inclua “Abstenção” se for pertinente. Peso por fração ideal e bloqueio por inadimplência vêm desligados em cada pauta.
2. Publicar exige confirmação humana e congela convocação e pauta. Cria um comunicado aprovado para todos; a administração inicia o envio na aba Comunicados. Envio de WhatsApp não é considerado prova suficiente da validade da convocação.
3. Registre procurações com outorgante proprietário vigente, unidade, representante, assembleia, pauta opcional, validade e referência/evidência textual privada. A mesa confere e aprova ou revoga. Evidência não é publicada. Leituras de procurações ficam em `cond_audit`. Esta versão não armazena arquivo da procuração: mantenha o original no repositório privado aprovado pela administração e registre sua referência.
4. Habilite uma pessoa por unidade e pauta. Proprietário vigente pode ser habilitado diretamente; demais papéis precisam de procuração aprovada. Copropriedade não multiplica o voto. Presença não habilita voto. Registre entrada/saída pela mesa ou pelo portal; o voto exige presença ativa pela unidade.
5. Quando ativar fração ideal, cadastre inteiros em partes por bilhão: `600000000` representa 60%. Todas as unidades precisam ter fração, e a soma deve ser `1000000000` antes de abrir. O peso de cada habilitação é congelado.
6. Quando ativar bloqueio financeiro, **Administração do condomínio** registra situação e evidência com data de referência, por unidade. Desconhecido impede a abertura; inadimplente não vota. Sem essa opção, situação financeira não participa da habilitação. A extensão não consulta o “melhor pagador” de um telefone nem deduz regularidade de comprovante.
7. Abrir a votação congela o eleitorado. O morador seleciona unidade, pauta e opção e confirma expressamente no portal. O banco admite um único voto por `(profile_id, agenda_id, unit_id)`, mesmo sob concorrência. Guarda pessoa, ator da credencial, unidade, escolha, peso, horário e chave idempotente; voto e auditoria entram no mesmo lote. Repetir a mesma chave e conteúdo devolve o recibo; outra escolha conflita. Voto confirmado não é editado.
8. O horário do servidor impede votos vencidos, mesmo se nenhum alarme tiver executado. Encerramento publica somente totais por opção. Não há apuração parcial pública, lista pública de votantes ou voto por pessoa. A ata em texto contém apuração agregada e pode ser baixada pelo painel.
9. Corrigir uma votação aberta exige anulá-la com motivo e preparar outra assembleia/pauta. Os votos anteriores permanecem preservados. Revogar procuração ou encerrar vínculo impede novos votos; não apaga voto já registrado. A mesa decide se deve anular a rodada.

A ata não declara aprovação automática: quórum de instalação, denominadores, empate, validade da convocação e representação exigem conferência humana conforme as regras aprovadas do condomínio. A implementação não inventa normas nem substitui essa revisão. Não oferece voto secreto, assinatura eletrônica ou validação jurídica automática.

## API e privacidade

Prefixo: `/api/v1/profiles/:profile/condominio`. Escritas são `POST`, com `Idempotency-Key`, dentro do Coordinator existente. `profile_id` vem do contexto, nunca do corpo. Todas as tabelas da extensão têm `profile_id`; relações internas usam chaves estrangeiras compostas.

| Rotas                                                                            | Uso                                                                          |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET capabilities`                                                               | Papéis concedidos ao ator humano                                             |
| `GET/POST blocks`, `units`, `people`, `phones`, `memberships`, `assets`          | Cadastro; telefone recebe `person_id`, `conversation_id`, `confirmed:true`   |
| `POST memberships/:id/end`, `phones/:id/end`                                     | Revogar vínculo                                                              |
| `GET contacts`, `works`, `works/:id`, `work-types`                               | Visão da equipe; contatos mínimos para portaria                              |
| `POST works`, `works/:id/stage`                                                  | Abrir ou executar transição manual; etapa recebe `transition_id` e `version` |
| `GET/POST notices`; `POST notices/:id/approve`, `/send`, `/retry`                | Preparação, revisão, fila e recuperação                                      |
| `GET/POST assemblies`; `GET assemblies/:id`                                      | Convocação e pauta                                                           |
| `POST assemblies/:id/agenda`, `/publish`, `/minutes`                             | Preparar pauta, publicar e gerar ata                                         |
| `POST proxies`, `proxies/:id/review`, `/revoke`                                  | Representação revisada                                                       |
| `GET assemblies/:id/proxies`, `/attendance`                                      | Registros privados da mesa                                                   |
| `POST attendance`                                                                | Entrada/saída de pessoa por unidade                                          |
| `POST agenda/:id/qualify`, `/open`, `/close`, `/annul`; `GET agenda/:id/results` | Habilitação, votação e totais                                                |

O prefixo do morador é `me/:access_id`, e somente a credencial de Condomínio cujo `subject` seja esse acesso é aceita. Não basta saber telefone, pessoa ou unidade. Rotas: `GET units`, `POST select`, `GET assets`, `GET/POST works`, `GET works/:id`, `GET work-types`, `GET notices`, `GET assemblies`, `GET assemblies/:id`, `GET assemblies/:id/units`, `POST attendance`, `GET agenda/:id/ballot?unit_id=…`, `GET agenda/:id/results`, `POST votes`, `GET votes/:id`. O recibo é exclusivo da pessoa autora com vínculo vigente.

`definition.ts` bloqueia todos os prefixos da extensão em `bot.deny` e classifica seus comandos em `bot.sensitive`. Os manipuladores também recusam bots, aplicações comuns, conectores, atuação por `via` (mesmo sem máscara) e atores técnicos nas rotas privadas. Não há ferramenta MCP eleitoral nem rota pública de dados. Respostas de comandos privados levam referências. Papéis são aditivos: acesso global concedido fora da extensão não é revogado por ela.

Listas comuns, presença e seletores de pessoas, unidades e contatos usam cursor e até cinquenta registros por página; os seletores têm “Carregar mais opções”. O portal aceita até duzentos vínculos por pessoa e recusa excedentes explicitamente. A preparação e o envio de comunicados não usam leitura por destinatário para montar a audiência; o envio é limitado a cinco por rodada. O custo completo do alarme ainda deve ser medido na instalação integrada.

## Integração: linhas exatas a acrescentar

Nenhum dos arquivos existentes abaixo foi alterado nesta entrega. Os registros internos de rotas, comandos, menu, credencial e agendador estão dentro de `registerCondominio()`, sem execução ao importar. **Chame uma única vez** no runtime, depois da declaração central estar registrada.

Em `src/modules/registry.ts`, nos imports e em `modules`, respectivamente:

```ts
import { condominioModule } from "./condominio/definition";
```

```ts
  condominioModule,
```

Em `src/modules/runtime.ts`, no bloco de integração:

```ts
import { registerCondominio } from "./condominio/condominio";
registerCondominio();
```

Isso registra as rotas da tabela, o menu `cond_unit`, a troca de credencial e `onSchedule("condominio", …)`. Não acrescente agendador em OS, classes de Durable Object, bindings ou recursos Cloudflare. Não é necessária exceção na lista de rotas para bots presos à conversa: estes não acessam as rotas do morador.

Em `web/workspace-navigation.ts`, acrescente em `sections`, `workspaceGroups`, `pageModules` e `pageDescriptions`, respectivamente (o ícone `Blocks` já está importado):

```ts
  ["condominio", "Condomínio", Blocks],
```

```ts
  { id: "condominio", label: "Condomínio", icon: Blocks, pages: ["condominio"] },
```

```ts
  condominio: "condominio",
```

```ts
  condominio: "Unidades, moradores, portaria, comunicados e assembleias.",
```

Em `web/lib/routes.ts`, dentro de `pageSlugs`:

```ts
  condominio: "condominio",
```

Em `web/admin/AdminArea.tsx`, nos imports e no `switch` de páginas:

```tsx
import { CondominioPage } from "../modules/condominio/CondominioPage";
```

```tsx
    case "condominio":
      return <CondominioPage />;
```

Em `web/main.tsx`, acrescente o import e insira esta condição entre o ramo `/app` e o ramo `/install`:

```tsx
import { MoradorPage } from "./modules/condominio/MoradorPage";
```

```tsx
  ) : location.pathname === "/condominio/acesso" ? (
    <MoradorPage />
```

O editor de menu e a tela de concessões usam a declaração do módulo; não precisam de catálogo paralelo. Depois de integrar, o administrador cria um item usando `type: "cond_unit"`. As migrações são descobertas pela pasta existente; não há alteração de configuração do D1.

## Diferenças do rascunho e limites

- Identidade mínima de pessoa física e telefone exclusivo, em vez de empresas e telefone compartilhado: reduz ambiguidade da autoria do voto. Um telefone mantém várias unidades pelos vínculos da pessoa. Representação de empresas fica para integração posterior.
- Credencial temporária já existente no núcleo, em vez de novo mecanismo de sessão ou token público. Não há coleta de voto em chat, passo web genérico ou IA.
- Uma rodada por pauta. Não há edição de regras abertas; anulando, prepara-se outra assembleia/pauta. A regra “um voto por unidade” fica no banco e a apuração é numérica, sem tentar implementar a variedade de quóruns do levantamento.
- Procuração usa referência/evidência textual privada, sem upload/download. O original precisa permanecer em armazenamento privado externo à extensão; não há URL pública nem integração de rede.
- O comunicado coletivo fica no portal e só um aviso genérico sai pelo atendimento. A aprovação é imutável, evitando revisão de conteúdo após a aprovação.
- As integrações de OS usam `ctx.run`, autorizado pelo contrato de módulos, porque `os/public.ts` não exporta criação ou transição. O código não importa o armazenamento interno do motor.
- Não foram incluídos documentos institucionais, reserva, catraca, biometria, gestão de empresas, retenção automática, arquivo de procuração, quórum automático, edição/arquivamento geral de cadastros ou notificações de voto. Não se promete entrega da convocação pelo simples enfileiramento.
- A portaria fica ainda mais restrita que o rascunho: nenhum dado de veículo/animal, apenas nome, unidade e telefone, além dos metadados da operação.

Rateio e prestação de contas estão fora. A integração financeira futura deve referenciar `profile_id`, `unit_id`, competência e origem com chave idempotente, por API pública do financeiro. O financeiro calcula obrigação, pagamento, estorno e classificação; não se deve manter saldo paralelo em `cond_units` nem concluir pagamento por comprovante. Reserva e documentos também precisam de contratos públicos próprios antes de integração.

Pendências de decisão operacional: política de guarda, revisão jurídica de convocação/quórum/representação, data e evidência da conferência financeira, tratamento de telefone compartilhado e seleção do repositório privado para os originais das procurações. Nenhuma decisão pendente habilita regra eleitoral automaticamente.

## Retorno externo e correção

O log externo recebido em `.codex-verificacao.log` apresentou **27 de 28 testes aprovados**:

| Arquivo | Resultado antes da correção |
| --- | --- |
| `tests/condominio-assemblies.test.ts` | 11/11 |
| `tests/condominio-cadastro.test.ts` | 8/9 |
| `tests/condominio-notices.test.ts` | 4/4 |
| `tests/condominio-works.test.ts` | 4/4 |

A falha foi em `condominio-cadastro.test.ts:134`: o manipulador de cadastro retornava `403 missing_scope` para uma aplicação sem escopos, onde o contrato do teste exige `403 forbidden`. Em `common.ts`, `staff()` chamava `ctx.access()` antes de `human()`. Assim, a validação genérica de escopos de aplicação interrompia a recusa específica de atores proibidos no condomínio. O acesso já era recusado; o erro vinha da barreira errada.

A correção mantém `requireEnabled()` primeiro, recusa atores não humanos em seguida e então verifica área/escopo e papel explícito. Vale para leituras e escritas que usam `staff()`. Não houve mudança na autorização do núcleo nem nos testes. O aviso de sourcemap de `standardwebhooks` no log não era a causa da falha.

## Validação desta entrega

- `node node_modules/typescript/bin/tsc --noEmit` passou (mesmo compilador local de `npx tsc --noEmit`, executado sem o npm).
- Reprodução offline com o código real de `directory()` antes da correção: aplicação sem escopos retorna `403 missing_scope`, confirmando a causa.
- Após a correção, **35 cenários de autorização passaram** em uma verificação dirigida com Node, sem Vitest. Ela carrega `common.ts`, `cadastro.ts`, `db.ts`, `types.ts` e as funções reais `access`/`canProfile` isoladas por AST; contexto e banco são instrumentados. Confere leitura e escrita, aplicação com e sem escopos, conector, bot, `via` com e sem máscara, ator técnico, credencial, papéis, área e módulo desligado. Atores proibidos são recusados antes de escopos, consulta de papéis ou SQL de domínio. Isso não substitui o runtime Cloudflare.
- As migrações `0115`–`0117` criaram **17 tabelas** em SQLite em memória. Conferidos `profile_id` obrigatório, chaves estrangeiras compostas por área, unicidade de voto por pauta/unidade, idempotência e opções de fração/inadimplência desligadas no banco.
- Sintaxe dos **15 arquivos TS/TSX** da entrega aprovada, incluindo os quatro arquivos de testes e a fixture, sem executá-los.
- `node scripts/check-conflict-markers.mjs` passou. A guarda `check-encoding.mjs` encontrou `EPERM` ao chamar Git; uma cópia temporária preservando todas as regras, com a lista de arquivos fornecida pelo shell e incluindo os novos, aprovou **3.893 arquivos de texto**. A guarda original permaneceu intacta.
- Os **763 arquivos em `tests/`** permanecem idênticos por SHA-256 ao início desta rodada. Nenhuma asserção foi removida ou flexibilizada. `git diff --exit-code HEAD -- .` e `git diff --check` passaram: nenhum arquivo versionado foi alterado.

Os quatro arquivos funcionais usam o padrão Vitest/D1 do repositório, com fixture local que simula somente os registros reservados ao integrador. Cobrem criação, idempotência, isolamento de área e unidade, períodos, papéis, bot sem máscara, projeção de portaria/morador, públicos e falhas de comunicado, voto concorrente, confirmação, prazo, procuração, presença, fração e inadimplência.

Vitest e Wrangler não foram executados nesta rodada. A aprovação dos 28 testes **depois** da correção ainda depende de nova verificação externa dos quatro arquivos acima. Também ficam para a integração a navegação real no painel/portal e a medição do alarme completo. O `tsconfig.json` existente inclui servidor e telas, mas não os testes.

Não houve commit, push, troca de branch, alteração dos registros centrais nem criação de recursos Cloudflare. A tentativa de usar `npx` com modo offline e sem instalação acionou uma consulta automática de atualização do npm; ela falhou com `EAI_AGAIN`, sem consulta externa concluída. A compilação aprovada foi feita diretamente com o TypeScript já instalado para evitar o npm. Nenhum serviço externo foi chamado pelo código da extensão.
