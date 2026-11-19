# Módulos do Wabotia

Contrato para escrever uma vertical (Agenda, Pedido, Ordem de Serviço,
Reserva, Mensalidade…) **sem ler o motor**. Um módulo roda no mesmo Worker e
no mesmo banco do atendimento, é ligado e desligado por área de atendimento em
**Gestão → Módulos** e fala com o núcleo só pela interface de
`src/modules/api.ts`. Os dois módulos de referência são a **Fila presencial**
(`src/modules/queue.ts`, código antigo em `src/queue.ts`) e os
**Formulários** (`src/modules/forms/`), escrito do jeito que a onda 2 deve
escrever.

## Regras que não mudam

- Sem Worker, banco, bucket ou classe de Durable Object novos. Tempo real
  reaproveita o `Coordinator` da área. `wrangler.jsonc` não muda.
- Migrações só na faixa reservada ao módulo (veja `PLANO-VERTICAIS.md`),
  aditivas, com tabelas de prefixo próprio (`agenda_`, `order_`…). Toda tabela
  tem `profile_id`.
- Textos de interface em português do Brasil. Datas em milissegundos Unix;
  dias de serviço no horário de Brasília (`src/business-time.ts`).
- O módulo nunca grava em tabelas do núcleo diretamente. Mensagem, passo web,
  evento e contato passam pela interface abaixo; protocolo, pela API pública
  ou pelo passo web.

## Arquivos de um módulo

| Onde | O quê |
|---|---|
| `src/modules/<id>/definition.ts` | Declaração (só dados), importada pelo registro |
| `src/modules/<id>/<id>.ts` | Código: rotas, comandos, ganchos |
| `src/modules/registry.ts` | Acrescente a declaração em `modules` |
| `src/modules/runtime.ts` | Acrescente `import "./<id>/<id>";` |
| `migrations/00NN_<id>_*.sql` | Tabelas na faixa reservada |
| `web/modules/<id>/` | Telas do painel |
| `tests/<id>-*.test.ts` | Testes |

## 1. Declaração (`ModuleDefinition`, `src/modules/types.ts`)

```ts
export const agendaModule: ModuleDefinition = {
  id: "agenda",                 // estável, minúsculo; vira module_id
  name: "Agenda",
  version: "1.0.0",             // versão do contrato do módulo (semver)
  description: "Serviços, profissionais, horários e lembretes.",
  builtin: true,
  default_enabled: false,       // áreas existentes não ganham nada sozinhas
  management: NATIVE_MANAGEMENT_ITEMS.agenda, // catálogo puro de panel-navigation.ts
  // Campos antigos publicados para compatibilidade; não definem mais o trilho.
  navigation: [
    { id: "agenda", label: "Agenda", place: "rail", admin: false },
    { id: "agenda-settings", label: "Serviços e horários", place: "admin", admin: true },
  ],
  menu_item_types: [
    {
      type: "agenda",
      label: "Agendar horário",
      description: "Mostra os horários livres e confirma pelo WhatsApp.",
      // opcional: o núcleo recusa salvar item apontando para registro inexistente
      reference: { field: "service_id", setting: "agenda", label: "Serviço" },
    },
  ],
  events: ["agenda.booked", "agenda.cancelled"],
  settings: [{ key: "agenda", description: "Antecedência, lembretes…" }],
  routes: ["agenda"],           // /api/v1/profiles/:profile/agenda/…
  operations: ["agenda."],      // comandos agenda.*
  scopes: [],                   // permissões novas exigem combinar com a sessão A
};
```

O que o núcleo faz com cada campo:

| Campo | Efeito |
|---|---|
| `default_enabled` | Estado de uma área sem registro em `profile_modules` |
| `navigation` | Metadados legados de Tela Módulos e `GET /modules`; `place: "rail"`/`"admin"` permanecem compatíveis, mas não criam atalhos operacionais fora da casa ERP |
| `management` | Contribuições puras da casa ERP: módulo, grupo, ordenação, destino nativo/portado, autorização, apresentação e `primary`; `moduleView` publica o catálogo sem conceder acesso |
| `menu_item_types` | Tipos aceitos em `PUT /settings` (`menus`); desligado, os itens somem do WhatsApp e do editor, ficam guardados e voltam ao religar |
| `events` | Únicos tipos que `ctx.publish` aceita; entram nos webhooks com a permissão `conversations:read` |
| `settings` | Chaves das configurações da área que o módulo valida (`onSettingsSave`) |
| `routes` | Com o módulo desligado, `/profiles/:profile/<rota>/…` responde `409 module_disabled` |
| `operations` | Com o módulo desligado, os comandos com esses prefixos respondem `409 module_disabled` |
| `requires` | Opcional: ids dos módulos dos quais este depende (veja abaixo) |
| `grants` | Opcional: papéis que o administrador marca no acesso de cada pessoa (veja "Acessos e papéis", seção 3) |

### Casa única de gestão

O botão **ERP** é a entrada de toda a gestão, inclusive Agenda, Trabalhos,
Mensalidade e Pedido. Gestão continua com administração, Módulos, Pessoas,
filas e modelos de área. `web/management/host-contract.ts` contém somente tipos;
`registry.ts` resolve o catálogo da Base e `managementContext` deriva o papel
ERP: administrador vale `admin`; nos demais casos é necessário um `erp:<papel>`
válido. `null`, `"*"` e acesso a um módulo não inventam esse papel.

A elegibilidade do botão independe de ativação: administrador ou pessoa com
permissão para alguma contribuição pode entrar. Destinos nativos exigem status
carregado, módulo explicitamente ligado e `canOpenPage`, incluindo as
exclusividades administrativas. Não se alterou a compatibilidade de
`moduleAllows` nas demais áreas. Vocabulário e tipos de trabalho só mudam a
apresentação; não criam módulos nem acesso.

O contêiner **Mais** é acessível a toda sessão autenticada, inclusive quando
Conversas, Protocolos, Equipe e Ligações ocupam as quatro abas móveis. Isso não
concede `"*"`, papel ERP nem acesso a áreas desconhecidas: cada destino conserva
sua autorização. O trilho usa a filtragem individual de `Shell.useItems`.

**Leitura nativa explícita:** `web/management/native-access.ts` declara os papéis
conferidos por `canOpenPage` antes das exceções gerais de administrador, acesso
nulo e `"*"`. Catálogo, abertura direta e estado do destino usam essa mesma
decisão. Agenda e Trabalhos continuam com seus acessos nativos, sem papel ERP.

| Página/operação | Leitura | Escrita |
| --- | --- | --- |
| Ensino | `ensino:secretaria` ou `ensino:professor`; professor limitado às próprias turmas pelo servidor | Depende da operação: secretaria administra turmas e vínculos; professor atua nas turmas autorizadas. A leitura não concede operações exclusivas da secretaria nem acesso sensível ao motor |
| Jurídico — calendários | `os:sensitive` e `juridico:lawyer` ou `juridico:curator` | `os:sensitive` e `juridico:curator` para criar/revisar |
| Jurídico — responsáveis, prazos e alertas | `os:sensitive` e `juridico:lawyer` | Mesmo papel explícito, com as verificações de operação, versão e objeto do servidor |

Esses papéis não dispensam sessão humana autorizada, área e módulos exigidos
pelo servidor. Curador sem papel de advogado abre **Calendários**, sem consultar
responsáveis, prazos ou alertas. A política leve descreve leitura; não promove
automaticamente o leitor a escritor.

Na entrada `/app/erp`, status pendente não presume destino. Tudo desligado
mostra “Nenhum módulo de gestão ligado”, com **Abrir Módulos** para administrador
ou orientação para pedir ao administrador. Módulos ligados sem destino
acessível mostram negativa. Um único módulo acessível abre seu `primary`
autorizado (ou primeiro destino) por `replace`; vários mostram uma entrada leve.
A contagem usa módulos distintos, não grupos, itens ou tipos de trabalho.
IDs repetidos são erro; destinos completos normalizados são deduplicados.

As páginas nativas ficam em `/app/erp/modulos/<slug>`. Os aliases
`/app/gestao/{agenda,servicos-e-horarios,mensalidades,mensalidade,pedidos,
cardapio-e-loja,mesas,reservas,unidades-e-regras,suporte-pago,regras-do-suporte,
condominio,prazos-juridicos,prontuarios,ensino,trabalhos,meus-prazos,
tipos-de-trabalho,ordem-de-servico,formularios,cobranca}` são **permanentes nesta
versão**: trocam apenas o prefixo por `replace`, conservando detalhes aceitos,
consulta integral (inclusive repetições e escapes) e fragmento.
`ordens-de-servico` aponta para `modulos/trabalhos`. Objetos antigos com
`area: "admin"` e página migrada são normalizados em `navigate`, `href` e
`pageRoute`, inclusive links dos trabalhos. A ordem nativa não é o documento
portado `/app/erp/documentos-empresa?tipo=service_orders`.
Destinos desconhecidos, desligados e negados são estados da SPA, não códigos
HTTP enviados pelo servidor.

`pages.tsx` carrega somente a página nativa autorizada. A própria área ERP é
carregada sob demanda, com repetição de falha de chunk. Trilho, Mais, entrada,
catálogo, negativas e páginas nativas não importam o pacote portado nem chamam
a erp-api. Só destino portado autorizado importa `mount.tsx` e antecipa
`/v1/me`. Falhas de status, chunk ou acesso permitem repetir; montar não executa
comandos de negócio. Nativos e menu permanecem fora de `.fagoo-root`; somente
conteúdo e ferramentas portados recebem esse escopo. As exceções existentes de
impressão em `web/erp/css-scope.ts` permanecem intactas.

A política leve `ported-policy.ts` classifica destinos completos, papéis e
recursos. **`erpPartEnabled` em `web/erp/modules.ts` é o único ponto de decisão
de ativação das partes portadas**, usado por menu, URLs, busca e ações. O núcleo
`erp` ainda é indivisível, com Fiscal, Cobrança e PDV opcionais. “Só Cadastro” é
um contrato futuro verificável com contribuição isolada; não é configuração de
produto disponível nesta versão. Não há chaves novas de módulo.

**Verificação fina portada:** o contrato efetivo combina `/v1/me` e
`/v1/sistema/permissoes`, incluindo permissões individuais (por exemplo,
`suprimentos.controle_estoque`). A consulta fina começa somente após a autorização
básica de um destino portado. Trilho, Mais, entrada leve e páginas nativas não
consultam a ERP API; a casca recebe o resultado do hospedeiro autorizado.
Destinos dependentes desse resultado ficam **a verificar**, sem presumir uma
lista irrestrita. Erro recuperável e negativa são estados diferentes. O Dashboard
`/acesso` preserva a entrada que inicia essa verificação.

**Fiscal por tipo:** `tipo=notas` na URL corresponde a `tag_type="invoices"` no
domínio. Com Fiscal desligado, leituras mistas excluem esse tipo e suas mutações
são recusadas; produtos e contatos continuam disponíveis. A decisão usa o tipo
persistido ou herdado do pai, não apenas o campo enviado pelo navegador.
`erpPartEnabled` continua decidindo a ativação; metadados internos não alteram
`command_id`, conteúdo de negócio ou assinaturas públicas dos RPCs.

O portado usa roteador em memória e publica pela ponte registrada em
`bindManagementRouter`. O roteador principal é o único escritor do histórico.
Portado→portado usa a confirmação portada; entrada, saída e nativos usam a
guarda principal. Voltar/avançar restauram posição e conteúdo enquanto aguardam
a decisão e reaplicam somente o deslocamento aceito. Cliques durante a decisão
portada compartilham a transação; cancelamento não publica. Descartes são
idempotentes e não removem outra conexão. Troca de área/pessoa/permissão e eventos
de módulos invalidam leituras anteriores e suspendem novas ações indisponíveis.

**Identidade e atualização da política têm ciclos distintos:** alterar um módulo
independente não recria editor nem roteador. Suspender uma página na mesma sessão
preserva o rascunho, bloqueando operações e respostas invalidadas. Troca de pessoa
ou área e expiração descartam o estado anterior; não há novo armazenamento de
rascunhos sensíveis. A proteção de saída também deve alcançar a recarga enquanto
o conteúdo está suspenso.

**Parâmetros de sessão:** o endereço público usa `/app/erp` e conserva somente
`demo` e `pair` como parâmetros de sessão. A ponte retira esses dois antes dos
parsers de negócio do roteador portado, mantendo filtros, IDs, repetições válidas,
escapes e fragmentos. Os parsers financeiros permanecem estritos. Novas abas usam
`erpPublicHref` (`web/erp/public-url.ts`) no modo embutido, sem duplicar o prefixo
nem herdar filtros de negócio da página atual; fora dele, conservam a URL autônoma.

Essas decisões são o contrato esperado da divisão de correções. Este documento
não atesta a execução dos testes das outras tarefas.

### Cadastro único e dependência da fase 1

Ver [FASE1-CONTRATO.md](FASE1-CONTRATO.md): **declarações cadastrais não ligam
módulos nem concedem acesso**. O contrato, anteriormente “a conferir quando
publicado”, e a assinatura de `web/contact-profile/host-port.ts` já estão nesta
base e foram conferidos. O restante da entrega externa continua a conferir.

O adaptador da casa registra dinamicamente o carregador leve na sessão
validada; somente `mount` com área correspondente e IDs D1/ERP presentes importa
o hospedeiro completo. O ID ERP resolvido vai ao editor; o callback opcional
`openContactProfile` recebe o ID D1 sem conversão. Limpeza retira o registro e
as fichas da instância, inclusive montagens tardias. Registro e consulta da porta
não importam o ERP nem promovem/sincronizam contatos.

Nesta junção ainda faltam `web/contact-profile/ContactProfile.tsx` e
`ErpContactBody.tsx`. O hospedeiro usa o editor ERP existente; não inventa o
callback de abertura da ficha unificada. Registro/adaptação e montagem estão
implementados; a integração visual e o callback real da fase 1 **permanecem
pendentes** desses componentes. Ficha simples e contato sem vínculo ERP não
podem solicitar a montagem completa.

A suíte integrada está em `tests/management-lifecycle.test.ts`. Histórico,
políticas, rede controlada e descarte não substituem a inspeção real: foco,
teclado, gaveta em desktop/celular, tema e impressão ficam **a conferir no
navegador**. A execução de Vitest pertence à verificação externa desta máquina.
Cada alias tem um caso independente de entrada, atualização e nova aba simulada,
com o prazo padrão da suíte. Desligamento e negativa por papel são verificados
separadamente, ambos sem importação de página nem chamadas ao ERP.
O teste de favoritos das extensões renderiza a casca real com `matchMedia`
controlado em desktop e celular: mantém URL e conteúdo de espera antes de
`/status`, sem carregar páginas nem consultar a API, e confere a instalação e
remoção do observador de viewport. Esse ambiente simulado não comprova layout
ou interação real no navegador.

Orçamento: soma do grafo de chunks iniciais, com os limites originais de
1.208 KiB de caracteres, 352 KiB gzip e 8 KiB de `renderedLength` ERP.

| Estado | Inicial (KiB) | Gzip (KiB) | ERP inicial (KiB) | Evidência |
| --- | ---: | ---: | ---: | --- |
| Base `e2694542` | 1.326,6 | 388,5 | 7,44 | Relato de Rotas, não repetido na integração |
| Rotas isoladas | 1.028,9 | 312,8 | 7,44 | Relato de Rotas |
| Junção recebida | 1.070,4 | 323,6 | 17,2 | Build local: falhava o limite ERP |
| Integração | 1.058,5 | 319,4 | 4,78 | Build local: nove chunks iniciais, limites preservados |

A medição final repetida soma 1.083.920 caracteres e 327.050 bytes gzip nos
nove chunks iniciais, com 4.893 caracteres ERP de `renderedLength`; o portado
fica em 33 chunks próprios.

O grafo inicial não inclui o portado nem as páginas operacionais da casa.
As páginas públicas de responsável (`/ensino/acesso`) e morador
(`/condominio/acesso`) são importadas sob demanda em `web/main.tsx`: cada endereço
carrega somente sua página; `/app` não baixa nenhuma delas nem suas folhas
específicas. A entrada usa espera e recuperação de import com **Tentar novamente**
e **Recarregar**, sem alterar a autenticação dos links públicos. O teste de build
confere os módulos emitidos no grafo inicial, mantendo os limites acima. As
medições da tabela são históricas, anteriores a esta correção.

### Dependência entre módulos (`requires`)

```ts
export const suporteModule: ModuleDefinition = { id: "suporte", requires: ["mensalidade"], … };
```

- **Ligar**: o dependente só liga com todos os requeridos ligados; senão
  `PUT /modules/suporte` responde `409 module_requires` ("Suporte pago depende
  de Mensalidade. Ligue esse módulo antes."). A tela Módulos mostra "Depende
  de" e trava o botão até o requerido ligar.
- **Desligar o requerido** com dependentes ligados responde
  `409 module_required` listando os dependentes. Com `{"enabled":false,
  "cascade":true}` (a tela Módulos pede confirmação e envia), o requerido e os
  dependentes desligam juntos; cada um publica `module.changed`, os
  dependentes com `because`. A resposta traz `also_disabled`. Religar o
  requerido não religa os dependentes.
- **Estado efetivo**: com um requerido desligado, o dependente conta como
  desligado em todo lugar (`GET /modules`, capacidades, rotas, menus,
  ganchos), mesmo que a linha salva diga ligado.
- **Só `public.ts`**: um módulo usa do outro apenas `src/modules/<id>/public.ts`,
  que o requerido mantém como contrato estável (funções que recebem
  `ModuleContext`, tipos de leitura). Nunca importe outros arquivos do
  requerido nem leia ou grave as tabelas dele (`mensalidade_`…). Mudança que
  quebre `public.ts` exige subir a `version` do requerido e ajustar os
  dependentes na mesma entrega.
- Declare em `requires` todo módulo cujo `public.ts` você importa: é assim
  que o núcleo garante que ele está ligado quando o seu código roda.
- Exemplo em uso: o Suporte pago tem `requires: ["mensalidade"]`. Desligar a
  Mensalidade desliga o Suporte. Para vender só o atendimento avulso, deixe a
  Mensalidade ligada e desmarque "Oferecer planos mensais" nas regras do
  Suporte.

## 2. Interface interna (`src/modules/api.ts`)

`modulesApi(env, profile, moduleId)` devolve um `ModuleContext`:

| Método | Para quê |
|---|---|
| `enabled()` / `requireEnabled()` | Estado do módulo na área (`409 module_disabled`) |
| `access(actor, scope)` | Mesma regra das rotas: área do ator e permissão da chave de aplicação |
| `mayRead(actor, "contacts"\|"notes")` | Dado sensível nas leituras, como no núcleo: pessoas da equipe sempre; aplicação só com `contacts:read` (dados pessoais) ou `notes:read` (notas internas). Veja "Dados pessoais, notas e cobrança" na seção 3 |
| `redact(actor, row, {contacts?, notes?})` | Cópia do registro sem os campos que o ator não pode ver; os campos somem da resposta |
| `verifiedPhone(c)` | Telefone autenticado pelo canal (só dígitos) ou null: grupo ou conversa de integração (`app:<id>`), cujo `external_id` é escolhido por quem chama. Compare ou vincule registros por telefone só com ele; nunca use `c.phone \|\| c.external_id` como identidade |
| `note(c, text)` | Nota interna na conversa (só a equipe vê), por exemplo uma pendência depois de estorno |
| `settings()` | Configurações da área (já mescladas com os padrões) |
| `activeTicket(c)` | Protocolo ativo da conversa (não resolvido nem fechado, o mais recente) ou null: `{id, number, status, title, created}`. Para regras como "vale até o protocolo fechar", sem ler a tabela `tickets` |
| `conversationByPhone(phone, {open?, connection_id?})` | Conversa individual da área com o telefone (aceita com e sem o 9 do celular; sem DDI, no formato brasileiro, recebe 55), ou null. Com `open: true`, abre uma na linha oficial (Zernio) para o cliente que nunca escreveu: nasce sem janela de 24 h, então só sai notificação por modelo (`notification: true`, com o consentimento da finalidade) até ele responder, e a resposta cai na mesma conversa mesmo que o WhatsApp mande outro identificador. Publica `conversation.created` com `opened_by: "module:<id>"` |
| `handoff(c, {target?, summary?, flags?, reason?, key?})` | Passa a conversa para atendimento humano: `target: {department_id}` (setor), `{user_id}` (pessoa, como a transferência da equipe) ou nada (fila geral). `summary` (até 3000) e `flags` (até 10, de até 60 caracteres, ex. "telefone não vinculado") viram nota interna e o campo `handoff` `{module, summary, flags, at}` do detalhe da conversa, mostrado no painel; somem na próxima passagem sem módulo e ao encerrar. Com `key`, repetir não passa de novo. Não passa pelos ganchos `onHandoffRequest` (é como o módulo libera a conversa que segurou). Devolve a conversa atualizada |
| `establishment()` | Dados do estabelecimento para cupom, comanda, recibo e mensagens: `{name, document, document_type: "cpf"\|"cnpj"\|null, document_display, address, address_free, street, number, complement, district, city, state, postal_code, municipality_code, latitude, longitude, position, phone, footer, configured}` (`address`: montado dos campos com rua e cidade, senão o texto livre; `position`: a loja, ou null). Sem cadastro, `name` é o nome da área e `configured` é falso. Os aplicativos leem o mesmo em `GET /profiles/{p}/establishment`; as páginas do passo web já mostram nome no cabeçalho e o resto no rodapé |
| `conversation(id, actor?)` | Conversa da área, respeitando a visibilidade do ator |
| `contact(c)` | Contato vinculado à conversa (`id, name, phone, email, company, notes`) ou `null` |
| `sendMessage(c, {text, content?, attachments?}, {key, actor?, notification?})` | Mensagem ao cliente pela fila de entrega; `key` torna idempotente; `notification: true` usa o modelo de notificação com a janela de 24 h fechada |
| `sendMessage`/`sendInteractive`: `purpose` | Notificação fora da janela de 24 h: com `purpose` (`billing`, `scheduling`, `order`, `booking`), só sai com o consentimento dessa finalidade (`recordConsent`); sem `purpose`, vale o consentimento de protocolo, como antes. As cobranças do núcleo saem como `billing` |
| `cancelWebStep(id)` / `cancelWebSteps({kind?, ref?})` | Cancela um link aberto do próprio módulo, ou todos os abertos com o `kind` (e o `ref`) dados, por exemplo os carrinhos quando a loja pausa. Quem abrir vê "Link indisponível"; publica `web_step.cancelled` com `actor: "module:<id>"`. Link já fechado fica como está; de outro módulo, 404 |
| `openWebStep(c, request)` | Abre um passo web do módulo (seção 4). Linha oficial com a janela de 24 h fechada: `409 window_closed` (fora do menu); troque por um convite com `sendMessage(…, {notification: true})` |
| `publish(kind, id, payload, {key?})` | Evento declarado em `events`; o núcleo acrescenta `module_id`. Com `key`, publicar de novo a mesma chave não duplica (use algo como `${id}:${updated}`) |
| `sendInteractive(c, spec, {key, actor?, notification?})` | Botões, lista, Flow, produto… (`spec` de `src/whatsapp-interactive.ts`): nativo na linha oficial, texto numerado com links no QR; `notification: true` fora da janela manda o texto pelo modelo de notificação |
| `charge(c, {method, amount_cents, description, ref?, sourceKey, expiresMinutes?, notification?, receipt?})` | Cobrança Pix ou link pela conta da área (seção "Cobrar"). `receipt: false`: o núcleo não manda o "Pagamento recebido" (o módulo manda o próprio comprovante no `onPaymentUpdated`) |
| `recordConsent(c, {purpose, source, status?, evidence?, key?})` | Consentimento de notificação por finalidade (`billing`, `scheduling`, `order`, `booking`), registrado quando o cliente contrata, agenda, pede ou reserva pelo WhatsApp (`source: "whatsapp"`) ou a equipe registra o aceite (`"panel"`, `"contract"`), com data, módulo e evidência. Publica `consent.updated`. REVOGAR do cliente revoga todas as finalidades; um novo aceite depois vale de novo |
| `consent(c, purpose)` | Último registro que vale para a finalidade (o dela ou o REVOGAR geral), ou null |
| `sendEmail(c, {to, subject, text, html?}, {purpose, key})` | E-mail ao cliente da conversa pelo Cloudflare Email Sending da instalação ([EMAIL.md](EMAIL.md)). Exige o consentimento da finalidade (`recordConsent`, senão `409 consent_required`). `key` torna o envio idempotente na área (a repetição devolve o anterior com `repeated: true`). Limite de 200 envios por área em 24 h (`429 email_limit`). Sem e-mail configurado, `409 email_unavailable`: use o WhatsApp. O assunto não leva link nem código (`400 invalid_subject`); links vão no corpo. Cada envio fica em `email_log`, sem o corpo e com o endereço mascarado. Devolve `{id, status: "sent"\|"queued"\|"bounced"}` |
| `cancelCharge(payment \| id)` | Cancela uma cobrança aberta pelo próprio módulo (reserva cancelada antes do sinal), no provedor também. Já cancelada ou expirada: devolve como está; paga ou estornada: `409 payment_closed`; de outro módulo: 404 |
| `paymentsReady()` | Se a área pode cobrar agora, sem ler tabelas do núcleo: `{ready, reason: "payments_disabled"\|"payments_not_configured"\|null, message, methods}` |
| `read(actor, path, query?)` | Lê uma rota GET de outro módulo em nome do ator, como `GET /profiles/:profile/<path>` (mesma permissão, 409 `module_disabled`, campos ocultos). Usar a API pública de um módulo sem `requires` nem `public.ts`: a Entrega lê `pedido/orders/:id` assim. Chave presa à conversa (`conversations:bound`): `403 bound_key` |
| `run(actor, op, data, requestId)` | Executa um comando público de outro módulo (`pedido.status`) em nome do ator, dentro do comando ou da rodada em andamento no Coordinator; sem recibo próprio. Só comandos de outro módulo. Recusado no contexto criado no Worker (`onTelemetry`, `onWebStepPage`), que está fora da fila serializada da área, e para chave presa (`403 bound_key`) |
| `moduleActor({reach, label?})` | Ator `module:<id>` para `read`/`run` só nos módulos de `reach`; o dono decide o que ele pode (veja "Ator de módulo") |
| `issueCredential(subject, {actor, claimMinutes, ttlMinutes})` / `revokeCredentials(subject, reason)` / `credentials(subject)` | QR de acesso sem login a um registro do módulo; veja "Credencial por QR" na seção 3 |
| `wake()` | Acorda o Coordinator da área (alarme em seguida; a rodada dos módulos no máximo uma vez por minuto). Para rotas de telemetria que gravaram algo a avisar |

Ganchos registrados no carregamento do arquivo do módulo:

| Gancho | Quando roda |
|---|---|
| `onSettingsSave(module, key, validate)` | `PUT /settings` com a chave; devolva o valor normalizado ou lance `ApiError`. Objeto parcial chega já mesclado com o salvo (os campos que não vieram ficam como estavam); lista ou valor simples substitui |
| `onMenuChoice(type, handler)` | Cliente escolhe um item do tipo no menu do WhatsApp (só com o módulo ligado e fora de grupos) |
| `onConversationAction(module, action, handler)` | `POST /conversations/:id/actions` com `{"action":"<nome>"}`; o núcleo já conferiu `conversations:write` e a visibilidade; quem pode agir é regra do módulo |
| `onWebStepValidate(module, validator)` | Última conferência antes de concluir um passo web do módulo (depois da validação dos campos e do recálculo do carrinho): devolva um texto para recusar (loja fechou, item esgotou). A página mostra o motivo no lugar de "Pedido enviado!", com o que o cliente preencheu, e o link continua aberto. Erro no gancho recusa com aviso genérico. Resposta por Flow recusada recebe o motivo na conversa |
| `onWebStepCompleted(module, hook)` | Cliente concluiu um passo web aberto pelo módulo. Aberto com `spec.return_message: "module"`, o núcleo não manda o retorno padrão e a string devolvida pelo gancho vira o retorno. O passo já está concluído: erro no gancho vai para o log e não muda a página |
| `onMcpTool(module, tool)` | Ferramenta para bots (MCP), traduzida para uma rota da API v1; veja "Ferramentas para bots" |
| `onCommand(module, op, handler)` | Comando de escrita do módulo, executado no `Coordinator` da área com idempotência e auditoria. O `requestId` (também em `onConversationAction`) é opaco: 32 hexadecimais únicos por credencial, área, operação e Idempotency-Key, iguais nas repetições. Use-o em `sourceKey` e ids derivados; nunca use a chave do cliente diretamente |
| `onRoute(module, {method, path, op})` | Liga `POST/PUT/PATCH/DELETE /profiles/:profile/<path>` ao comando `op` (corpo + `:id` viram `data`; exige `Idempotency-Key`) |
| `onRead(module, path, handler)` | `GET /profiles/:profile/<path>` sem passar pelo `Coordinator` |
| `onConversationTurn(module, handler)` (apelido `onInboundReply`) | Próxima mensagem do cliente numa conversa individual: `handler(ctx, c, {text, replyId, rowId})`; devolva `true` quando é do módulo. Veja "Conversa no chat" abaixo |
| `onPaymentUpdated(module, hook)` | Cobrança aberta pelo módulo mudou: `paid`, `expired`, `cancelled` ou `refunded`. Entrega durável: se o gancho lançar, a mudança fica pendente e o núcleo repete (reenvio do webhook e alarme, com intervalo de 1 min dobrando até 1 h) até concluir, em ordem e com o `status` daquela mudança. O gancho deve ser idempotente (use chaves de origem) |
| `onSchedule(module, handler)` | Tarefa periódica (lembrete, vencimento): `handler(ctx, {now})` em cada área com o módulo ligado, no máximo uma vez por minuto e ao menos a cada 5 minutos; veja abaixo |
| `onInboundContent(module, type, handler)` | Cliente mandou conteúdo estruturado: `"order"` (carrinho do catálogo, `content.order`), `"flow_reply"` sem passo web correspondente (`content.flow_reply`) ou `"location"` (localização, `content.location {latitude, longitude, name, address}`; sem módulo que trate, segue o caminho de sempre). Roda antes do menu e do bot; devolva `true` quando tratou |
| `onRead`/`onRoute`/`onTelemetry` com `{ credential: true }` | A rota aceita a credencial por QR do registro `:id` (veja "Credencial por QR"); sem isso, a credencial recebe `403 credential_scope` |
| `onTelemetry(module, path, handler)` | `POST /profiles/:profile/<path>` **fora do Coordinator**, sem `Idempotency-Key`, recibo nem auditoria (corpo até 64 KB): só para dados idempotentes por natureza, como posições com horário. `handler(ctx, actor, {params, body})`; o núcleo já conferiu a área e o módulo ligado, recusa conectores (403) e limita a 60 chamadas por minuto por credencial, área e rota (`429 rate_limited`); a permissão fica com o módulo. Poupa as 4 instruções do recibo por chamada. O contexto não executa `ctx.run`. Para mandar mensagens, `ctx.wake()` e a rodada do módulo |
| `onCredentialClaim(module, handler)` | O app leu o QR do módulo (`ctx.issueCredential`): `handler(ctx, credential)` no Coordinator, depois de gravar a leitura; lance `ApiError` para recusar (a leitura é desfeita) ou devolva os dados da resposta ao app. Veja "Credencial por QR" |
| `onWebStepPage(module, handler)` | Página de acompanhamento: passo web com `spec.page: "track"` (sem campos, nunca conclui). A cada abertura o núcleo chama `handler(ctx, step)` e monta a página sem script com o `TrackView` devolvido (`title`, `status_label`, `headline`, `lines`, `notice`, `map {courier, destination}`, `tiles {url, attribution}`, `refresh_seconds`; `src/web-track.ts`), mapa em blocos do OpenStreetMap público ou do provedor em `tiles` (HTTPS com `{z}`, `{x}`, `{y}`). `null` ou erro no gancho (registrado no log): "Acompanhamento encerrado" (410). O contexto não executa `ctx.run` |
| `onHandoffRequest(module, handler)` | Toda passagem automática para humano passa por aqui antes de acontecer: `handler(ctx, c, {source, reason, department_id, summary, menu_item_id})` devolve `"hold"` para segurar ou `"allow"`. Veja "Passagem para humano" abaixo |

Exemplo mínimo (do módulo Formulários):

```ts
import { onCommand, onMenuChoice, onRead, onRoute, onSettingsSave, onWebStepCompleted } from "../api";

onSettingsSave("forms", "forms", validateForms);

onMenuChoice("form", async (ctx, c, item, { rowId }) => {
  await sendForm(ctx, c, item.form_id, { trigger: "menu", actor: "system", sourceKey: `menu:${rowId}` });
});

// GET /api/v1/profiles/:profile/forms
onRead("forms", "forms", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  return { data: /* … */ [] };
});

// POST /api/v1/profiles/:profile/forms/:id/send  {conversation_id}
onRoute("forms", { method: "POST", path: "forms/:id/send", op: "form.send" });
onCommand("forms", "form.send", async (ctx, actor, data, { requestId }) => {
  ctx.access(actor, "conversations:write");
  const c = await ctx.conversation(data.conversation_id, actor);
  // … regra de quem pode agir, depois:
  return (await sendForm(ctx, c, data.id, { trigger: "agent", actor: actor.id, sourceKey: `command:${actor.id}:${requestId}` })).step;
});

onWebStepCompleted("forms", async (ctx, step, answers) => {
  await ctx.publish("form.submitted", step.id, { form_id: step.ref_id, answers });
});
```

Escritas: prefira `onRoute` + `onCommand`. O comando roda serializado no
`Coordinator` da área (como `queue.*`), com recibo de idempotência, auditoria e
alarme agendado ao final, então mensagens enfileiradas saem sozinhas. O
núcleo confere a área do ator e o estado do módulo; **a permissão
(`ctx.access`) e a regra de quem pode agir ficam com o comando**. Leia o ator
recebido; não confie em `actor`/`user_id` vindos do corpo. A resposta do
comando é gravada no recibo e devolvida igual ao repetir a mesma
`Idempotency-Key`.

Documente as rotas novas em `src/modules/openapi.ts` (lista
`moduleOperations` e `describeModuleOperation`) e em `docs/API.md`.

### Conversa no chat (`onConversationTurn` + `ctx.sendInteractive`)

Para fluxos que seguem no WhatsApp (serviço → profissional → horário;
orçamento com Aprovar/Recusar; botões do lembrete):

```ts
import { onConversationTurn } from "../api";

await ctx.sendInteractive(c, {
  type: "list",
  body: "Orçamento #12: R$ 150,00",
  button: "Responder",
  sections: [{ rows: [
    { id: "os:aprovar:12", title: "Aprovar" },
    { id: "os:recusar:12", title: "Recusar" },
  ] }],
}, { key: `orcamento:12` });

onConversationTurn("os", async (ctx, c, { text, replyId, rowId }) => {
  if (replyId?.startsWith("os:")) return handleQuoteReply(ctx, c, replyId, rowId);
  if (!(await temOrcamentoPendente(ctx, c))) return false;  // texto alheio segue
  return handleQuoteText(ctx, c, text, rowId);              // "1" / "2" no QR
});
```

- Ordem no `processInbox`: consentimento, avaliação, Flow/carrinho, fila de
  senhas, **módulos (na ordem de `runtime.ts`)**, porta de entrada,
  protocolos, menu e bot. As regras de automação, número e sessão do resto
  valem aqui também (área pausada ou mensagem de sessão antiga não chegam).
- Só conversas individuais, só com o módulo ligado. `replyId` só vem quando
  o toque chegou pelo próprio canal da conversa; caso contrário é `null`.
- Devolva `true` só para o que é seu: replyId com o prefixo do módulo
  (`agenda:`, `os:`) ou texto quando há estado aberto **na sua tabela**, com
  validade. Um replyId com o seu prefixo nunca chega ao menu, então não
  aparece "Esta opção não está mais disponível".
- MENU/VOLTAR: limpe o estado e devolva `false`, para o menu responder.
- **Conversa com atendente** (`c.state === "human"`): a mensagem também chega
  ao gancho (coberto por teste). Se o módulo tratar, nada muda na conversa:
  ela continua com o atendente. Decida pelo seu estado: uma pergunta aberta
  pelo módulo pode ser respondida; texto solto numa conversa com atendente
  normalmente é para ele (devolva `false`). Com a área pausada (automação
  desligada) o gancho não roda.
- Botões de resposta: `{type: "button", body, buttons: [{id, title, description?}]}`
  (1 a 3, título até 20). `description` só aparece no texto numerado do QR.
- Use `rowId` nas chaves de envio (`key: "turno:" + rowId`): um reprocessamento
  da mesma mensagem não repete a resposta.
- Os ids de opção: até 200 caracteres; títulos de lista até 24. A validação é
  a mesma em todas as linhas (`src/whatsapp-interactive.ts`).

### Passagem para humano (`onHandoffRequest` + `ctx.handoff`)

Para condicionar o atendimento humano (Suporte pago: só com assinatura em
dia ou depois de pagar), o módulo segura a passagem automática e libera
depois:

```ts
onHandoffRequest("suporte", async (ctx, c, request) => {
  if (request.source === "menu" && request.menu_item_id !== "humano-pago")
    return "allow";
  if (await assinaturaEmDia(ctx, c)) return "allow";
  await oferecerPagamento(ctx, c, request); // ctx.sendInteractive / ctx.charge
  return "hold";
});
onPaymentUpdated("suporte", async (ctx, payment) => {
  if (payment.status !== "paid") return;
  const c = await ctx.conversation(payment.conversation_id!);
  await ctx.handoff(c, {
    summary: "Atendimento avulso pago.",
    flags: ["telefone não vinculado"],
    key: payment.id,
  });
});
```

- **Passam pelo gancho** (`source`): item de menu de atendimento humano
  (`"menu"`, com `menu_item_id`), palavra-chave como "atendente" (`"keyword"`),
  bot de IA ou especialista que transfere (`"bot"`), falha do bot
  (`"bot_error"`), anexo que o bot não lê (`"attachment"`), carrinho ou Flow
  sem dono (`"structured"`) e linha em atendimento por pessoa
  (`service.mode: "human"`, `"line"`). Nesta última, com um módulo de gancho
  ligado na área, a primeira mensagem da sessão não vai direto para a fila:
  passa pelo menu e pelos fluxos dos módulos e, se for para a equipe, pelo
  gancho. Sem módulo de gancho ligado, a linha põe na fila como antes.
- **Não passam**: a transferência feita pela equipe, o atendente que assume a
  conversa e o próprio `ctx.handoff`.
- **`request.row_id`**: a mensagem da caixa de entrada (ou a execução do bot)
  que pediu a passagem. É a mesma quando a mensagem é reprocessada; use nas
  chaves (`gate:${row_id}`) no lugar do relógio, para não abrir outra sessão.
- **Erro no gancho**: por padrão libera a passagem (o cliente nunca fica
  preso). Módulo que vende acesso à equipe declara
  `onHandoffRequest(module, handler, {failClosed: true})`: o erro segura a
  conversa e deixa uma nota interna para a equipe conferir.
- **Segurar** (`"hold"`): o núcleo não muda a conversa nem avisa o cliente;
  publica `conversation.updated` com `handoff_held: {module, source, reason}`.
  O módulo conduz pelo `onConversationTurn` e chama `ctx.handoff` quando
  liberar. Guarde `department_id` se quiser respeitar o setor pedido.
- **Ordem com mais de um módulo**: a de `modules` em
  `src/modules/registry.ts`; só módulos ligados; o primeiro `"hold"` encerra
  a consulta e os seguintes não são chamados. Quem segura assume a conversa
  inteira.
- **Erro no gancho** libera a passagem e vai para o log: o cliente nunca fica
  preso por falha do módulo.

### Ferramentas para bots (`onMcpTool`)

```ts
onMcpTool("agenda", {
  name: "agenda_horarios_livres",          // prefixo obrigatório: id do módulo + "_"
  description: "Horários livres de um serviço… Requer conversations:read.",
  input: { service_id: { type: "string" }, date: { type: "string" } },
  required: ["service_id"],
  call: (a, profile) => ({
    path: `/profiles/${profile}/agenda/availability`,
    query: { service_id: a.service_id, date: a.date },
  }),
});
```

- A ferramenta vira uma chamada interna à API v1 com a chave do bot: mesma
  autenticação, permissões, idempotência e `409 module_disabled` das rotas.
- `profile` entra sozinho nos parâmetros; com `write: true`, também
  `idempotency_key`. Escritas usam `method` e `body`.
- Aparecem em `tools/list` só quando o módulo está ligado em alguma área que
  a chave alcança (desligado, a ferramenta some; chamada pelo nome recebe o
  409 da rota). A descrição deve dizer a permissão necessária.
- **Só o cliente da conversa.** Ferramenta que lê ou mexe em dados de um
  cliente recebe apenas `conversation_id`: o servidor identifica o cliente
  pela conversa (a própria conversa ou o mesmo telefone). Nunca aceite
  telefone, CPF/CNPJ, nome ou número de registro como critério de busca: o
  bot não pode consultar outro cliente citado no texto. Ids de registro
  (agendamento, mensalidade) só valem se forem do cliente da conversa; de
  outro cliente, 404. Escritas passam por ações de conversa
  (`onConversationAction`), com a mesma idempotência e a regra de conversa
  assumida.
- Ferramentas de hoje:
  - Agenda: `agenda_servicos`, `agenda_horarios_livres`, `agenda_agendar`,
    `agenda_meus_agendamentos`, `agenda_remarcar`, `agenda_cancelar`.
  - Reserva: `reserva_disponibilidade`, `reserva_reservar`, `reserva_minhas`.
  - Ordem de Serviço: `os_situacao`.
  - Mensalidade: `mensalidade_situacao`, `mensalidade_segunda_via`,
    `mensalidade_pedir_dispensa`, `mensalidade_pedir_desconto`.
  - Suporte pago: `suporte_situacao`.
  - Fila: `queue_minha_senha`.
  - Pedido: `pedido_cardapio` (com preços, fora do bot do cliente),
    `pedido_itens`, `pedido_consultar`, `pedido_montar`,
    `pedido_pedir_desconto`, `pedido_enviar_carrinho`.
- Chave presa à conversa: com `conversations:bound` (padrão da chave criada em
  Integrações → Hermes), a aplicação só alcança as conversas que um dos bots
  dela está atendendo agora (execução na fila ou em andamento, ou encerrada há
  menos de 2 minutos) e as do próprio namespace. Listas de conversas,
  contatos, protocolos, eventos e relatórios da área respondem
  `403 bound_key`, e `tools/list` mostra só as ferramentas de atendimento. Um
  cliente que injeta instruções no bot não chega à conversa de outro cliente.
  Rotas de módulo liberadas para essa chave: as `…/conversations/:id` da
  ferramenta e os catálogos sem dado pessoal (`agenda`,
  `agenda/availability`, `reserva/availability`, `pedido/menu`) e as
  situações do cliente (`suporte/conversations/:id/situation`,
  `queue/conversations/:id`); uma rota de
  ferramenta nova entra na lista `BOUND_ROUTES` de `src/index.ts`.

### Ferramentas do cliente no bot do provedor direto (`onMcpTool` + `customer`)

O bot de provedor de IA direto (Anthropic, OpenAI, DeepSeek) que atende o cliente no WhatsApp recebe **as mesmas ferramentas `onMcpTool`** que o Hermes usa com a chave presa à conversa (`src/bot-actions/customer.ts`). **Nunca recebe o catálogo** nem ferramenta de equipe. São dois modos separados em código:

| | Modo equipe | Modo cliente |
|---|---|---|
| Quando | execução de conversa interna, pedida por uma pessoa | execução de conversa individual de linha (telefone autenticado) |
| Ferramentas | `buscar_operacoes`, `consultar`, `propor_acao` | as `onMcpTool` dos módulos ligados |
| Identidade | a pessoa (`actor` dela, `via`) | a conversa: o bot preso a ela (`conversations:bound`) |
| Escrita | proposta; a pessoa confirma no painel ou no app | proposta; **o cliente** confirma tocando no botão na conversa |

**Contrato para declarar uma ferramenta de cliente:**
```ts
onMcpTool("mensalidade", {
  name: "mensalidade_segunda_via",          // prefixo do módulo
  description: "…",                         // o que faz, em português
  input: { conversation_id: { type: "string" }, installment_id: { type: "string" } },
  required: ["conversation_id"],
  write: true,
  customer: "read",   // false: fora do cliente; "read": sem confirmação; "propose" (padrão de write): com botão
  call: (a, profile) => ({ method: "POST", path: `/profiles/${profile}/conversations/${a.conversation_id}/actions`, body: { action: "mensalidade_copy" } }),
});
```

**Regras do núcleo (valem sem o módulo fazer nada):**
- `conversation_id` nunca vem do modelo: sai do esquema e é sempre o da execução. Ids de registro que o modelo mandar passam pela regra do módulo, que responde 404 para registro de outro cliente.
- Leitura roda como o bot preso à conversa, sem `contacts:read`. O módulo mostra ao cliente só o mínimo (os últimos dígitos do documento, nunca o documento inteiro), como já faz para a chave presa. O núcleo ainda tira dado pessoal e segredo do que vai ao modelo.
- Escrita (`write` sem `customer: "read"`) vira proposta e não executa. O cliente recebe "Para eu fazer isto, confirme:" com **Confirmar** e **Cancelar**.
  - **O texto que o cliente confirma vem do módulo, nunca do modelo**: declare `describe(env, profile, input)` na ferramenta e devolva o que roda, com dados lidos por código (serviço, data, valor). O `input` já traz o `conversation_id` da execução; leia só registros desta conversa, para não mostrar dado de outro cliente. Sem `describe`, o núcleo lista a ação e os campos do pedido (`src/bot-actions/describe.ts`). O `resumo` do modelo só fica no registro.
  - **Confirmar**:
    - o toque no botão do próprio canal, tratado antes dos ganchos dos módulos (o id leva a proposta);
    - CONFIRMAR ou CANCELAR digitado, só depois de os ganchos dos módulos (`onConversationTurn`) terem a chance de tratar a mensagem, e só com **uma** proposta aberta na conversa. Com mais de uma, o cliente é avisado para tocar no botão de cada uma.
    - "sim", "não", "1" e "2" soltos não confirmam nada: são respostas comuns a outras perguntas, e tratá-los custaria uma consulta ao D1 por mensagem.
  - **Prazo**: a proposta vale 10 minutos.
  - **Repetir**: a ação roda com `Idempotency-Key` `proposal:<id>:<tentativa>`, e a proposta só roda uma vez (estado `running` antes de chamar), então tocar de novo não repete.
  - **Rota**: só ação da própria conversa (`/conversations/<id>/actions`).
- Preço, desconto, total e estado financeiro saem do módulo, nunca dos parâmetros do modelo. "Já paguei" e comprovante não mudam estado: só o webhook do provedor muda.
- CPF/CNPJ digitado nunca abre dado financeiro nem vincula telefone (achado A4 da revisão de segurança). A identidade é o telefone verificado da conversa.
- Limites: 6 chamadas e 3 propostas por resposta; resultado cortado em 4.000 caracteres.

**Ferramentas de cliente que existem hoje:**

| Módulo | Ferramentas |
|---|---|
| OS | `os_situacao` |
| Mensalidade | `mensalidade_situacao`, `mensalidade_segunda_via` (só reenvia o código do próprio cliente); pedidos à equipe, sem botão porque só registram: `mensalidade_pedir_dispensa`, `mensalidade_pedir_desconto` |
| Agenda | `agenda_servicos`, `agenda_horarios_livres`, `agenda_meus_agendamentos`; com botão: `agenda_agendar`, `agenda_remarcar`, `agenda_cancelar` |
| Pedido | `pedido_itens` (sem preços), `pedido_consultar`; `pedido_montar` (o módulo manda o resumo com os valores e o botão Confirmar pedido dele); `pedido_pedir_desconto` (pedido de aprovação); com botão do núcleo: `pedido_enviar_carrinho`. `pedido_cardapio` (com preços) fica fora do cliente |
| Reserva | `reserva_disponibilidade`, `reserva_minhas`; com botão: `reserva_reservar` |
| Suporte pago | `suporte_situacao` |
| Fila (núcleo) | `queue_minha_senha` |

### Pedido de aprovação à equipe (`ctx.requestApproval` + `onApproval`)

Para o cliente pedir o que só a equipe concede (desconto, isenção de taxa, dispensa de parcela). O bot **nunca concede**: a ferramenta do cliente só registra o pedido e diz que vai consultar a equipe. Núcleo em `src/approvals.ts`, migração 0086. Uso real: dispensa e desconto de mensalidade em `src/modules/mensalidade/requests.ts` (docs/MENSALIDADE.md).

```ts
// 1. Ferramenta do cliente (modo cliente), que só registra o pedido:
onMcpTool("pedido", {
  name: "pedido_pedir_desconto",
  description: "Pede à equipe um desconto no pedido aberto do cliente da conversa. Não concede nada.",
  input: { conversation_id: { type: "string" }, observacao: { type: "string" } },
  required: ["conversation_id"], write: true, customer: "read",
  call: (a, p) => ({ method: "POST", path: `/profiles/${p}/conversations/${a.conversation_id}/actions`,
                     body: { action: "pedido_desconto", observacao: a.observacao } }),
});

// 2. A ação monta o cartão com dados lidos por código, nunca com números do modelo:
onConversationAction("pedido", "pedido_desconto", async (ctx, actor, c, data) => {
  const order = /* pedido aberto do telefone verificado da conversa */;
  const approval = await ctx.requestApproval(c, {
    kind: "desconto", ref: order.id,
    title: `Desconto no pedido nº ${order.number}`,
    fields: [
      { key: "itens", label: "Itens", value: "…" },
      { key: "total", label: "Total de tabela", value: "R$ 62,00" },
      { key: "ultimas", label: "Últimas compras", value: "5 pedidos, média R$ 58,00" },
      { key: "margem", label: "Margem", value: "38%", restricted: { admin: true } },
    ],
    approvers: { access: "pedido" },          // ou { admin: true } ou { role: "pedido:gerente" }
    adjust: { label: "Desconto (R$)", type: "money", min: 0, max: 6.2 },
    ttlMinutes: 30,
    modelSummary: data.observacao,            // guardado à parte, como não verificado
    botId: actor.via?.bot_id, runId: actor.via?.run_id,
    key: order.id,                            // repetir não abre outro
  });
  return { pedido: approval.id, estado: "aguardando a equipe" };
});

// 3. A decisão: o módulo confere o limite de quem decide e aplica o efeito.
onApproval("pedido", "desconto", {
  async validate(ctx, approval, d) { /* ex.: atendente até R$ 5; lance ApiError 403 */ },
  async decided(ctx, approval, d) {
    // d.status: approved (d.value), declined (d.reason), handoff, expired (d.actor null)
  },
});
```

**Regras do núcleo**
- **O cartão**:
  - `fields` fica guardado como foi mostrado, para a auditoria;
  - `restricted` esconde o campo de quem não está na audiência (o app recebe `hidden_fields`);
  - `modelSummary` vai à parte, como "Resumo do bot (não verificado)".
- **A decisão**:
  - é uma rota que exige sessão de pessoa da audiência `approvers` (senão `403 approval_forbidden`); bot e chave de aplicação nunca decidem;
  - o primeiro a decidir vence; os outros recebem `409 approval_closed`;
  - `validate` e `decided` recebem o ator de quem decidiu, então as regras do módulo (papel, limite) valem;
  - erro em qualquer um devolve o pedido a pendente;
  - uma decisão que travou no meio (o Worker caiu entre o início e o fim) fica em `deciding` no máximo 2 minutos (`DECIDING_TTL`): depois a rodada periódica devolve o pedido a pendente (ou vence, se o prazo dele passou), e outra pessoa pode decidir. Por isso `decided` deve ser idempotente pelo `approval.id`: numa retomada, roda de novo.
- **Assumir**: `handoff` passa a conversa a quem tocou (`handoffToPerson`) e depois chama `decided` com `status: "handoff"`.
- **Prazo**: padrão 30 minutos, de 5 minutos a 7 dias. A rodada periódica vence os pedidos e chama `decided` com `status: "expired"`; sem `decided`, o núcleo avisa o cliente e põe a conversa na fila da equipe.
- **Auditoria**: `audit` com `approval.approve|decline|handoff`, e o pedido guarda conversa, cartão, quem decidiu, valor e quando.
- **Avisos**: o cartão vai à conversa interna de cada pessoa que pode decidir com o bot que atendeu (até 20), e o evento `approval.requested` dispara o push.

### Ações pelo bot na conversa interna (`definition.bot`)

Na conversa interna, o bot consulta e propõe ações **em nome da pessoa que pediu** (`src/bot-actions/`, contrato dos apps em `docs/API.md`, "Ações pelo bot"). O módulo não escreve nada para isso.

**O que o módulo ganha sem fazer nada**
- Toda rota pública do módulo entra no catálogo do bot: `onRead` vira "consulta" e `onRoute` vira "ação", com resumo e parâmetros tirados do OpenAPI do módulo (`moduleOperations` e `describe…`).
- Esquema de entrada bem descrito no OpenAPI deixa o bot mais preciso.

**Ajuste opcional na declaração**
```ts
bot: {
  deny: ["os.decide"],                      // ops ou caminhos fora do catálogo (prefixos)
  sensitive: ["mensalidade.installment.pay"], // segundo fator ao confirmar, conforme a política
  hints: { "consulta:service-orders": "Ordens de serviço abertas, por estado ou cliente" },
  // O que a pessoa confirma, com dados lidos por código (opcional):
  describe: { "os.status": async (env, profile, p) => `OS nº … para ${p.status}` },
}
```
- As operações com permissão de aplicação `billing:write` já contam como sensíveis.
- **Segundo fator**: `sensitive` pede o código pela política da instalação (`requireFinancialAal`, em `src/mfa.ts`). A operação roda com o `aal`, a sessão e a política de quem confirmou, então os guardas do módulo (`requireFinancialAal` na Mensalidade e no Suporte) valem também sem `sensitive`. Quando o guarda pede o código, a proposta continua aberta e o confirmar responde `403 mfa_required`.
- **Texto da proposta**: o cartão mostra o `describe` do módulo ou, sem ele, a operação e os parâmetros que vão rodar. O `resumo` do modelo aparece à parte, como "Texto do bot (não conferido)".
- Configurações (`PUT /settings`), módulos, pessoas, chaves e sistema nunca entram: não são rotas de módulo.

**Identidade.** A chamada chega ao módulo como se viesse da tela:
- o `actor` é a pessoa (`kind: "user"`), com o acesso e os papéis dela;
- o comando passa pelo `Coordinator`, com recibo e `Idempotency-Key` (`proposal:<id>` na confirmação).

O único sinal é `actor.via` (`{kind: "bot", bot_id, run_id, proposal_id?, masked}`), gravado em `audit.via`. **Não use `via` em regra de negócio**: quem pode agir é decidido pelas mesmas regras da tela.

**Dados pessoais.** Na leitura que vai ao modelo de IA, `ctx.mayRead(actor, …)` responde `false` e `ctx.botView` esconde os campos de `BOT_HIDDEN`, a menos que o administrador libere na instalação. Use `ctx.redact` e `filteredHandlers`, como já fazem os módulos, e nada mais é preciso. O núcleo ainda tira, de qualquer resposta, os campos de dado pessoal e os segredos.

**Mudanças do núcleo para isso** (para a sessão A revisar):

| Onde | O que mudou |
|---|---|
| `Actor.via` e `BotVia` | `src/types.ts` |
| `actorForUser` | `src/security.ts` |
| `audit.via` | `src/events.ts`, migração 0085 |
| `internalCall` | `src/mcp.ts`: a chamada interna do MCP, sem requisição de origem |
| `mayRead` e `botView` com `via.masked`; `BOT_HIDDEN` exportado | `src/modules/api.ts` |
| `ModuleDefinition.bot` | `src/modules/types.ts` |
| `internal_messages.kind` e `payload`; leitura com o estado da proposta | `src/team.ts` |
| Rotas `…/proposals/:id/confirm\|cancel` e `/system/bot-actions/configure` | `src/index.ts` |
| Campo `wabotia_run` no job do plugin | `src/integrations.ts`, `src/engine.ts` |
| Cabeçalho `X-Wabotia-Run` no MCP | `src/mcp.ts` |
| Segundo fator: `requireFinancialAal` do núcleo na proposta sensível; o ator que executa leva `aal`, `sessionId` e `mfa` de quem confirmou, e o guarda trata o ator com `via` como pessoa | `src/mfa.ts`, `src/bot-actions/actions.ts` |
| Laço de ferramentas e `aiCompleteWithTools` | `src/bot-tools.ts`, `src/ai-provider.ts`; escolha do modo em `aiRun` (`src/engine.ts`) |
| Modo cliente | `src/bot-actions/customer.ts`; resposta ao botão antes dos módulos no `processInbox`; campo `customer` em `ModuleMcpTool` (`src/modules/hooks.ts`) |
| Pedido de aprovação | `src/approvals.ts`; `ctx.requestApproval` e `onApproval` (`src/modules/api.ts`); rotas `/approvals`; push `approval.requested`; segmento `approvals` livre no acesso (a audiência decide) |
| Vencimento de pedidos e propostas | na rodada periódica (`src/modules/schedule.ts`) |
| Fila no bot ("minha senha", sessão H) | `conversationTicket` em `src/queue.ts`; rota e ferramenta em `src/modules/queue-tools.ts`, carregado por `src/modules/runtime.ts` |
| Rotas da chave presa (sessão H) | `BOUND_ROUTES` em `src/index.ts`: `queue/conversations/:id` e `suporte/conversations/:id/situation` |

### Tarefas periódicas (`onSchedule`)

```ts
import { onSchedule } from "../api";
import { runDue } from "./reminders";   // função pura, testável com qualquer `now`

onSchedule("agenda", async (ctx, { now }) => {
  await runDue(ctx, now);
});
```

- Quem chama: o alarme do `Coordinator` de cada área, serializado com o
  resto do atendimento da área. O cron do Worker (`*/5 * * * *`) acorda todas
  as áreas, então a rodada acontece **ao menos a cada 5 minutos**; quando há
  movimento, **no máximo uma vez por minuto** (`SCHEDULE_INTERVAL_MS`).
- Só roda em áreas com o módulo ligado. `now` é o instante da rodada (ms
  Unix); use-o em vez de `Date.now()` para testar e para calcular janelas.
- O horário não é exato: escolha "o que venceu até `now` e ainda não foi
  feito" (por exemplo `lembrete_enviado_em IS NULL AND horario-24h <= now`) e
  marque o registro na mesma rodada. Envie com chave de idempotência derivada
  do registro (`ctx.sendMessage(c, …, { key: "lembrete:" + id })`): uma rodada
  repetida não repete a mensagem.
- Uma exceção é registrada no log (`component: "module-schedule"`) e não
  impede os outros módulos; a próxima rodada tenta de novo.
- Nos testes, chame `runModuleSchedules(env, profile, now)`
  (`src/modules/schedule.ts`) ou a sua função `runDue` diretamente.
- Mensagens fora da janela de 24 horas em linha oficial só saem como
  notificação (`notification: true`), pelo modelo configurado.

Chaves de idempotência: use sempre algo derivado do pedido (`rowId` do menu,
`requestId` do comando, id do registro). Repetir a mesma chave não repete
mensagem, passo web nem protocolo.

## 3. Rotas, permissões e erros

- Rotas do módulo moram sob `/api/v1/profiles/:profile/<rota>`, com `<rota>`
  declarada em `routes`. O núcleo já autenticou o ator (cookie, `wabu_` ou chave
  de aplicação) e responde `409 module_disabled` com o módulo desligado.
- Leituras públicas (sem login) não existem para módulos nesta versão: use o
  passo web.
- Erros: lance `ApiError(status, code, mensagem)` (`src/types.ts`) com
  mensagem em português para quem usa. `requireValue(valor, mensagem)` gera
  `400 invalid_request`.
- Permissões de aplicação: reutilize as existentes (`conversations:*`,
  `contacts:*`, `tickets:*`, `billing:write`). Uma permissão nova entra na
  lista de `src/service.ts` e no OpenAPI; combine antes.

### Dados pessoais, notas e cobrança

- **Dados pessoais** (telefone, e-mail, documento, endereço, respostas de
  check-in): nas leituras do módulo, aplicação só vê com `contacts:read`.
  Pessoas da equipe veem. Use `ctx.redact(actor, row, {contacts: [...]})` na
  visão devolvida (listas, detalhe e as leituras das ferramentas de bot).
- **Notas internas** (observações da equipe, histórico com notas): aplicação
  só vê com `notes:read`; `ctx.redact(actor, row, {notes: [...]})`.
- Para nenhuma rota ficar de fora, use `filteredHandlers(filtro)` no lugar de
  `onRead`, `onCommand` e `onConversationAction`: toda resposta passa por
  `filtro(ctx, actor, valor)`. A Agenda e a Reserva fazem assim:
  `const { onRead, onCommand, onConversationAction } = filteredHandlers(visibleBookings);`
- **Operações financeiras** (baixa manual, isenção, criar ou mudar plano,
  valor ou desconto, importar assinaturas): aplicação precisa de
  `billing:write` (`ctx.access(actor, "billing:write")`), além do papel que a
  pessoa precisaria. `billing:write` não pode ser concedida a aparelhos
  pareados do Vinki nem do Fagoo (`409 scope_not_allowed`); uma chave de
  mensagens nunca vira chave financeira.
- **Identidade por telefone**: compare, vincule ou revincule registros por
  telefone só com `ctx.verifiedPhone(c)`. Em conversa de integração ele é
  null, e o módulo não procura nem puxa registros de outro cliente.
- **Falar com o cliente pela API**: criar com `conversation_id` só avisa ou
  cobra quando `ctx.mayMessage(actor, c)` (dono da conversa, administrador ou
  o bot que atende). Remarcar, cancelar, mudar estado e enviar orçamento
  pela API conferem `await ctx.mayNotify(actor, conversationId)`: pessoas da
  equipe avisam; aplicação, só quando `mayMessage`. Quando mandar a mensagem
  é a operação inteira (o link do check-in), a aplicação que não atende
  recebe 403. Cobrar parcela da Mensalidade já exige gerente ou
  `billing:write`.
- **Eventos**: os de módulo e os de passo web exigem `contacts:read`; os que
  levam nota interna preenchida (e todos os da OS e do Pedido) exigem também
  `notes:read`.

### Acessos e papéis (`grants`, `ctx.granted`)

O administrador marca, para cada atendente, **o que ele acessa** (Gestão →
Pessoas e acessos). A lista mistura três tipos de item, todos vindos de
`GET /profiles/{p}/access`:

- **áreas do núcleo**: `conversations`, `tickets`, `contacts`, `calls`,
  `team` e `reports`;
- **módulos**: o id do módulo (`os`, `agenda`, `pedido`…), que libera as
  rotas, os comandos e as telas dele;
- **papéis de módulo**: `<módulo>:<papel>`, declarados em `grants` da
  definição. O papel já libera o módulo dele.

```ts
export const entregaModule: ModuleDefinition = {
  id: "entrega",
  grants: [{ id: "courier", label: "Entregador", description: "Leva os pedidos e envia a posição pelo app." }],
  …
};

// No código do módulo:
if (!(await ctx.granted(actor, "courier")))
  throw new ApiError(403, "role_required", "Só o entregador desta entrega envia posições.");
const couriers = await ctx.grantees("courier"); // [{id, name}] ativos da área
```

Nomes combinados para os papéis (use exatamente estes):

| Módulo | Papel | Id completo | Nome no painel |
|---|---|---|---|
| Entrega (`entrega`) | `courier` | `entrega:courier` | Entregador |
| Mesas (`mesas`) | `waiter` | `mesas:waiter` | Garçom |
| Ordem de Serviço (`os`) | `technician` | `os:technician` | Técnico (já declarado) |
| Caixa (`caixa`) | `cashier` | `caixa:cashier` | Caixa |

Os atalhos de perfil do painel ("Atendente completo", "Só caixa", "Só garçom",
"Só entregador da loja", "Técnico") só preenchem as caixas. Um atalho aparece
quando todos os itens dele existem nesta versão.

**O que o núcleo garante:**

- **Lista guardada em `users.access`** (migração `0080`), por pessoa. Vale em
  todas as áreas que ela alcança. `["*"]` é o atendente completo: todas as
  áreas e todos os módulos, **sem papéis**. Quem já era atendente fica com
  `NULL`, que vale como `["*"]`, e não perde nada ao atualizar.
- **O administrador acessa tudo.** Ele não ganha papel automaticamente: para
  aparecer na lista de entregadores, precisa receber o papel. Aplicações e
  aparelhos pareados seguem pelos escopos e nunca têm papel.
- **Rotas:** `/profiles/{p}/<segmento>` confere o item do segmento (o módulo
  dono da rota, ou a área do núcleo) e responde `403 access_denied`. Dados de
  apoio sem cliente ficam livres: `status`, `capabilities`, `establishment`,
  `people`, `grants`, `access`, `presence`, `events`, `modules`, `media`,
  `menus`, `lines`, `router`, `bots` e `knowledge`. Segmento novo do núcleo
  fora dessas listas fica só para quem tem `*`. Se um módulo seu precisar de
  rota livre, combine com a sessão A.
- **Comandos:** `perform` confere de novo (o módulo dono do comando, ou a área
  do núcleo pelo prefixo), também `403 access_denied`. Um módulo não precisa
  conferir o próprio módulo; confere só o papel, quando a ação é de um papel.
- **Leituras:** os eventos (`GET /events` e o que deriva dele) somem para quem
  não acessa o assunto. O push de conversa, protocolo e ligação só vai a quem
  acessa conversas, protocolos ou ligações. O `/status` traz os contadores de
  conversas vazios para quem não acessa o atendimento. Os eventos do módulo
  seguem o módulo dono (`events` da definição).
- `ctx.granted(actor, papel)` e `ctx.grantees(papel)` aceitam só papéis
  declarados em `grants` do próprio módulo; outro nome lança erro (de código).
  Com o módulo desligado, os papéis dele somem de `capabilities`, de `/people`
  e de `/grants`, mas ficam guardados e voltam ao religar.
- **Leituras para escolher pessoa** (pessoa da área ou chave com
  `conversations:read`):
  - `GET /profiles/{p}/grants`: papéis dos módulos ligados e quem tem cada um;
  - `GET /profiles/{p}/people`: cada pessoa traz `grants` e a rota aceita
    `?grant=entrega:courier` (`400` se o papel não existir ou o módulo
    estiver desligado).
- **Gravar** (só administrador): `POST /users` e `PATCH /users/{id}` com
  `access` (lista ou `null`). O núcleo recusa item desconhecido. Mudar o
  acesso derruba as sessões da pessoa, que entra de novo com a lista nova.

> Até `855140a` (`feat/concessoes-modulo`, nunca publicado), os papéis ficavam
> por área em `module_grants` nas configurações. Essa chave não existe mais:
> o papel vai na lista da pessoa. O uso de `ctx.granted`/`ctx.grantees` não
> mudou.

### Credencial por QR (acesso sem login a um registro)

Para quem trabalha num registro do módulo sem ser da equipe (o entregador
avulso da Entrega): a equipe gera um QR, o app lê **fora do login** e recebe
um token que só alcança aquele registro. Núcleo em
`src/module-credentials.ts` (migração `0076_module_credentials`).

```ts
// Equipe gera (num comando): revoga o QR e a credencial anteriores do registro.
const qr = await ctx.issueCredential(entrega.id, {
  actor: actor.id, claimMinutes: 20, ttlMinutes: 3 * 60,
}); // {id, url: "<origem>/api/public/c/<código>", claim_expires_at}

// O app leu o QR (roda no Coordinator, depois de gravar a leitura):
onCredentialClaim("entrega", async (ctx, credential) => {
  // credential: {id, subject, label (nome digitado), device, claimed_at, expires}
  // Lance ApiError para recusar: a leitura é desfeita e o QR segue valendo.
  return { delivery: … }; // vai em `data` na resposta ao app
});

// A rota declara que aceita a credencial; o núcleo confere :id === subject.
onRead("entrega", "entrega/deliveries/:id/courier", handler, { credential: true });
onRoute("entrega", { method: "POST", path: "entrega/deliveries/:id/start", op: "entrega.start", credential: true });
onTelemetry("entrega", "entrega/deliveries/:id/positions", handler, { credential: true });
// Ator `cred:<id>`, kind "app", sem escopos. O módulo ainda confere quem é o
// entregador da entrega (segunda trava).

// Fim do registro: o app recebe 401 na próxima chamada.
await ctx.revokeCredentials(entrega.id, "Entrega concluída.");
await ctx.credentials(entrega.id); // quem leu, quando, de que aparelho
```

- **Troca:** `POST /api/credentials/claim` `{code, name, device}`, fora de
  `/api/v1`, sem autenticação, 10 por IP a cada 10 minutos, uso único
  (`410 claim_used`, `410 claim_expired`, `404 claim_not_found`). Responde
  `{token: "wabx_…", expires_at, profile, module, subject, credential_id,
  data}`. `GET /api/public/c/<código>` só orienta (câmera comum) ou, com `Accept: application/json`, diz se o código vale e o nome da loja; não gasta o QR. Fica debaixo de `/api/` por causa do `run_worker_first` do `wrangler.jsonc` (fora dele, a instalação serve o painel).
- **Escopo, negado por padrão:** o middleware de `/api/v1` recusa
  (`403 credential_scope`) qualquer caminho fora de
  `/api/v1/profiles/<área>/<rota do módulo>/…`. Dentro do módulo, **só a rota
  que declara `{ credential: true }`** (em `onRead`, `onRoute` ou
  `onTelemetry`) aceita a credencial, e o núcleo confere que o parâmetro do
  caminho (`:id`, ou o nome em `credentialParam`) é o `subject` dela; a rota
  sem esse parâmetro não pode aceitar. O comando confere de novo no
  Coordinator. Uma rota nova que não declare responde 403 à credencial: não
  há o que lembrar. O ator não tem escopos (`ctx.access` recusa),
  `ctx.granted` e `ctx.mayRead` são falsos, `ctx.read`/`ctx.run` recusam
  (`403 credential_scope`) e o MCP (`/api/mcp`) também (`403`).
- **Prazo:** o QR vale `claimMinutes` (5 a 120) até ser lido; o token,
  `ttlMinutes` (15 a 360) depois da leitura, e é revogado antes pelo módulo.
  Só os hashes do código e do token ficam guardados, com o nome digitado, o
  aparelho e o IP em HMAC com a `MASTER_KEY` (sem como reverter pelo espaço
  do IPv4; o limite por IP da troca usa o mesmo HMAC).
- Revisado pela sessão A em 16/11 (`sessao-A-revisao-credencial-qr.md`);
  as mudanças estão em `fix/credencial-qr`.

### Ator de módulo (`ctx.moduleActor`)

Para um módulo agir em outro pela API pública dele (`ctx.read`, `ctx.run`) em
nome de quem não tem acesso a esse outro módulo (o entregador do QR, a pessoa
só com o papel entregador):

```ts
const asPedido = ctx.moduleActor({ reach: ["pedido"], label: actor.name });
await ctx.run(asPedido, "pedido.status", { id, status: "delivered" }, requestId);
```

- `id` `module:<módulo>` (é o que aparece nos históricos), `kind: "app"` com
  os escopos de ler e mudar registros e ver contatos; nunca tem papel
  (`granted` falso), não entra no MCP nem nas rotas HTTP (só existe dentro do
  código do módulo).
- Só alcança os módulos de `reach` (`ctx.read`/`ctx.run` em outro:
  `403 module_scope`). O módulo dono confere o resto: o **Pedido** aceita
  desse ator só `pedido.status` para `out_for_delivery` ou `delivered` num
  pedido de entrega; cancelar, pagamento, cadastro e loja dão
  `403 module_forbidden`.
- Não use um ator `kind: "user"` montado à mão: com o acesso por pessoa, ele
  vale como atendente completo.

## 4. Passo web

Link curto de uso único, amarrado à conversa, que leva o cliente a uma página
leve e o devolve ao WhatsApp. Hoje a página é um **formulário** gerado pelo
núcleo a partir de campos; o módulo não escreve HTML.

```ts
const { step, url, created } = await ctx.openWebStep(c, {
  kind: "checkin",                 // tipo dentro do módulo
  ref: reservation.id,             // registro do módulo (vira ref_id)
  trigger: "module",               // menu | agent | bot | module
  actor: "system",
  sourceKey: `checkin:${reservation.id}`,
  ttlMinutes: 48 * 60,             // 5 min a 7 dias; padrão 24 h
  text: "Faça o check-in antes de chegar:",
  button: "Fazer check-in",        // botão com URL nas linhas oficiais (até 20)
  spec: {
    title: "Check-in",
    intro: "Leva um minuto.",
    fields: [
      { id: "doc", type: "text", label: "Documento", required: true },
      { id: "chegada", type: "date", label: "Data de chegada", required: true },
      { id: "quarto", type: "choice", label: "Cama", required: true, options: ["Casal", "Solteiro"] },
      { id: "regras", type: "accept", label: "Li as regras da casa", required: true },
    ],
    done_text: "Check-in feito!",
    return_text: "Check-in recebido. Até breve!",
    ticket: "none",                // attach | open | none
  },
});
```

- Campos: `text` (opcional `multiline`), `choice` (2 a 20 `options`), `date`
  (AAAA-MM-DD) e `accept` (caixa que precisa ser marcada quando `required`).
  Até 30 campos. As respostas chegam como `{ [id]: string | boolean }`.
- Estados: `sent` → `opened` → `completed`, ou `expired` (venceu) e
  `cancelled` (equipe cancelou). Cada mudança publica `web_step.<estado>`
  com `conversation_id`, `module_id`, `kind` e `ref_id`.
- Uso único: a conclusão é um `UPDATE` condicionado ao estado; o segundo
  envio vê "Este link já foi usado". O código tem ~93 bits, só o hash é
  guardado e a página usa `Referrer-Policy: no-referrer`.
- Ao concluir, o núcleo: grava as respostas; anexa ao protocolo ativo (ou abre
  um, com `ticket: "open"`); registra nota interna na conversa; envia o
  retorno no WhatsApp (modelo de notificação se a janela de 24 h estiver
  fechada); publica `web_step.completed`; chama `onWebStepCompleted` do
  módulo. A página mostra **Voltar ao WhatsApp** com o `wa.me` da linha.
- Fora da janela de 24 h numa linha oficial, só o gatilho `menu` envia o link
  (o cliente acabou de escrever); os demais recebem `400` pedindo que o
  cliente escreva antes.
- O endereço do link é o endereço público da instalação
  (`instance_settings.public_origin`): a primeira origem vista nas
  requisições de pessoas ao painel e aos apps vira o padrão e fica fixa
  (abrir o painel por outro nome não muda os links). O administrador troca em
  `POST /api/v1/system/origin/configure` `{public_origin}` e vê em
  `GET /api/v1/system`. Sem endereço, `409 origin_unknown`.
- **Entrega.** Numa linha oficial com `flow: {flow_id, flow_cta?, screen?}`
  (Flow publicado na conta, `src/whatsapp-flows.ts`), o passo sai como Flow
  nativo com `flow_token = "<flow_id>:<id do passo>"`, guardado em
  `web_steps.flow_token`; sem Flow, botão com URL (`cta_url`); em linha QR, o
  texto com o link. As três formas saem por `sendInteractive`
  (`src/line-service.ts`) e o texto guardado sempre leva o link da página.
  Os nomes dos campos do Flow precisam ser os `id` dos campos de `spec`.
  O módulo Formulários usa `flow_id`, `flow_cta` e `flow_screen` do formulário.
- **Resposta por Flow.** O recebimento normaliza a resposta em
  `content.type: "flow_reply"` (`src/whatsapp-inbound.ts`). O `processInbox`
  trata isso antes do menu e do bot (`src/structured-inbound.ts`): o
  `flow_token` de um passo desta conversa conclui o passo com as mesmas regras
  da página (validade, uso único, protocolo, nota e retorno no WhatsApp). Um
  Flow incompleto pede reenvio; repetido, avisa que já recebeu. Booleanos
  valem para `accept`; data em milissegundos vira AAAA-MM-DD.
- **Carrinho e Flow sem dono.** `"order"` e `"flow_reply"` sem passo web vão
  primeiro aos módulos (`onInboundContent`); sem dono, a conversa com o bot
  vai para a equipe com o resumo como pedido, e uma conversa com atendente só
  guarda a mensagem. O resumo em texto nunca abre o menu.
- Flows com endpoint próprio (`data_exchange`) não são hospedados pelo
  Wabotia; use Flows de navegação.
- Links já enviados guardam uma cópia dos campos: editar o formulário depois
  não muda o que o cliente vê nesse link.

### Página de carrinho (`spec.page: "cart"`)

Segundo tipo de página do passo web, para pedidos (lanchonete, loja): o
módulo entrega o catálogo ao abrir o passo; o cliente monta o carrinho,
revisa e confirma; o módulo recebe o pedido validado.

```ts
const { url } = await ctx.openWebStep(c, {
  kind: "cart",
  ref: menuVersion,                 // o que o módulo quiser ligar ao passo
  trigger: "menu",
  actor: "system",
  sourceKey: `cardapio:${rowId}`,
  ttlMinutes: 120,
  text: "Monte o seu pedido pelo link:",
  button: "Fazer pedido",
  spec: {
    page: "cart",
    title: "Lanchonete da Ana",
    intro: "Peça até as 22h.",
    fields: [],
    return_message: "module",       // o módulo responde com o número do pedido
    cart: {
      categories: [
        {
          id: "lanches",
          name: "Lanches",
          items: [
            {
              id: "xburger",
              name: "X-Burger",
              description: "Pão, carne 150 g e queijo",
              price_cents: 2500,
              image_url: "https://…/x.jpg",          // opcional, HTTPS
              available: true,                        // false: aparece, sem quantidade
              max_quantity: 10,                       // padrão 20
              option_groups: [
                { id: "ponto", name: "Ponto da carne", min: 1, max: 1,
                  options: [{ id: "mal", name: "Mal passada" }, { id: "bem", name: "Bem passada" }] },
                { id: "adicionais", name: "Adicionais", min: 0, max: 2,
                  options: [{ id: "bacon", name: "Bacon", price_cents: 500 },
                            { id: "cheddar", name: "Cheddar", price_cents: 400, available: false }] },
              ],
            },
          ],
        },
      ],
      fulfillment: {
        pickup: true, delivery: true,
        delivery_fee_cents: 700, minimum_cents: 2000,
        eta: "Pronto em 30 min", pickup_address: "Rua X, 100",
      },
      allow_note: true,
    },
  },
});

onWebStepCompleted("pedido", async (ctx, step, order) => {
  if (step.page !== "cart") return;
  // order: CartOrder (src/web-cart.ts), já validado e recalculado:
  // { lines: [{item_id, slot, name, quantity, unit_cents, options:[{group_id, group, id, name, price_cents}], note, total_cents}],
  //   item_count, subtotal_cents, delivery_fee_cents, total_cents, currency: "BRL",
  //   fulfillment: "pickup" | "delivery", customer_name, address: {street, district, complement, reference} | null, note,
  //   payment: {method, label, change_for_cents} | null }
  const c = await ctx.conversation(step.conversation_id);
  const pedido = await criarPedido(ctx, step, order);
  await ctx.charge(c, { method: "pix", amount_cents: order.total_cents, description: `Pedido ${pedido.numero}`, ref: pedido.id, sourceKey: `pedido:${pedido.id}` });
  return `Pedido nº ${pedido.numero} recebido! Total ${valor(order.total_cents)}.`;
});
```

- **Valores só do servidor.** A página não manda preço, subtotal nem total: o
  núcleo recalcula tudo a partir do catálogo guardado no passo ao revisar e de
  novo ao confirmar. Campos extras enviados pela página são ignorados.
- **Regras conferidas:** item disponível, quantidade de 0 a `max_quantity`,
  adicionais existentes e disponíveis, entre `min` e `max` por grupo (grupo
  com `min: 1, max: 1` vira escolha única), pedido mínimo sobre o subtotal,
  nome do cliente, endereço (rua e bairro) na entrega.
- **Fluxo da página, sem script:** carrinho → "Revisar pedido" (mostra linhas,
  subtotal, entrega e total; nada muda) → "Confirmar pedido" (conclui, uso
  único). "Voltar e alterar" volta ao carrinho com as escolhas.
- Mesmas regras do passo web: link de uso único, validade, expiração,
  `web_step.*`, nota interna com o pedido em texto, retorno no WhatsApp
  (padrão "Recebemos seu pedido. Total: R$ …"; com `return_message: "module"`,
  o texto devolvido pelo gancho). Carrinho não vai a protocolo por padrão
  (`ticket: "none"`).
- Limites: até 30 categorias, 100 itens por categoria e 300 no total; 10 grupos
  por item, 30 opções por grupo; ids com letras, números, `-` e `_`;
  preços em centavos inteiros. O catálogo é uma cópia: mudar o cardápio
  depois não altera links já enviados.
- **Foto do item.** `image_url` (HTTPS externo) ou `image_media_id`: uma
  imagem enviada para a área (`POST /media`). A página a serve pelo próprio
  link (`/api/w/<código>/img/<id>`), só as citadas no catálogo daquele link;
  `openWebStep` recusa mídia de outra área ou que não seja imagem.
- **Forma de pagamento e troco na página.** Com `cart.payment: {methods:
  [{id, label, change?}], required?}`, a página pergunta "Como você quer
  pagar?" (antes do nome) e, para as formas com `change: true` (dinheiro),
  "Troco para quanto?". O pedido traz `payment: {method, label,
  change_for_cents}`; o troco precisa ser ao menos o total e só vale para a
  forma com `change`. `required: false` deixa em branco (`payment: null`) e o
  módulo pergunta depois. Sem `cart.payment`, nada muda (`payment: null`).
- **Várias montagens do mesmo item.** Cada item tem o botão "+ Outra montagem
  deste item" (até 10 por item): dois X-Burger, um sem cebola e outro com
  bacon, viram **duas linhas** em `lines`, com o mesmo `item_id` e `slot` 0 e
  1, cada uma com quantidade, adicionais, observação e total próprios. Quem lê
  o pedido não deve supor um `item_id` por linha nem agrupar linhas pelo
  `item_id`. `max_quantity` vale para a soma das montagens. Formato do pedido:
  igual ao anterior, mais o campo `slot` em cada linha (aditivo).
- Campos da página (só interessam a quem testa com POST direto): a primeira
  montagem usa `q_<item>`, `o_<item>_<grupo>` e `n_<item>`; a montagem `k`
  usa `q_<item>.<k>`, `o_<item>.<k>_<grupo>` e `n_<item>.<k>`; `slots_<item>`
  diz quantas montagens o formulário traz. Erros vêm em `item:<item>` ou
  `item:<item>.<k>`.

## 4b. Cobrar (Pix e link de pagamento)

A Cobrança é do núcleo (módulo `payments`, `src/payments.ts`, contrato em
[COBRANCA.md](COBRANCA.md)). Uma vertical cobra assim:

```ts
import { onPaymentUpdated } from "../api";

// Ao fechar o pedido:
const payment = await ctx.charge(c, {
  method: "pix",                    // ou "link" (Checkout Pro: cartão, Pix…)
  amount_cents: order.total_cents,  // inteiro, em centavos
  description: `Pedido ${order.number}`,  // até 120 caracteres
  ref: order.id,                    // vira ref_id na cobrança e no gancho
  sourceKey: `order:${order.id}`,   // repetir não cobra de novo
  expiresMinutes: 60,               // 30 min a 30 dias; padrão 24 h
});
// Guarde payment.id no registro do módulo, se quiser mostrar o estado.

onPaymentUpdated("pedido", async (ctx, payment, { previous }) => {
  if (payment.status === "paid") await marcarPago(ctx, payment.ref_id!);
  if (payment.status === "refunded") await marcarEstornado(ctx, payment.ref_id!);
  // expired e cancelled: liberar estoque, horário, quarto…
});
```

- Pré-requisitos: módulo **Cobrança** ligado e conta configurada em
  **Gestão → Cobrança**. Sem conta: `409 payments_not_configured`; módulo
  desligado: `409 module_disabled`. Trate esses erros mostrando ao cliente
  outra forma de pagar.
- O núcleo entrega ao cliente (botão com URL na linha oficial, link no texto
  no QR, e o código Pix numa mensagem separada), registra nota na conversa,
  publica `payment.*` e envia "Pagamento recebido" quando paga. O módulo não
  envia essas mensagens.
- **Janela de 24 horas:** na linha oficial com a janela fechada, `charge`
  recusa (`409 window_closed`), a menos que você passe `notification: true`
  (lembrete de mensalidade, por exemplo): aí a cobrança sai em texto pelo
  modelo de notificação configurado.
- `paid` só chega pelo webhook do provedor, depois de consultar o pagamento.
  Nunca marque um registro como pago por mensagem do cliente. O gancho roda no
  `Coordinator` da área, uma vez por mudança, mesmo com webhooks repetidos.
- Um pagamento aprovado depois de `expired` ou `cancelled` vira `paid` (o
  dinheiro entrou): o gancho recebe `previous: "expired"`; decida no módulo
  se ainda dá para atender ou se é preciso estornar pelo painel do provedor.
- Sinal ou parcial: crie uma cobrança por parcela, cada uma com a sua
  `sourceKey`.
- Nos testes, simule o Mercado Pago com `vi.stubGlobal("fetch", …)` e o
  webhook assinado como em `tests/payments.test.ts` (`mpManifest` + `hmac`).

## 5. Painel web

- Telas do módulo em `web/modules/<id>/`. Para uma página operacional da casa
  ERP: declare a contribuição `management` no catálogo puro da Base, o id em
  `sections` e `pageModules` e, se exclusiva de administrador, em `adminPages`
  (`web/workspace-navigation.ts`); registre o endereço em `nativePageSlugs`
  (`web/management/routes.ts`) e o import sob demanda em
  `web/management/pages.tsx`. A casca autoriza antes de carregar a página.
  `workspaceGroups` e `web/admin/AdminArea.tsx` ficam com as páginas
  administrativas que continuam em Gestão. Siga `web/DESIGN.md`.
- `useApp().moduleOn("<id>")` diz se o módulo está ligado na área (vem de
  `GET /status`, campo `modules`).
- A demonstração (`web/lib/demo.ts`) responde `GET /modules`; acrescente o
  módulo para as telas de referência.
- **Trilho principal e Mais:** o botão ERP reúne as contribuições operacionais
  e aparece para quem pode entrar, independentemente de ativação. `railPages`
  permanece vazio; os campos antigos de `navigation` são metadados de
  compatibilidade. Os destinos dentro da casa exigem módulo ligado e acesso.
- **Painel da conversa:** uma linha em `conversationExtensions`
  (`web/modules/conversation.tsx`) mostra o seu componente em Dados da
  conversa, com o módulo ligado e fora de grupos. Recebe
  `{ conversation, name }`. Exemplos: `ConversationAgenda` e
  `ConversationServiceOrders`.
- **Editor de menus:** os tipos de item vêm de `menu_item_types` em
  `GET /modules` (só módulos ligados), com o rótulo declarado. Um item de
  módulo desligado mantém o seu tipo ao ser editado. Campos extras do item
  (`service_id`, …) não têm editor genérico: ofereça-os na tela do módulo.

## 6. Aplicativos e integrações

- `GET /api/v1/capabilities` lista, por área alcançada pela credencial
  (pessoa ou aparelho pareado), os módulos **ligados** com versão, e os
  recursos do núcleo em `features` (`modules`, `web_steps`, `establishment`, `queue_coupon`, `module_grants`, `person_access`). O app só mostra a
  tela de um módulo presente na lista; um 409 `module_disabled` numa rota do
  módulo deve esconder a tela até a próxima consulta.
- Caminhos aceitos, todos com a mesma resposta:
  `GET /api/v1/profiles/{p}/capabilities` (também traz `modules` no topo, com
  os módulos ligados daquela área), `GET /api/v1/capabilities?profile={p}` e
  `GET /api/v1/capabilities?profile_id={p}`. A área fora do alcance da
  credencial responde `404`.

  ```json
  {
    "capabilities_version": 1,
    "server": { "service": "wabotia", "version": "0.19.3", "commit": "…" },
    "features": ["modules", "web_steps", "establishment", "queue_coupon", "module_grants", "person_access"],
    "actor": { "id": "app:…", "kind": "app", "role": "service" },
    "profiles": [{ "id": "…", "name": "…", "enabled": true,
                   "modules": [{ "id": "queue", "name": "Fila presencial", "version": "1.0.0" }] }],
    "modules": [{ "id": "queue", "name": "Fila presencial", "version": "1.0.0" }]
  }
  ```

  (`modules` no topo só existe no caminho por área.) O id da fila é `queue`;
  o dos formulários, `forms`.
- **O que a pessoa logada acessa** (recursos `person_access` e
  `module_grants` em `features`): cada item de `profiles` traz `access` e
  `grants`. O contrato completo para os apps está em
  [API.md](API.md#acesso-por-pessoa).

  ```json
  "profiles": [{ "id": "…", "name": "…", "enabled": true,
                 "modules": [{ "id": "os", "name": "Ordem de Serviço", "version": "1.0.0" }],
                 "access": ["os", "os:technician"],
                 "grants": ["os:technician"] }]
  ```
- O evento `module.changed` (`{module_id, enabled, version}`) avisa quando um
  administrador liga ou desliga; aplicações da área o recebem em
  `GET /events` independentemente das permissões.
- Ferramentas MCP do núcleo para bots: `list_forms`, `send_form` e
  `list_web_steps`. Um módulo que quiser ferramentas próprias combina com a
  sessão A (o MCP mora em `src/mcp.ts`).

## 7. Testes

Use `tests/service-center-fixture.ts` (`fixture`, `receive`, `drain`,
`configure`, `bearer`, `application`, `api`). Para o passo web, grave a origem
pública antes (`INSERT INTO instance_settings … 'public_origin'`) e abra o
link com `SELF.fetch("https://test/api/w/<código>")`, como em
`tests/web-steps.test.ts`. Cubra pelo menos: módulo desligado (rotas `409`,
menu sem o item), o comando com repetição da mesma `Idempotency-Key` e o
ciclo do passo web do módulo.

## Fila presencial (módulo `queue`)

Primeiro módulo da lista, registrado sem mover código: as regras continuam
em `docs/FILA-SENHAS.md`. Desligada, as rotas `/queue`, os comandos
`queue.*`/`counter.*`, o painel de TV (`/api/public/queue-display/*`) e o
acompanhamento público (`/api/public/queue/*`) respondem `409 module_disabled`;
SENHA, SAIR, o cupom do totem e a porta de entrada deixam de responder no
WhatsApp; o item "Entrar na fila de espera" some do menu. Instalações
anteriores aos módulos continuam com a fila ligada (migração `0020`).

## Motor de trabalhos dentro de `os`

O [contrato do motor](areas/CONTRATO-MOTOR.md) e a
[entrega F0](areas/F0-ENTREGA.md) definem a integração em curso. Tipos de
trabalho são configuração do módulo existente, não módulos por profissão.
O uso administrativo está em [TRABALHOS.md](TRABALHOS.md); o embutido conserva
[ORDEM-DE-SERVICO.md](ORDEM-DE-SERVICO.md). As rotas e esquemas das seções 5 e 7
estão documentados em [API.md](API.md#motor-de-trabalhos) e no OpenAPI, sem
implicar que todos os descritores paralelos já estejam registrados.

### Configuração e referências de menu

`service_orders` continua parcial, mesclado com seus padrões. `service_order`
é virtual e não entra em `os_work_types`. Tipos personalizados guardam revisão,
campos, etapas, transições, recursos e vocabulário; cada ordem fixa sua definição
na abertura. `os_vocabulary` define os nomes da coleção e do cliente. Editar
essas chaves exige `settings_revision`, obtida em `/status`, no catálogo de
tipos ou no retorno de `PUT /settings`; divergência retorna `settings_conflict`.
A revisão é SHA-256 do JSON canônico salvo, incluindo menus ocultos;
`menus_revision` não muda.

`onSettingsSave` valida o valor isolado. `onSettingsChange` compara a configuração
anterior com a final e recebe `changed_keys` e o estado final de `modules`;
é puro e recusa por erro. M registra ambos para validar revisão, arquivamento,
IDs aposentados, referências e preservação de sigilo. Nenhuma gravação parcial.

Os menus `os_open` e `os_track` usam:

```ts
reference: {
  field: "type_id",
  setting: "os_work_types",
  label: "Tipo de trabalho",
  default_id: "service_order",
  builtins: [{ id: "service_order", label: "Ordem de serviço" }],
}
```

O menu antigo sem `type_id` continua válido. Abertura de tipo arquivado é
recusada; acompanhamento continua permitido. Identifique o menu pelo par
`(type, type_id)`. Campos sensíveis não entram em formulários web comuns;
um passo de abertura fixa a definição e os termos efetivamente apresentados.

### Interfaces das extensões internas

Tarefas, pessoas, documentos e lançamentos exportam descritores `OsExtension`.
Somente o integrador acrescenta imports e entradas nos blocos reservados de
`extensions.ts`, `runtime.ts`, `registry.ts` e `definition.ts`. Os filhos não
registram rotas ou agendadores por efeito de importação.

- `authorizedOrder(ctx, actor, id, {write?, conversation_id?})` verifica área,
  escopo, módulo e titular. Retorna linha interna e tipo; não serialize a linha.
- `resolveWorkType(ctx, typeId?, snapshot?)` resolve ausência como embutido.
  Use a cópia da ordem para operações sobre trabalhos existentes.
- `projectOrderForStaff/Customer/Bot` e `projectChildForStaff/Customer/Bot`
  produzem DTOs autorizados; `null` no filho significa omitir o registro,
  inclusive das contagens. Projete um DTO, não uma linha SQL.
- `commitChild` recebe identidade, versão esperada, chave de mutação, nomes de
  campos, SQL e código de evento. Confirma alteração e histórico no mesmo lote,
  atualiza atividade do pai sem incrementar sua versão lógica e recupera
  publicação idempotente. Não grave esses efeitos separadamente.
- `runDue` compartilha orçamento de 200 instruções e dez itens por rodada,
  reduzido pelas extensões anteriores. Consuma orçamento antes do SQL e inclua
  os serviços chamados. Restante retorna `has_more`; não marque aviso antes de
  incluí-lo duravelmente na fila. Há um agregador de `os`, com gancho legado
  primeiro e uma só vez; não chamar `onSchedule("os")` em cada extensão.

As rotas filhas recebem todos os parâmetros de caminho; eles vencem o corpo,
e `profile` é removido do corpo. Em conversa, `id` identifica a conversa e
`order_id` identifica a ordem. Consultas incluem área e pai. Rotas estáticas
precedem parâmetros. Toda rota de cliente deve entrar na lista explícita de
permissões de credenciais de conversa; telefone arbitrário não autoriza.

### Documentos, privacidade e modelos administrativos

Documentos usam `binaryReads` e `binaryUploads` do descritor. O download
confere autorização antes de abrir R2 e o núcleo força `no-store`. Upload
valida chave idempotente e versão, autoriza e fornece `content()` (até 10 MiB,
com SHA-256) e `command()` para as operações declaradas. Não use `ctx.run`
nesse transporte Worker. Reserva, tentativa e confirmação continuam comandos;
bytes não entram em recibos ou auditoria.

`ctx.inboundAttachments` resolve somente anexos da mensagem recebida na
conversa/área autorizada. `ctx.outgoingAttachment` produz mídia compartilhável
apenas de documento público e não sensível, após autorização de mensagem.
Documentos privados não usam o endpoint comum de mídia.

Sensibilidade exige pessoa humana com papel explícito `os:sensitive` e sem
`via`, independentemente da máscara. Administrador não substitui o papel.
Bots, aplicações e conectores são bloqueados. Rotas privadas ficam em
`bot.deny` e fora do catálogo; o manipulador também confere. Valores sensíveis
não entram em mensagens, eventos, histórico, busca ou descrições de propostas.
A F0 reserva a exposição do papel para M/I e ainda devolve `501 not_implemented`
nas interfaces que dependem de M; não trate a fundação como motor concluído.

Modelos de área exportam `AdminExtension` com `id: "area-templates"`, caminhos
`area-templates` e operações `area-template.*`. Exigem administrador e funcionam
com `os` desligado. `planSettings` planeja e valida o estado final, incluindo
módulos; `commitSettingsPlan` confirma configuração, módulos e procedência no
mesmo lote. A prévia usa o mesmo plano e o hash inclui revisões e procedência.
Não aplicar `module.set` seguido de `settings` como duas operações independentes.
Manifestos usam menu `message`, convertido para `content` na compilação.
Sugestões em `os_area_setup` não concedem permissões automaticamente.

A suíte antiga continua sem mudança de expectativas. O teste
`tests/os-openapi-contract.test.ts` cobre o contrato publicado, não comprova
implementação das rotas, privacidade em execução nem orçamento D1. Essas
verificações pertencem aos testes das extensões e da integração.
