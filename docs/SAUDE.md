# Saúde — prontuário

Extensão `saude`, desligada por padrão, dependente de `os`. Atende pacientes
humanos e animais com tutor. A ordem contém apenas o atendimento administrativo;
o prontuário longitudinal fica nas tabelas próprias da Saúde. Não preencha
diagnósticos em item, problema, notas, tarefas, mensagens ou campos extras da OS.

## Ativação e papéis

Após aplicar as migrações e os registros abaixo, ligue `os` e depois `saude` em
Gestão → Módulos. Conceda os papéis explicitamente em Pessoas e acessos:

| Papel | Capacidade |
| --- | --- |
| `os:sensitive` + `saude:clinical_read` | Ler cadastros, registros e anexos; exportar um prontuário |
| Os anteriores + `saude:clinical_write` | Cadastrar, vincular atendimento, escrever, anexar; editar e assinar as próprias evoluções |
| `saude:responsible` | Consultar auditoria e metadados de guarda, configurar prazo e impedimentos |
| Todos os anteriores | Executar descarte elegível |

Administrador não recebe esses papéis automaticamente. Responsável técnico sem
leitura clínica não vê o conteúdo. Recepção vê somente a existência, o número e
o estado da ordem administrativa. As concessões seguem o alcance de áreas da
pessoa no núcleo; não existe concessão automática por tutor, telefone ou vínculo
à ordem. O papel de leitura autoriza prontuários da área inteira, não apenas os
atendimentos atribuídos à pessoa.

Qualquer `via` (inclusive sem máscara), bot, aplicação, conector, identidade de
módulo ou credencial limitada é recusado, mesmo com papéis alegados. Não há rota
do cliente, rota pública, menu de WhatsApp, ferramenta MCP ou evento da extensão.
`bot.deny` cobre todos os caminhos e operações; `bot.sensitive` também está
declarado, mas não substitui a recusa no manipulador.

## Uso do painel

Em Gestão → Prontuários, carregue os cadastros ou crie um paciente. Para um animal,
informe nome, espécie e nome/referência conferida do tutor. Cada animal tem ID
próprio; dois animais do mesmo tutor nunca compartilham prontuário. A referência
é cadastral e não autoriza entrega ao tutor por WhatsApp.

Vincule o ID de uma ordem administrativa ao paciente. Uma ordem pode pertencer a
um único prontuário; um prontuário pode reunir vários atendimentos. Selecione o
atendimento e registre evolução, prescrição interna, pedido ou resultado de exame.
O resultado exige pedido do mesmo atendimento, origem e data de recebimento; é
identificado como recebido e ainda não revisado.

Evoluções começam como rascunho. Cada edição preserva a versão anterior cifrada.
Somente o autor edita ou assina, com versão esperada e confirmação expressa.
Assinada, a evolução fica imutável também por trigger SQLite. Correções criam
adendo com motivo e referência ao original assinado, no mesmo atendimento. O
adendo tem autoria e assinatura próprias. A interface e a exportação preservam
original e adendos. Prescrições e exames são registros acrescentados, sem edição
destrutiva; outro resultado pode referenciar o mesmo pedido.

A assinatura operacional fixa pessoa autenticada, conteúdo, data, versão e hash
SHA-256. Não representa assinatura com certificado, validação do registro
profissional ou emissão de receita válida. Não acrescenta reautenticação própria
além da sessão e da confirmação. Toda prescrição informa:
**“Registro interno. Não constitui receita emitida para dispensação.”**

## Anexos e exportação

Anexos aceitam PDF, JPEG, PNG e TXT, até 10 MiB. Metadados são sempre sensíveis,
sem visibilidade ao cliente. Reserva, tentativa exclusiva de cinco minutos,
validação de tamanho/hash e confirmação usam o transporte binário da F0
(`onBinaryUpload`, `content()`, `command()`), no Coordinator existente. Cada
tentativa usa chave R2 privada própria e PUT condicional; repetir a mesma chave
não sobrescreve bytes confirmados. Para uma tentativa expirada, use nova chave.
O inventário preserva as chaves abandonadas até o descarte do prontuário.

Downloads autorizam área, papel e paciente e gravam auditoria antes de abrir R2.
Não há registros em `media` nem URLs públicas. Todos os GETs usam o adaptador
binário, inclusive os JSON, para garantir `Cache-Control: no-store`, `nosniff`
e CSP restritiva. O painel não grava conteúdo em armazenamento persistente do
navegador; ao trocar de área/pessoa, desmonta o estado clínico.

**Exportar prontuário completo** baixa NDJSON específico daquele paciente,
incluindo cadastro, episódios, registros, revisões de rascunho, metadados e bytes
dos anexos prontos. Linhas `attachment_bytes` contêm `id`, `offset` e `base64`;
decodifique e concatene por ID/offset. A última linha deve ser
`{"type":"complete","subject_id":"…"}`. Sem ela, a cópia está incompleta.
O painel só oferece o arquivo após receber a resposta completa. A exportação
aborta se a versão do prontuário mudar durante a leitura: tente novamente.

A auditoria registra início, cada lote de recursos, download e conclusão. Falha
de auditoria impede a entrega; uma interrupção não registra conclusão. A
exportação não persiste pacote, link ou conteúdo em recibos comuns. A exportação
comum da OS/conversa não consulta as tabelas Saúde. Backup técnico da instalação
é um procedimento separado e pode incluir essas tabelas e o bucket privado.

## Auditoria e guarda

O responsável técnico consulta quem acessou, quando, ação e IDs/versões dos
recursos. Listagens registram os IDs entregues; leituras repetidas geram entradas
distintas. A consulta de auditoria também é registrada. Não se guardam conteúdo,
nome do paciente ou nome do arquivo nessa trilha. Escritas clínicas, auditoria
clínica e referências de idempotência são confirmadas no mesmo lote D1. Um guard
de `changes()` faz conflito de versão abortar todo o lote.

O prazo em dias é configurado pelo responsável técnico, sem padrão normativo
inventado. Prazo desconhecido ou exclusão desligada bloqueiam descarte. Ao
definir um prazo, ele conta da última atividade clínica. Novas atividades
estendem a guarda; reduzir a configuração nunca encurta uma data já registrada.
Impedimento de guarda bloqueia descarte mesmo depois do prazo. A política deve
ser definida pela instituição conforme seus requisitos aplicáveis.

O descarte exige confirmação, escrita clínica e responsabilidade técnica. A
aplicação e o trigger conferem prazo, política, impedimento e upload ativo. O
primeiro lote muda o estado para `deleting` e audita antes de remover bytes;
novas leituras e escritas ficam bloqueadas. Cada chamada remove até 20 objetos.
Repita com uma nova chave de idempotência enquanto `has_more` for verdadeiro.
Falha R2 mantém o inventário para retomada. Concluído, remove conteúdo e versões
D1, preservando tombstone sem cadastro e a auditoria. Não há descarte automático
por agendador. O administrador da instalação precisa tratar backups e reaplicar
os descartes em restaurações; esta extensão não altera o backup do núcleo.

## API privada

Prefixo: `/api/v1/profiles/{profile}/saude`. Escritas exigem `Idempotency-Key`.
Parâmetros de caminho prevalecem sobre o corpo. Nenhuma escrita devolve conteúdo
clínico: somente referências. As listas aceitam `cursor` opaco e `limit` de 1 a
50 (padrão 30); percorra todas as páginas. O armazenamento pagina por ID estável;
os IDs incluem a data de criação e o painel ordena os registros carregados por data.

| Método e caminho | Entrada/retorno |
| --- | --- |
| `POST /subjects` | `kind: human\|animal`, `name`, `birth_date?`; animal exige `species`, `tutor: {name,reference}` |
| `GET /subjects` | Página de nomes/IDs protegidos |
| `GET /subjects/{subject_id}` | Cadastro protegido |
| `POST /subjects/{subject_id}/episodes` | `order_id` da área |
| `GET /subjects/{subject_id}/episodes` | Página dos vínculos administrativos |
| `POST /subjects/{subject_id}/records` | `episode_id`, `kind`, `text`; adendo acrescenta `addendum_of`, `reason`; resultado acrescenta `request_id`, `origin`, `received_at` em milissegundos |
| `GET /subjects/{subject_id}/records` | Página de registros, assinaturas e adendos |
| `PATCH /subjects/{subject_id}/records/{record_id}` | `version`, `text`; rascunho de evolução do autor |
| `POST /subjects/{subject_id}/records/{record_id}/sign` | `version`, `confirm: true` |
| `POST /subjects/{subject_id}/attachments` | `episode_id`, `name`, `mime_type`, `expected_bytes` |
| `GET /subjects/{subject_id}/attachments` | Página dos metadados sensíveis |
| `PUT /subjects/{subject_id}/attachments/{document_id}/content` | Bytes; cabeçalhos `Upload-Version: 1` e `Idempotency-Key` |
| `GET /subjects/{subject_id}/attachments/{document_id}/content` | Download privado auditado |
| `GET /subjects/{subject_id}/export` | Cópia NDJSON auditada |
| `GET /attendance/{order_id}` | Apenas existência, número e estado administrativo |
| `GET /audit` | Página; filtro opcional `subject_id` |
| `GET /policy` | Política e versão; responsável técnico |
| `PUT /policy` | `version` (0 na criação), `retention_days: número\|null`, `deletion_enabled` |
| `GET /retention/{subject_id}` | Estado, versão, última atividade, prazo, impedimento; sem conteúdo |
| `PUT /subjects/{subject_id}/hold` | `version`, `legal_hold` |
| `POST /subjects/{subject_id}/purge` | `confirm: true`; retorno `state`, `has_more` |

Erros principais: 403 papel/sessão; 404 área ou recurso inacessível; 409 módulo
desligado, versão divergente, assinatura imutável, guarda ou tentativa em curso;
400 entrada inválida; 413 limite do transporte. Validações não repetem valores
clínicos na mensagem de erro. Campos desconhecidos são rejeitados nos corpos de
cadastro, registro, política e reserva.

## Registros exatos para o integrador

Nenhum arquivo preexistente foi alterado. Os descritores não registram ganchos
por efeito de importação. Aplicar `0109_saude_records.sql`,
`0110_saude_documents_audit.sql` e `0111_saude_retention_guards.sql` após as
migrações existentes, incluindo o índice composto de `os_orders` em `0100`.

Em `src/modules/registry.ts`, acrescentar o import e a entrada em `modules`:

```ts
import { saudeModule } from "./saude/definition";
// Dentro de modules:
saudeModule,
```

Em `src/modules/runtime.ts`, acrescentar:

```ts
import { onBinaryRead, onBinaryUpload, onCommand, onRoute } from "./api";
import { saudeExtension } from "./saude/saude";
for (const item of saudeExtension.commands) onCommand("saude", item.op, item.handler);
for (const item of saudeExtension.writes) onRoute("saude", item);
for (const item of saudeExtension.binaryReads) onBinaryRead("saude", item.path, item.handler);
for (const item of saudeExtension.binaryUploads) onBinaryUpload("saude", item.path, item.handler);
```

Em `src/modules/os/definition.ts`, dentro de `grants`, se ainda não integrado por M/I:

```ts
{
  id: "sensitive",
  label: "Dados sensíveis",
  description: "Permite acesso privado do motor; Saúde exige também seus próprios papéis clínicos.",
},
```

Em `web/workspace-navigation.ts`, acrescentar nos respectivos arrays/objeto
(`FileText` já é importado):

```ts
// sections:
["saude", "Prontuários", FileText],
// workspaceGroups:
{ id: "saude", label: "Saúde", icon: FileText, pages: ["saude"] },
// pageModules:
saude: "saude",
```

Não adicionar `saude` a `adminPages`: a tela verifica papéis, incluindo o
responsável técnico sem leitura clínica, e o servidor é a autoridade final.
Em `web/lib/routes.ts`, dentro de `pageSlugs`:

```ts
saude: "prontuarios",
```

Em `web/admin/AdminArea.tsx`, acrescentar import e caso do switch:

```tsx
import { SaudePage } from "../modules/saude/SaudePage";
// No switch da página:
case "saude":
  return <SaudePage />;
```

Nenhuma linha de registro em `os/extensions.ts`, lista de rotas públicas,
permissões de credencial de conversa, ferramentas, menu WhatsApp,
`conversationExtensions`, eventos ou agendador. A extensão é um módulo próprio.
O catálogo OpenAPI central e a demonstração permanecem fora desta entrega;
as rotas e os corpos estão publicados neste guia.

## Decisões em relação ao levantamento

- O rascunho propunha uma estrutura ampla de profissionais, acesso por paciente,
  representação e entrega ao titular. Esta entrega usa papéis clínicos da área e
  um cadastro protegido de paciente/animal/tutor. Não simula habilitação
  profissional nem entrega legal a representantes.
- Evoluções, prescrições e exames compartilham `saude_records`, discriminado por
  tipo; `saude_revisions` preserva rascunhos. Isso concentra autoria, auditoria,
  guarda e isolamento sem misturar dados ao motor administrativo.
- Anexos reutilizam o **transporte de documentos da F0**, com metadados próprios.
  Não usam `os_documents`/`commitChild`: esses caminhos produzem histórico e
  eventos comuns e permitem `os:sensitive` sem exigir os papéis clínicos.
- Cadastro, registros, nomes de anexos e versões são cifrados com `seal/unseal`
  do núcleo, vinculados à área e ao ID. Bytes ficam no bucket privado existente,
  sem criptografia de aplicação adicional. Não há novo recurso Cloudflare.
- Descarte é explícito, com bloqueio, lotes e retomada, em vez do fluxo proposto
  de solicitação/aprovação separado. Não há agendador que apague prontuários.
- Exportação é NDJSON autenticado com bytes, sem pacote persistido nem link
  público. Não há encaminhamento por WhatsApp.

## Verificação e limites

Arquivos de teste: `tests/saude-records.test.ts`, `tests/saude-privacy.test.ts` e
`tests/saude-documents-retention.test.ts`, com fixture própria. Cobrem criação,
idempotência, papéis, área, cliente/bot, canais comuns, auditoria, assinatura,
adendo, exames, anexos, exportação, política, impedimento e retomada de descarte.
O registro do módulo nesses testes é local; não altera arquivos do integrador.

Verificações locais permitidas: `npx tsc --noEmit` e
`node scripts/check-saude.mjs` (UTF-8/LF, sintaxe dos testes e guardas SQLite em
memória). O script não usa rede nem substitui os testes Cloudflare. Vitest e
Wrangler ficam para a verificação externa.

Listas e descarte são limitados por página/lote. A exportação usa páginas SQL
de 50 linhas, com memória limitada por anexo; ainda é uma única invocação e sua
capacidade máxima depende do orçamento D1/Worker. Não foi medida em produção.

Ficam fora: certificado digital, validade legal da receita, verificação de
habilitação profissional, reautenticação específica de assinatura, concessão
por paciente, processo de representação/entrega ao titular, edição cadastral,
controle de vacinas/doses, internação especializada, integrações externas,
backup/restauração e atualização de aplicativos móveis. Para receita válida,
faltam validar identificação e habilitação do profissional, requisitos do
documento e de medicamentos, modalidade de assinatura admitida, verificação de
autenticidade, controle especial, entrega ao destinatário e retificações.
Prazos aplicáveis, exigências profissionais e política de cópias técnicas
precisam ser definidos pela instituição; este guia não atribui número de norma.
