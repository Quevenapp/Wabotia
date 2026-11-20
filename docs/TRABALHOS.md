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

Assistência técnica (Veículos) e Oficina mecânica oferecem **Placa** opcional,
visível ao cliente, não sensível e limitada a 10 caracteres; **Marca e modelo**,
**Ano** (inteiro de 1900 a 2100), **Cor** e **Última manutenção** (data informada
pelo cliente), além de Quilometragem, Combustível, Peças previstas e Avarias
na entrada. A definição continua dentro de 24 campos e 12 KiB.

Modelos já aplicados preservam suas edições. Na aba Modelos, a faixa
**O modelo padrão ganhou campos** oferece **Adicionar** somente os IDs que
ainda faltam, sem alterar campos existentes nem reutilizar IDs aposentados.
Isso vale apenas para ordens abertas depois da alteração; as abertas
conservam a definição anterior. A placa antiga sensível mantém sua classificação
e seus valores. É possível criar um novo campo vazio **Placa** visível ao cliente,
com outro ID, sem copiar dados do campo privado. Os limites do modelo e as
regras de validação continuam valendo.

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
