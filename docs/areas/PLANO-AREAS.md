# Plano: módulos por área de atividade (motor da Ordem de Serviço generalizado)

18/11/2026. Só plano, sem código. Base lida: `main` efc7e54 (0.21.1).

## Pedido do usuário

> "Hoje o ERP é voltado para comércio e o atendimento pelo WhatsApp ficou
> restrito a algumas opções como agenda, reservas etc. Precisamos deixar o
> Vinki com módulos além do ERP com atividades exclusivas de cada área
> […] Basicamente seria um outro módulo com o mesmo motor usando templates."

Áreas pedidas: Advogados, Escritório de advocacia, Engenheiros, Arquitetos,
Construtoras, Clínicas médicas e veterinárias, Assistência técnica, Serviços,
Personalizado, Escolas, Professores. **Condomínios** entrou no mesmo dia
("faltou condomínio").

**Decisão (18/11):** "generalizar motor ordem de serviço". O motor é o módulo
`os` que já existe; não nasce um segundo motor ao lado dele.

## O que existe hoje (conferido no código)

- **Módulo `os`** (`src/modules/os/`, `docs/ORDEM-DE-SERVICO.md`):
  - tabelas `os_orders`, `os_history` e `os_counters` no D1 (migração 0035);
  - nove estados fixos e as transições em `model.ts` (`OS_STATUSES`,
    `MANUAL_TRANSITIONS`, `QUOTABLE`);
  - dois campos de texto fixos, `item` e `problem`;
  - orçamento com aprovação pelo WhatsApp, garantia, lembrete de retirada,
    aviso de ordem parada;
  - itens de menu `os_open` e `os_track`, eventos `os.*`, papel "Técnico",
    configuração na chave `service_orders`;
  - API pública (`/profiles/{perfil}/service-orders`, com o mapa `counts`
    por estado) que os aplicativos já leem.
- **Modelos prontos** (`src/service-templates.ts`): aplicar um modelo grava
  configurações comuns pela mesma validação do `PUT /settings`; não existe
  um segundo runtime. É o precedente para os modelos de área.
- **Declaração de módulo** (`src/modules/types.ts`): navegação, tipos de item
  de menu (com `reference` para apontar um cadastro), eventos, configurações,
  papéis (`grants`) e opções de bot (`deny`, `sensitive`, `hints`).
- **Outra coisa com o mesmo nome:** o ERP tem o documento "ordem de serviço"
  do Fagoo, com campos personalizados próprios, guardado no objeto do ERP.
  Ele é do comércio e **não** é o que este plano generaliza.

## Desenho

### 1. Tipo de trabalho

O registro continua sendo a linha de `os_orders`. O que hoje é fixo passa a
vir de um **tipo de trabalho**, cadastrado por área de atendimento:

| O que o tipo define | Hoje | Exemplo em outra área |
|---|---|---|
| Nome do registro | "Ordem de serviço" | Processo, Projeto, Obra, Atendimento, Matrícula |
| Rótulo dos dois campos fixos | Item / Problema | Nº do processo / Assunto; Animal / Queixa |
| Campos extras | não há | Vara, comarca; ART; espécie e raça; turma |
| Etapas e transições | nove estados fixos | Inicial → Citação → Instrução → Sentença → Recurso |
| Recursos ligados | orçamento, garantia, retirada, termos | tarefas e prazos, pessoas ligadas, documentos, lançamentos |
| Mensagens ao cliente por etapa | oito textos fixos | um texto por etapa do tipo |

- Uma área pode ter **vários tipos** (um escritório com "Processo" e
  "Consultivo"). Cada tipo tem numeração própria.
- **O tipo embutido "Ordem de serviço" é exatamente o comportamento atual.**
  Quem já usa o módulo, e os aplicativos publicados, não percebem mudança.
- **Compatibilidade da API:** cada etapa de um tipo aponta para um dos nove
  estados de base. O campo `status` e o mapa `counts` continuam com os nove
  códigos; a etapa própria vai num campo novo (`stage`), com o rótulo vindo
  do tipo. Aplicativo antigo segue funcionando; aplicativo novo mostra a
  etapa.
- Campos extras ficam numa coluna JSON da própria ordem, validados contra o
  tipo. Cada campo diz se o cliente pode ver e se é **sensível**.

### 2. Peças novas do motor (uma vez, para todas as áreas)

Quatro tabelas filhas, aditivas, no D1. Nenhuma é de uma profissão só:

| Peça | Serve para |
|---|---|
| **Tarefas e prazos** | prazo processual, visita técnica, retorno, entrega de etapa; com responsável, vencimento e aviso |
| **Pessoas ligadas** | partes do processo, tutor do animal, responsável do aluno, contratante da obra; com papel e contato |
| **Documentos** | procuração, prancha, laudo, contrato; no R2, com a marca "o cliente pode receber" |
| **Lançamentos** | andamento, diário de obra, medição, horas trabalhadas, anotação de aula; tipo, texto, quantidade e data |

O histórico (`os_history`) já existe e passa a registrar também essas peças.

### 3. Modelo de área

Um modelo é um arquivo declarativo, como os de `service-templates.ts`.
**Aplicar** um modelo (Gestão → Modelos de área, com prévia) grava:

- os tipos de trabalho da área;
- os módulos ligados e desligados (Agenda, Mensalidade, Formulários,
  Cobrança, ERP);
- o vocabulário (cliente → paciente, aluno, tutor);
- setores, categorias de protocolo, menu do WhatsApp e mensagens;
- as instruções e as permissões sugeridas do bot da área (PLANO-BOTS.md);
- os passos que sobram para a pessoa fazer à mão.

Regras:

- aplicar não apaga nada do que foi feito à mão (ids com prefixo do modelo);
- depois de aplicado, tudo é configuração comum, editável;
- **Personalizado** é o editor de tipos de trabalho, com exportar e importar
  o modelo em JSON.

### 4. As áreas

| Área | Tipo(s) de trabalho | Módulos ligados | Precisa de código próprio? |
|---|---|---|---|
| Assistência técnica | Ordem de serviço (o atual) | Cobrança | Não |
| Serviços | Orçamento → agendamento → execução | Agenda, Cobrança | Não |
| Engenheiros, Arquitetos | Projeto com etapas, visitas e aprovação do cliente | Agenda, Cobrança | Não |
| Construtoras | Obra com etapas, diário e medições | Cobrança, ERP (compras) | Compra por obra, se pedirem |
| Advogados, Escritório | Processo; Consultivo | Agenda, Mensalidade, Cobrança | Sim: prazos forenses |
| Clínicas médicas e veterinárias | Atendimento; paciente ou animal com tutor | Agenda, Cobrança | Sim: prontuário |
| Escolas | Matrícula; aluno e responsável | Mensalidade, Formulários | Sim: turmas, frequência e notas |
| Professores | Aluno com pacote de aulas | Agenda, Mensalidade | Não |
| Condomínios | Ocorrência ou manutenção; Encomenda na portaria; Visitante | Reserva (áreas comuns), Mensalidade (taxa), Formulários | Sim: unidades e moradores; assembleia e votação |
| Personalizado | o que a pessoa montar | o que ligar | Não |

"Escritório" e "Advogados" são o mesmo modelo; o escritório liga a
distribuição por responsável e as horas trabalhadas.

**Extensões** (onde modelo não basta) são módulos pequenos que exigem o
`os` (`requires`), cada um numa fase própria:

- **Saúde:** prontuário. Dado de saúde, com sigilo, guarda e registro de
  quem leu. A IA nunca lê.
- **Jurídico:** contagem de prazo em dias úteis forenses e, depois, consulta
  de andamento nos tribunais.
- **Ensino:** turmas, frequência e notas com regra de cálculo.
- **Condomínio:** cadastro de blocos e unidades com os moradores de cada
  uma (proprietário, inquilino, dependente), que liga o telefone do
  WhatsApp à unidade; assembleia com pauta e votação por unidade. Sem a
  extensão, o modelo já entrega ocorrências, encomendas (recebida → avisada
  → retirada, com o lembrete de retirada que a Ordem de Serviço já tem),
  visitantes, reserva de áreas comuns e a taxa pela Mensalidade, com a
  unidade num campo extra. Rateio de despesas e prestação de contas ficam
  fora: são do financeiro do ERP.

### 5. WhatsApp e bots

- Os itens de menu `os_open` e `os_track` passam a apontar um tipo
  ("Abrir chamado", "Acompanhar meu processo"), pelo `reference` que a
  declaração de módulo já tem.
- O cliente pode, sozinho: abrir, acompanhar, aprovar orçamento ou etapa,
  mandar e receber documento, ver as próprias tarefas pendentes.
- Vale a regra dos bots: o que vem de fora tem teto de cliente, e o cliente
  só vê o que é do telefone dele.
- Campo marcado como sensível não vai em mensagem, não vai à IA e não
  aparece para quem não tem o papel.

### 6. Dinheiro e ERP

- Honorário, parcela e mensalidade usam a Cobrança e a Mensalidade que já
  existem.
- O lançamento no financeiro do ERP depende da decisão já aberta sobre o
  lançamento financeiro dos módulos; este plano não a antecipa.
- Nota de serviço fica para quando o Fiscal do ERP emitir NFS-e pelo cofre.
- Esconder estoque e frente de caixa para quem só presta serviço: **a
  conferir** como o ERP separa as telas por papel.

## Limites

- Nenhuma classe nova de Durable Object; tudo no D1 e no R2 que já existem.
- Migrações só aditivas (regra do formato 2 do pacote).
- A suíte atual da Ordem de Serviço passa sem alteração na fase 1: é a prova
  de que o tipo embutido não mudou nada.
- Dados de saúde e de menores pedem base legal e aviso próprios; entram só
  com a extensão correspondente.

## Fases

| Fase | Entrega | Tamanho |
|---|---|---|
| 0 | Contrato do tipo de trabalho (formato, validação, campos da API), lido pela sessão A | pequeno |
| 1 | Motor: tipo, etapas configuráveis, campos extras, vocabulário; o tipo embutido igual ao atual | médio |
| 2 | Tarefas e prazos, pessoas ligadas, documentos, lançamentos | médio |
| 3 | Modelos de área, tela de aplicar e Personalizado; entrega Assistência técnica e Serviços | médio |
| 4 | Engenheiros, Arquitetos, Construtoras, Professores (só modelos) | pequeno |
| 5 | Advocacia, com a extensão de prazos | médio |
| 6 | Clínicas, com a extensão de prontuário | grande |
| 7 | Escolas, com a extensão de ensino | grande |
| 8 | Condomínios: o modelo pode sair na fase 4; a extensão (unidades, moradores, assembleia) vem aqui | médio |
| à parte | Aplicativos Android e iOS lendo etapa e vocabulário, depois da fase 1 | médio |

As fases 1 e 2 são código de bloco grande com contrato claro: bom trabalho
para o Codex, com leitura da sessão dona e suíte verde antes da junção.

## A conferir antes da fase 0

- `src/modules/os/os.ts` e `store.ts` (não lidos): onde os estados fixos
  estão espalhados além do `model.ts`.
- O que os aplicativos Android e iOS assumem sobre os nove estados.
- Como o ERP separa as telas por papel (para o perfil "só serviços").
- Limite de consultas ao D1 por invocação com as quatro tabelas novas.

## Decisões do usuário em aberto

1. **Nome na tela.** O módulo aparece com o nome do tipo ("Processos",
   "Obras"). Para a área que tem vários tipos, falta o nome do conjunto;
   sugestão: "Trabalhos".
2. **Prontuário dentro do Vinki?** Sugestão: sim, como extensão própria,
   sem acesso da IA, só na fase 6.
3. **Ordem das áreas** depois da fase 3. Sugestão: a da tabela acima.
4. **Quando começa:** em paralelo ao porte do ERP, pelo Codex, ou depois
   dele.
