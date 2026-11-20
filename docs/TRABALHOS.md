# Trabalhos: guia do administrador

O motor de trabalhos generaliza o módulo **Ordem de Serviço (`os`)**. Uma
área pode organizar processos, projetos ou serviços com tipos próprios, mantendo
as ordens de serviço existentes e acessando a operação pelo botão ERP.

Na interface, um tipo de trabalho é chamado **modelo de ordem de serviço**.
Os nomes internos (`work type`, `os_work_types` e `type_id`) permanecem iguais.
As referências normativas do motor são
[CONTRATO-MOTOR.md](areas/CONTRATO-MOTOR.md) e
[F0-ENTREGA.md](areas/F0-ENTREGA.md). A API e os esquemas estão em
[API.md](API.md#motor-de-trabalhos) e `/api/openapi.json`.

## Começar pela área

Ligue **Gestão → Módulos → Ordem de Serviço**. No botão **ERP**, o módulo tem
duas entradas: **Ordens de serviço** e **Configurar** (administradores).
`os_vocabulary.collection_label` pode substituir o nome da coleção; sem ele,
o padrão continua **Ordens de serviço**, inclusive com modelos personalizados.
O menu lateral não repete esse nome como título do grupo.
`customer_singular` e `customer_plural` definem o vocabulário do cliente.

A lista em `/app/erp/modulos/trabalhos` reúne todos os modelos ativos,
incluindo a ordem clássica (`service_order`). O filtro **Modelo** começa em
**Todos os modelos**. Busca, situação, responsável e intervalo de prazo ficam
na URL; ao escolher um modelo, também é possível filtrar pelas etapas dele.
O endereço `/trabalhos/<tipo>` pré-seleciona o modelo. **Nova ordem** abre o
formulário quando há um só modelo ativo; com vários, pede o modelo primeiro.
**Meus prazos** fica no topo da lista e conserva sua página própria. A clássica
mantém o detalhe em diálogo; os personalizados mantêm a página de detalhe.

**Configurar** reúne as abas **Modelos**, **WhatsApp** e **Prazos e garantia**.
Em Modelos, **Criar modelo** oferece **Começar do zero** ou **Começar de um
exemplo**, com busca e exemplos agrupados pelo modelo de área. Escolher um
exemplo abre um rascunho para revisão, sem aplicar módulos, menus ou o modelo
de área inteiro. IDs são gerados pelos rótulos e ficam em **Avançado**.
WhatsApp reúne Abrir/Acompanhar de todos os modelos e as mensagens da clássica.
Prazos e garantia reúne a configuração clássica e atalhos para **Recursos**
dos personalizados.

Os endereços anteriores `/tipos-de-trabalho`, `/ordem-de-servico`,
`/meus-prazos` e `/app/gestao/...` continuam funcionando. A demonstração
`/app?demo=1` inclui a lista, as abas e ordens clássicas e de oficina.

Um tipo define nomes singular/plural, rótulos de Item e Problema, termos,
prefixo de numeração, campos, etapas, transições, mensagens e recursos ligados.
Os valores de `item` e `problem` continuam sendo textos obrigatórios, mesmo
quando apresentados como Projeto e Objetivo. Não guarde conteúdo sensível
nesses dois campos.

## Criar, revisar e arquivar modelos

Os tipos personalizados ficam em `os_work_types` nas configurações da área.
O tipo embutido `service_order` é virtual: não o inclua nessa lista e continue
configurando seus termos, mensagens e prazos em `service_orders`, pelas abas
WhatsApp e Prazos e garantia de Configurar.

1. Leia o catálogo em `GET /profiles/{profile}/service-orders/types` e guarde
   `settings_revision`. A revisão também aparece em `/status`.
2. Monte o tipo com `schema_version: 1`, `kind: "custom"`, ID estável e
   `revision: 1`. Configure rótulos, campos, etapas, transições e recursos.
3. Salve a lista completa em `PUT /profiles/{profile}/settings`, com
   `settings_revision`. Alterar `os_work_types` ou `os_vocabulary` exige essa
   revisão; configuração divergente retorna `409 settings_conflict`.
4. Ao mudar conteúdo do tipo, incremente `revision` em uma unidade. Reenvio
   idêntico conserva a revisão. Em conflito, releia e revise suas mudanças.
5. Para parar novas aberturas, use `archived: true`. Não remova um tipo salvo.

Cada trabalho guarda a definição usada na abertura. Editar o cadastro do tipo
não muda campos, etapas ou regras dos trabalhos anteriores. Arquivar o tipo
impede novas aberturas, mas preserva acompanhamento e operação dos existentes.
Não há conversão automática de ordens para outra revisão.

IDs usam letras minúsculas, números e `_`, começando por letra. O ID do tipo
vai até 64 caracteres; campos, etapas, opções e transições até 32. Ao remover
um campo ou etapa, acrescente o ID em `retired_field_ids` ou
`retired_stage_ids`; ele não pode ser reutilizado. `service_order` é reservado.

Limites por área/tipo:

| Item | Limite |
|---|---:|
| Tipos, incluindo arquivados | 20 por área |
| Campos / etapas / transições | 24 / 32 / 128 por tipo |
| Opções de escolha | 32 por campo |
| Definição / cópia na ordem | 12 / 16 KiB UTF-8 |
| Valores extras | 16 KiB UTF-8 |
| Nome ou rótulo / ajuda / prefixo | 80 / 240 / 12 caracteres |
| Mensagem / termos / texto extra | 900 / 1400 / 2000 caracteres |

Textos contam pontos de código Unicode depois de aparar espaços externos.
A configuração inteira também respeita o limite do núcleo de 150.000 unidades
de comprimento do JSON; esse limite não equivale a 150 KB UTF-8. A gravação é
recusada inteira se qualquer definição, menu ou dependência for inválida.

## Etapas e aprovações

Cada etapa tem ID, rótulo e um estado de base. Os estados continuam sendo
`received`, `analyzing`, `quoted`, `approved`, `declined`, `in_progress`,
`ready`, `delivered` e `cancelled`. A etapa inicial usa `received`.
Todas devem ser alcançáveis; etapas abertas precisam de caminho para conclusão
e cancelamento. `delivered` e `cancelled` são terminais.

Por exemplo, Revisão e Execução podem usar ambas `in_progress`. O aplicativo
antigo continua mostrando **Em execução**; a interface atualizada distingue
as etapas. Selecione uma transição pelo `transition_id`, com a `version` da
ordem. Não envie o nome da etapa em `status` nem em `next_statuses`.

No personalizado, `/status` também admite voltar a `received`, desde que haja
uma única transição manual elegível e ela altere o estado de base. Isso não
acrescenta destinos ao embutido, que conserva as operações antigas.

Uma transição pode ser manual ou exigir aprovação do cliente. A segunda cria
pedido com validade de 1 a 720 horas. Aprovar executa a transição registrada;
recusar mantém a etapa de origem. Alterar campos, orçamento ou etapa cancela
um pedido pendente. A decisão exige as versões atuais da ordem e da aprovação;
botão antigo ou vencido não autoriza conteúdo alterado.

Aprovação de etapa é separada da aprovação de orçamento. Não é assinatura de
documento. Os estados `quoted`, `approved` e `declined` são exclusivos do fluxo
de orçamento nesta fase; só os use com `features.quote` configurado. Essa
política identifica as etapas de envio, aprovação, recusa e retorno para análise
quando o orçamento enviado é editado. As rotas de orçamento continuam próprias.

## Campos e privacidade

Os campos extras podem ser texto, inteiro, decimal, booleano, data civil ou
escolha. Inteiros devem ser seguros; decimais respeitam mínimo, máximo e escala
de 0 a 6, sem arredondamento silencioso. Datas usam `YYYY-MM-DD` e precisam
existir. Escolhas recebem o ID da opção, não o rótulo. Ausência, `null`, vazio,
zero e `false` são valores distintos; zero e `false` podem cumprir um campo
obrigatório.

Cada campo declara `required`, `client_visible` e `sensitive`. Campo sensível
exige `client_visible: false` e `required: false`. Depois de classificado como
sensível, não pode perder essa classificação, nem por remoção e recriação.
Se o cliente puder abrir trabalhos, todos os campos obrigatórios devem ser
visíveis a ele e não sensíveis.

Campos sensíveis são lidos e escritos somente em `/private-fields`, por pessoa
autenticada com papel explícito `os:sensitive` e sem atuação por bot (`via`).
Administrador também precisa desse papel. Aplicações, conectores e bots não
recebem esses dados. A escrita privada devolve nomes dos campos alterados,
sem valores. Busca, mensagens, eventos e histórico novos não expõem valores
sensíveis; os campos comuns respeitam também os escopos de contato e notas.

### Parte comercial dos modelos (OS3)

O orçamento, as condições, a cobrança e o recebimento funcionam igual em todo
modelo com `features.quote` (veja [ORDEM-DE-SERVICO.md](ORDEM-DE-SERVICO.md#orçamento)).
O documento comercial no ERP leva os itens do orçamento como escritos e o
objeto do serviço só com campos visíveis ao cliente; `sensitive: true` nunca
sai da ordem. Modelos aplicados de áreas sensíveis por natureza
(`area_clinica_medica__…`, `area_escolas__…`, `area_professores__…`,
`area_advogados__…`, `area_escritorio_advocacia__…`) e qualquer modelo de uma
área que aplicou um deles continuam reservados: "Serviço contratado", sem
dados técnicos e com pagador adulto confirmado por uma pessoa. A cópia de um
exemplo feita em *Começar de um exemplo* recebe ID novo e não é reconhecida
como área sensível: marque os campos sensíveis no próprio modelo.

Voltar etapa (Pronta → Em execução; Orçamento enviado, Aprovada ou Recusada
→ Em análise) e cancelar pedem motivo na tela antes de enviar (`note` em
`/stage`), como o servidor exige quando há parte comercial.

## Objeto do serviço

O objeto do serviço é aquilo em que o serviço é feito: veículo, equipamento,
imóvel, animal ou evento. Pertence a um contato do cadastro compartilhado da
área, existe fora da ordem e reúne o histórico das ordens. A oficina registra
placa, marca e modelo, cor e tipo de combustível uma vez; a quilometragem é
informada em cada visita. Modelo sem objeto continua exatamente como antes.

**Tipos de objeto.** Ficam em `settings.os_object_types` e são salvos pelo
mesmo `PUT /profiles/{profile}/settings`, junto de `os_work_types` e
`settings_revision`, na mesma operação e com a mesma proteção de administrador.
Cada tipo tem `schema_version: 1`, ID, `revision`, `archived`, rótulos singular
e plural, `identifier_field_id`, `fields` e `retired_field_ids`. Os campos usam
os mesmos seis tipos, limites e regras de privacidade dos campos da ordem.
IDs e revisões seguem a disciplina dos modelos: arquivar em vez de remover,
aposentar IDs retirados, não reutilizá-los, não retirar a classificação
sensível. Mudar o significado ou o tipo de um campo exige outro ID.

O identificador aponta para um campo de texto de uma linha, não sensível, com
até 120 caracteres. Pode ser opcional: sem valor, ou quando não é visível ao
cliente, aparece a forma genérica, por exemplo “Veículo · 7D2A91”. Placa,
número de série, endereço ou nome **não** são únicos, nem chave de acesso, nem
prova de propriedade: o sistema não deduplica por eles.

**Modelo com objeto.** `object_type_id` liga o modelo a um tipo de objeto.
`fields` do modelo continua contendo somente campos **desta ordem**; os campos
do objeto pertencem ao tipo. Em Configurar → Modelos, o editor apresenta os
dois numa lista, com “Do objeto” ou “Desta ordem”; `order:placa` e
`object:placa` são campos diferentes. Trocar a localização aposenta o campo na
origem e cria ou referencia o destino, sem mover valores antigos. Vários
modelos podem compartilhar o mesmo tipo; a tela mostra os modelos afetados.
A ordem clássica (`service_order`) não aceita objeto: para usar objeto,
duplique-a como modelo personalizado.

**Cópia na ordem.** A abertura guarda em `object_snapshot_json` a definição e
os valores do objeto naquele momento (`origin: "opening"`, versão e data).
`extra_json` continua com o que é daquele atendimento, como a quilometragem.
Editar o cadastro atual não muda as ordens anteriores; editar a ordem não muda
sua cópia, e o vínculo original não pode ser trocado pela edição comum. Uma
revisão nova do tipo vale para objetos novos; a ficha existente adota a
revisão só por pedido explícito (`adopt_revision`, com prévia).

**Abrir.** Para modelo com objeto, `POST .../service-orders` exige exatamente
uma alternativa em `object`: `{mode: "existing", id, version}` ou
`{mode: "new", type_id, values}`. Para modelo sem objeto, enviar `object` é
erro `400`. O contato canônico é obrigatório e revalidado no servidor (não
confie no contato vindo da URL). Objeto novo, ordem, contadores, índices,
históricos e recibo entram no **mesmo lote D1**: uma falha não deixa objeto
órfão nem consome número. Selecionar um objeto existente confere a versão
observada dentro do lote; se ele mudou ou foi arquivado, a resposta é
`409 version_conflict` ou `409 object_archived`, sem capturar outra versão.

**Repetição.** As escritas novas usam `Idempotency-Key`. O recibo
(`os2_receipts`) guarda área, ator efetivo, operação, chave e o hash do pedido
normalizado. Mesma chave e mesmo conteúdo devolvem o resultado anterior depois
de reautorizar o acesso, sem nova entidade, versão ou evento; conteúdo
diferente devolve `409 idempotency_conflict`. Recibo nunca é autorização.
Uma recusa (por exemplo, `409 version_conflict` quando o lote falha) também
fica registrada no recibo de comando do Coordinator: repetir a mesma chave
devolve a mesma recusa, sem efeito. Para tentar de novo, envie uma chave nova
com a versão atual.

**Arquivar.** Não há exclusão de objeto. Arquivar impede novas seleções e
preserva histórico, cópias e ordens em andamento; desarquivar respeita os
limites.

**Privacidade.** Objeto é dado do cliente: só aparece para quem pode ver o
contato (acesso a OS sozinho não basta). Campos sensíveis do objeto ficam em
`/objects/{object_id}/private-fields`, para pessoa com `os:sensitive`, sem bot,
aplicação, credencial ou atuação `via`, e fora do catálogo de ações dos bots
(`bot.deny` do módulo, como os `/private-fields` da ordem). Leitura comum, histórico, busca,
eventos e exportações nunca levam valores sensíveis. Na conversa, o cliente só
alcança os próprios objetos, pelo titular confirmado da conversa; `contact_id`
ou telefone no corpo não são prova. Os bots seguem a configuração do
administrador em `os2_ai_access` (`enabled`, `internal`, `sensitive`), desligada
por padrão: nenhum dado fica fora da IA por construção, mas nada é liberado sem
essa opção. O que chega pelo WhatsApp só alcança o que o cliente alcança.

**WhatsApp.** O formulário de abertura de um modelo com objeto resolve o
titular antes de buscar objetos e pergunta “Qual veículo?” (ou o rótulo do
tipo), com até 30 objetos ativos e “Informar outro”. Os campos do bloco
“Informar outro” são públicos, não sensíveis e opcionais no HTML; o servidor
aplica a obrigatoriedade do tipo. Escolher um existente e preencher o bloco é
erro. O link só é consumido depois de a ordem ser gravada: se algo falhar entre
a gravação e a conclusão do passo, reenviar recupera o recibo `web_step:<id>` e
conclui a mesma abertura, sem duplicar. Titular não confirmado recebe orientação
para falar com a equipe. A ferramenta `os_objetos` do bot consulta os objetos do
titular da conversa; `os_situacao` mostra a identificação da cópia de cada
ordem. Mensagens aceitam `{objeto}` (identificador público da cópia; vazio sem
objeto). Não há inventário de objetos a cada mensagem.

**Ordens antigas.** Nada é convertido automaticamente. Numa ordem personalizada
sem vínculo, **Vincular** (`POST .../service-orders/{id}/object-link`, com a
versão da ordem) cria ou associa um objeto do mesmo contato, de forma atômica e
idempotente, inclusive em ordem encerrada. `preview: true` mostra os campos
comuns compatíveis; quilometragem, combustível na entrada, última manutenção e
qualquer campo privado não são candidatos. A cópia recebe
`origin: "legacy_link"` e aparece como “Vinculado posteriormente”. Uma placa
sensível antiga continua protegida nas ordens antigas; a placa pública precisa
ser informada no cadastro novo. Vínculo existente só aceita a repetição do
mesmo comando.

## Obrigatoriedade por etapa, colunas e filtros

`required` continua significando obrigatório na abertura. Em
`stage_field_rules`, `required_from_stage` exige o campo ao entrar naquela
etapa e `required_on_exit` ao sair de uma das etapas listadas. Uma vez ativada,
a exigência fica registrada na ordem (`stage_required_json`) e vale também em
retornos e caminhos alternativos; o campo ativado não pode ser apagado por
`PATCH`. Valem só para campos desta ordem e não sensíveis. Cancelar continua
possível sem completar o formulário.

A verificação acontece no servidor antes de gravar, em **todas** as mudanças de
etapa: `/stage`, `/status` dos aplicativos, envio, edição e decisão de
orçamento, pedido e decisão de aprovação de etapa, WhatsApp, bot e integrações.
A recusa é `409 missing_fields`, com os rótulos que o leitor pode conhecer; ao
cliente, uma pendência interna aparece como “A equipe precisa completar os
dados desta etapa.” `GET .../service-orders/{id}/requirements?transition_id=`
devolve os campos exigidos e faltantes. Salvar dados parciais de uma ordem já
aberta, sem avançar, é o rascunho desta versão. Na oficina, a quilometragem é
exigida ao sair de Recebido e o serviço executado ao entrar em Reparo concluído.
Checklist automático por etapa fica para a parte 3.

`list_fields` marca até quatro campos (do objeto ou da ordem) como coluna e/ou
filtro. Colunas vêm da linha e da cópia já carregadas, sem consulta extra. Um
filtro próprio por consulta (`field_filter`, JSON): igualdade para texto
normalizado de uma linha (até 240 caracteres), escolha e booleano; igualdade ou
intervalo fechado para número e data. Campo sensível nunca é coluna nem filtro.
O filtro do objeto usa a **cópia da ordem**, nunca o cadastro atual.

Os filtros usam um índice próprio. Uma configuração nova começa em construção:
o administrador inicia e acompanha em `GET/POST .../types/{type_id}/field-index`
e `.../field-index/rebuild`, cada comando processando até cinco ordens a partir
do cursor salvo; repetir ou falhar retoma do mesmo ponto. Enquanto isso, o
filtro responde `409 field_index_building` e a lista comum continua normal.
Com filtro próprio, cada página examina até 200 candidatos e devolve até 50,
com `counts: null`, `counts_scope: "not_computed"` e cursor selado para o mesmo
contexto; igualdade ordena por número decrescente e intervalo pelo valor
crescente. Consumidores antigos, sem `field_filter`, recebem o contrato
anterior.

| Item | Limite |
|---|---:|
| Tipos de objeto por área, incluindo arquivados | 20 |
| Campos por tipo de objeto | 24 |
| Definição do tipo / valores do objeto | 8 / 16 KiB UTF-8 |
| Cópia do objeto na ordem | 32 KiB UTF-8 |
| Campos do objeto + desta ordem num modelo com objeto | 24 |
| Objetos por contato, incluindo arquivados / ativos por contato e tipo | 100 / 30 |
| Campos filtráveis por modelo / colunas próprias / filtros por consulta | 4 / 4 / 1 |
| Página de objetos, histórico ou lista filtrada | 50 |
| Candidatos por página filtrada / ordens por comando de reconstrução | 200 / 5 |

Rotas novas, sob `/profiles/{profile}/service-orders` e descritas no OpenAPI
com nome de operação estável (`os.objects.*`, `os.object.link`,
`os.requirements`, `os.field_index.*`, `os.conversation.objects.*`):
`object-types`, `objects` (lista por `contact_id`, cadastro), `objects/{id}`
(ficha com último atendimento e histórico; alteração), `objects/{id}/archive`,
`objects/{id}/private-fields`, `objects/{id}/orders`, `{id}/object-link`,
`{id}/requirements`, `types/{type_id}/field-index` e `.../rebuild`,
`conversation/{id}/objects` e `conversation/{id}/objects/{object_id}`.
A ficha do contato ganha a coleção **Objetos do cliente**. O “último
atendimento” é a última ordem com `status=delivered`, por `delivered_at`; data
ausente em registro antigo aparece como indisponível.

**Custo no D1.** Mensagem comum do WhatsApp e operações de modelo sem objeto
não leem nem gravam as tabelas novas (`os_objects`, `os_object_history`,
`os2_receipts`, `os_field_index_state`, `os_order_field_index`). A prova está em
`tests/os2-budget.test.ts`: o mesmo cenário roda com as portas neutralizadas e
com as de produção, no Worker e em cada Coordinator, e exige as mesmas
instruções e gravações; a medição fica em `task.meta.os2Budget` do relatório
JSON do Vitest. A lista com colunas próprias não acrescenta consulta por linha;
a ficha do objeto faz leituras fixas (ficha, última conclusão, uma página de
histórico); a consulta filtrada lê no máximo 1.000 linhas de dados sobre 5.000
ordens, pelos índices tipados.

**Versões.** Migrações `0150_os_service_objects.sql` e
`0151_os_stage_fields_and_indexes.sql` (aditivas, sem migração de dados).
Contratos `schema_version: 1` para tipo de objeto e cópia; envelope do
formulário de abertura versão 2 só para modelo com objeto. Modelos de área
atualizados: Oficina mecânica 3, Assistência técnica 4, Clínica veterinária 2,
Engenharia 3, Arquitetura 2, Construtora 2 e o novo Festas e eventos 1.

## Tarefas e prazos

Ligue `features.tasks` no tipo para usar tarefas com título, descrição,
responsável, destinatário (`staff` ou `customer`), prazo e aviso. Os instantes
são milissegundos Unix. `remind_at` exige `due_at` e não pode vir depois dele.
Os estados são `open`, `done` e `cancelled`.

Tarefa destinada ao cliente precisa ser visível e não sensível. Uma alteração
usa a versão da própria tarefa, sem exigir versão do trabalho. Concluir,
cancelar ou reprogramar deve considerar o estado atual do aviso; uma repetição
do comando não duplica a notificação. Arquivar retira da lista corrente e
preserva o histórico. Há até 500 tarefas por trabalho, incluindo arquivadas.
Tarefas guardam instantes e avisos; não calculam dias úteis forenses.

Para tarefas sensíveis, crie em `POST /service-orders/{id}/private-tasks`,
edite em `PATCH …/private-tasks/{task_id}` e arquive em
`POST …/private-tasks/{task_id}/archive`. Essas operações exigem pessoa com
`os:sensitive` explícito e sem `via`, ficam fora do catálogo de IA e usam
`audience: staff`, `client_visible: false` para conteúdo sensível. As escritas
comuns recusam esse conteúdo mesmo quando a pessoa tem o papel. A leitura
autorizada continua em `GET …/tasks`; não existe lista `private-tasks`.

`GET /service-orders/my-tasks` lista tarefas da própria pessoa, com
`assignee=me`, estado (padrão `open`), `type_id` e período (`dated`, `overdue`,
`today`, `next7`, `range`, `undated`). Sem período, lista tarefas com prazo.
`range` exige datas civis `due_from` e `due_to`, inclusivas em Brasília.
Retorna também tipo, número exibido e rótulo da etapa do pai; usa cursor,
limite padrão 50 e máximo 100. Bots e aplicações não podem usar essa consulta.

## Pessoas ligadas

Com `features.people`, cadastre papel, nome e, opcionalmente, contato da área,
telefone, e-mail e nota. Exemplos de papel: contratante, tutor ou responsável.
O contato deve pertencer à mesma área. Telefone e nota só aparecem a quem tem
os escopos correspondentes; registros sensíveis respeitam a barreira própria.

Vincular alguém **não concede acesso** ao trabalho. O titular continua sendo o
cliente da ordem. Use a versão da pessoa para editar ou arquivar. Limite de
200 pessoas por trabalho, incluindo arquivadas.

## Documentos

Com `features.documents`, reserve o documento informando nome, tipo MIME,
tamanho esperado, visibilidade e sensibilidade. O fluxo da API é:

1. `POST /service-orders/{id}/documents`: cria metadados `pending`, devolve
   `upload_url`, `version` e vencimento em 24 horas.
2. `PUT …/documents/{document_id}/content`: envia bytes com `Idempotency-Key`
   e `Upload-Version`. Máximo 10 MiB; o servidor confere bytes e calcula SHA-256.
   Uma tentativa ativa tem exclusividade por cinco minutos.
3. `POST …/documents/{document_id}/complete`: confirma `version` e
   `upload_attempt`. Só após conferir objeto, tamanho e hash o documento fica
   `ready`. Use a versão devolvida pela etapa anterior.
4. Baixe por `GET …/documents/{document_id}/content`, autenticado e com
   `Cache-Control: no-store`. Pendentes não podem ser baixados.

Esse fluxo comum exige `sensitive: false`. Para conteúdo sensível, substitua
`documents` por `private-documents` em **todas** as etapas, inclusive listagem,
download e `POST …/private-documents/{document_id}/archive`. A reserva privada
exige `sensitive: true` e `client_visible: false`. Todas essas rotas exigem
pessoa com `os:sensitive` explícito e sem `via`, e ficam fora do catálogo de IA.
Baixar conteúdo sensível por `documents` retorna `404 not_found`, mesmo com o
papel. Não existe envio privado ao cliente. O download conserva o MIME
cadastrado; os tipos permitidos estão em [API.md](API.md).

Repetir a mesma chave recupera a tentativa concluída; não sobrescreve arquivo
confirmado. Enviar ao WhatsApp exige documento pronto, `client_visible: true`,
`sensitive: false` e permissão para mensagem. Um documento sensível entra pelo
painel autenticado, não pelo canal comum de anexos.

O cliente pode enviar `DOCUMENTO <numero_global>` e o anexo na mesma mensagem.
Sem identificação inequívoca, deve identificar a ordem; não se escolhe a mais
recente. Não há vínculo por `media_id` arbitrário. Arquivar preserva o objeto;
eliminação definitiva fica fora desta fase. Limite de 500 documentos incluindo
arquivados. Classificar como sensível depois de enviar não recolhe cópias já
entregues.

## Lançamentos

Com `features.entries`, registre tipo (`kind`), texto, data e, opcionalmente,
quantidade e unidade. `quantity_milli: 1500` significa 1,5 unidade; o intervalo
é de 0 a 1.000.000.000.000 milésimos. A data é um instante Unix em milissegundos.

Texto, quantidade e data não são editados. Para corrigir, envie a versão do
anterior e os campos completos a `/entries/{entry_id}/revisions`: o servidor
cria outro lançamento com `replaces_id` e arquiva o anterior atomicamente.
Uma correção concorrente retorna conflito. Há até 10.000 lançamentos por
trabalho, incluindo arquivados. Horas, medições e diários aqui não geram
movimentos financeiros automaticamente no ERP.

`GET …/entries/summary` resume os lançamentos autorizados por `kind` e `unit`.
Aceita `kind` e `include_archived`, sem paginação. Cada grupo traz `count` e
`quantity_milli` como texto decimal exato, ou `null` quando não há quantidade;
a soma pode ultrapassar a precisão segura de um número JavaScript.

## Menus, mensagens e numeração

Os menus `os_open` e `os_track` recebem `type_id`. Sem ele, continuam usando
`service_order`. Menus de abertura para tipo arquivado não podem ser salvos
ativos; o acompanhamento pode continuar. Dois menus do mesmo tipo são distintos
pelo par `(type, type_id)`.

O formulário de abertura mostra Item e Problema com os rótulos escolhidos,
campos públicos e aceite. Fixa a definição e os termos apresentados naquele
passo. Se o tipo for arquivado antes da conclusão, a nova abertura é recusada.
Não inclua campos sensíveis em passos web comuns.

O `number` é global da área e continua sendo usado por aplicativos antigos,
cursor e comandos como `APROVAR 42`. `type_number` é a sequência do tipo;
`display_number` apresenta prefixo e número. Ambos os números são inteiros
positivos até 2.147.483.647. Nunca substitua `number` por um texto como `PROJ-7`.

Mensagens personalizadas aceitam `{tipo}`, `{etapa}`, `{numero_tipo}`,
`{identificador}` e `{campo_ID}` para campos públicos não sensíveis, além dos
marcadores antigos `{numero}`, `{item}`, `{estado}`, `{total}`, `{validade}`,
`{garantia}`, `{pronto}` e `{previsao}`. Marcador desconhecido é erro nos tipos
novos. Mensagem de etapa vazia não envia; no máximo uma mensagem de etapa por
entrada. O orçamento conserva suas próprias notificações.

Garantia aceita 0 a 3650 dias; retirada e paralisação, 0 a 365 nos tipos
personalizados. Zero desliga. Retirada exige etapa `ready`; garantia começa
em `delivered`. Trocar entre etapas do mesmo estado não reinicia essas datas.
O tipo embutido conserva seus padrões, textos e interpretação de mensagens.

## Modelos de área

Assistência técnica (Veículos) e Oficina mecânica usam o objeto **Veículo**:
**Placa** opcional, visível ao cliente, não sensível e limitada a 10
caracteres; **Marca e modelo**, **Ano** (inteiro de 1900 a 2100), **Cor** e o
novo **Tipo de combustível**. Ficam na ordem: Quilometragem, Combustível (nível
na entrada, com o mesmo ID e significado de antes), Última manutenção informada
pelo cliente, Peças previstas, Avarias na entrada e Serviço executado.
Eletrônicos e eletrodomésticos usam **Equipamento**; os três modelos da clínica
veterinária compartilham **Animal** (sem prontuário); Engenharia, Arquitetura e
Construtora usam **Imóvel** nos serviços ligados a imóvel. Imobiliária de
interessados, advocacia e consultoria continuam sem objeto. **Festas e eventos**
usa **Evento** (data, tema e local) e, em cada ordem, escopo, objetos extras,
decoração extra e serviço executado, exigido para concluir; não reserva itens
nem agenda.

O manifesto aceita `object_types` opcional: os tipos usados pelos modelos
selecionados entram na mesma prévia e aplicação, com IDs remapeados para a área
e compartilhados dentro do manifesto (manifestos diferentes não se fundem).
A exportação inclui os tipos referenciados. Manifestos antigos, sem
`object_types`, continuam aceitos.

Modelos já aplicados preservam suas edições. Quando o padrão só acrescenta
campos, a faixa **O modelo padrão ganhou campos** continua oferecendo os IDs
que faltam, sem alterar os existentes nem reutilizar IDs aposentados. Quando
há objeto, **O modelo padrão mudou: revisar e aplicar** mostra antes de gravar o tipo de
objeto criado ou usado, os campos que ficam na ordem, os que passam ao objeto,
os novos requisitos e colunas/filtros e os conflitos com personalizações.
Campos movidos são aposentados no modelo e criados no objeto, sem copiar
valores de ordens existentes nem alterar suas cópias; personalização de
significado ou validação exige resolução explícita. Isso vale apenas para
ordens abertas depois da alteração. A placa antiga sensível mantém sua
classificação e seus valores e nunca é copiada para o identificador público.
Os limites do modelo e as regras de validação continuam valendo.

O nome do modelo de área de origem distingue modelos com nomes iguais.
A prévia de aplicação avisa quando já há um modelo equivalente; não remove,
combina ou redireciona os modelos existentes.

A aplicação de modelo é administrativa e funciona mesmo com `os` desligado.
Um modelo é JSON declarativo; configura tipos, módulos, vocabulário, setores,
categorias, menus, textos e sugestões de bot. Não executa código.

1. Consulte `/profiles/{profile}/area-templates` e o manifesto desejado, ou
   importe um `manifest` de até 128 KiB UTF-8.
2. Envie `template_id` **ou** `manifest` a `/area-templates/preview`, junto
   de `selection`: tipos, módulos e opções de menus, setores, categorias,
   vocabulário, textos e sugestões de bot. A prévia não grava.
3. Revise `changes`, `conflicts`, `manual_steps` e `can_apply`. Ações `add`,
   `set`, `keep` e `skip` mostram inclusões, mudanças e preservações.
4. Envie a mesma origem e seleção, com `preview_hash` e `Idempotency-Key`, a
   `/area-templates/apply`. Se retornar `preview_stale`, refaça a prévia.
5. Confira os passos manuais. Sugestões ficam em `os_area_setup`; não concedem
   papéis às pessoas nem ampliam permissões de bots conectados.

A confirmação grava configuração, módulos e procedência no mesmo lote.
Dependências são conferidas no estado final; não há desligamento em cascata
silencioso. IDs globais recebem `area_<template_id>__<id_local>`; referências
são ajustadas, e `service_order` continua virtual. Colisão sem procedência
retorna conflito.

Reaplicar preserva conteúdo editado à mão, itens apagados e campos escalares
removidos depois da primeira aplicação. Uma versão posterior acrescenta só
IDs e caminhos ainda não tratados. Aplicação idêntica retorna `applied: false`.
Exporte com `/area-templates/export` e `{id, name, type_ids}`; o resultado é um
manifesto, sem dados pessoais de trabalhos ou segredos.

## Consultar e resolver conflitos

Listas de filhos e histórico usam cursor opaco e máximo de 100 itens. As listas
filhas têm padrão de 50; carregue cada aba sob demanda. Não reutilize cursor em
outra área, ordem, coleção ou filtro. O limite de cada coleção conta arquivados e pode retornar
`409 collection_limit`. Filhos não autorizados também não entram em contagens.

A lista principal mantém `counts` global e esparso nos nove estados, mesmo
com filtros. Use `facets=1` para contagens por tipo e, com `type_id`, por etapa.
O filtro aditivo `type_ids` aceita até 21 IDs separados por vírgulas e permite
listar os modelos ativos antes da paginação, usando o índice existente.
A tela unificada não pede facetas: `listOrders` faz **2 leituras D1** (contagem
global e página) ou **3** quando há ordens cujo modelo habilita tarefas na página
(uma leitura em lote das próximas tarefas autorizadas, mesmo se não houver
tarefas cadastradas). Essa contagem é medida no teste da consulta SQL e não
inclui autenticação nem a chamada separada ao catálogo de modelos. O custo
independe da quantidade de modelos na página. Não há nova leitura por mensagem
do WhatsApp.
`open=1` seleciona abertas; omitir `open` ou usar `open=0` inclui todas.
`stage` exige `type_id` e sempre significa um ID literal, inclusive `open` ou
`all`; esses nomes não são filtros especiais nesse parâmetro. No detalhe,
`history=none` evita carregar o histórico
legado; consulte `/history` para eventos paginados, incluindo filhos.

Em `version_conflict`, releia o registro e decida como reaplicar a alteração.
Em `stage_required`, use `next_stages` e a transição escolhida, sem tentar
adivinhar uma etapa pelo estado de base. Em `feature_disabled`, confira a
configuração fixada no trabalho. Rotas de conversa conferem a credencial do
titular; telefone informado no corpo não é autorização.

Os aplicativos antigos mantêm operação completa do tipo embutido e leitura dos
tipos novos. Só executam ações antigas com interpretação única. A edição
completa dos tipos novos exige aplicativos atualizados. Prontuário, ensino,
unidades e assembleias de condomínio e cálculo de prazo forense dependem de
extensões posteriores; campos extras não os substituem.

## Aplicativos

Os clientes Android e iOS atuais ainda têm estas limitações para tipos
personalizados, conforme a [conferência de API e aplicativos](areas/relatos/corr-api-apps.md):

- O histórico pode mostrar códigos de eventos novos, como `os.task.created`,
  em vez de rótulos legíveis. Os respectivos `ServiceOrderClient.kt` e
  `ServiceOrderClient.swift` precisam apresentar esses eventos.
- Podem oferecer edição de orçamento em `received` mesmo quando o tipo não
  permite orçamento. A atualização deve usar `features.quote` do snapshot
  devolvido na ordem, inclusive em trabalhos abertos em revisões anteriores.
- Continuam usando o estado de base e as ações legadas com interpretação única;
  não oferecem a edição completa dos tipos personalizados. A atualização deve
  consumir `stage_label`, `next_stages` e as capacidades fixadas da ordem.

Esta entrega não altera código móvel nem a autorização de documentos pelo
WhatsApp: o telefone verificado da conversa precisa corresponder ao da ordem.

Objeto do serviço e obrigatoriedade por etapa também não mudam os aplicativos:
abertura clássica, leitura e `/status` continuam compatíveis, e uma transição
que descumpra uma exigência nova é recusada pelo servidor com
`409 missing_fields` legível. Para adotar objetos depois, o aplicativo deve usar
os DTOs autorizados de objeto e de requisitos, selecionar o contato canônico,
conservar a chave idempotente entre tentativas, distinguir o cadastro atual da
cópia da ordem, tratar `missing_fields`, arquivamento e conflito de versão e
consultar campos privados só no fluxo autorizado separado. Integrações usam os
mesmos comandos de abertura e transição; escrever direto em `os_orders`,
`os_objects` ou `extra_json` não é ponto de extensão suportado.

## Encaixes para as próximas partes

- **Comercial (parte 3, entregue).** O projetor comercial usa
  `getWorkObjectContext(row, { kind: "customer" })` para o equipamento do
  documento. O texto abaixo descreve o contrato da função.
- **Comercial (contrato).** `getWorkObjectContext(row, audience)` é função pura
  sobre a cópia autorizada da ordem, sem consultar o cadastro atual. Devolve ID,
  tipo, versão, data e origem da cópia, identificador, campos permitidos e
  `equipment_text`, texto curto para o campo de equipamento do ERP. A audiência
  `commercial` usa lista explícita de campos. Não exporta a cópia bruta e nunca
  usa o identificador como cliente, pagador, catálogo ou credencial. O contrato
  `planStageTasks()` está reservado para o checklist automático: responde
  `501 not_implemented` e não é chamado nesta parte.
- **Mensalidade e Agenda (parte 4).** Leitura autorizada de objeto por
  ID/área/contato e o mesmo contexto acima. Cobertura poderá referenciar
  área, contato, objeto, modelo e vigência; a assinatura não concede acesso ao
  objeto. Data do evento e prazo da ordem são declarativos: não reservam
  horário, profissional ou material.
- **Junção de contatos.** `planObjectContactMerge()` devolve, para o lote da
  junção, as instruções que reatribuem os objetos do contato de origem ao de
  destino, com guardas de área, namespace e limites e referências de auditoria,
  sem commit separado. Preserva objetos, IDs, vínculos e cópias, não funde por
  placa, série ou endereço e devolve conflito explícito quando um limite seria
  excedido. A chamada pela frente de junção ainda não está ligada.

Ficam fora desta entrega: fiscal, reserva real de recursos, grupos repetíveis,
campos calculados, vários objetos por ordem, propriedade compartilhada,
transferência de bem entre clientes, correção de vínculo histórico, conversão
automática de ordens antigas, prontuário e sincronização de cadastro de
equipamento com o ERP.
