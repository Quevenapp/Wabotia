# Receber dados do Bling

Esta função guarda o que foi observado na conta do Bling e oferece consulta
histórica. Ela pertence à Base do ERP, começa desligada e roda na instância
`erp:<área>` do `Coordinator`. Não requer outro Worker, fila, Durable Object ou
recurso Cloudflare. A tela fica em **Base → Sistema → Receber dados do Bling**,
rota `/receber-bling`.

Há três conceitos distintos:

| Estado do dado | O que significa nesta entrega |
|---|---|
| Bruto | Resposta recebida, identidade textual, precisão, referências e evidências preservadas. |
| Espelho histórico | Apresentação consultiva do bruto e de suas versões: **Consulta histórica — não opera no ERP**. |
| Adotado | Registro operacional criado, vinculado ou atualizado após revisão. Não existe nesta entrega. |

Coletar não cria cadastros, pedidos, títulos, baixas, saldos, notas ou efeitos.
`erp_sync__settings.enabled` continua falso. Não há envio de alterações ao
Bling. A adoção e a escrita contínua futura terão contratos e autorizações
próprios; uma passagem concluída não encerra a coleta nem constitui migração.

## Antes de usar uma conta real

O aceite automatizado usa exclusivamente dados e OAuth simulados. Ele não
confirma a documentação atual do Bling, seus limites, o aplicativo do dono,
os escopos contratados, a identidade da empresa ou a disponibilidade de XML.
Nenhum teste exige credencial ou conta real.

Os recursos originais estão marcados `original_conferido`: isso comprova a
implementação local herdada, não a vigência oficial. A coleta real só aceita
recursos `oficial_confirmado` com evidência da conferência. O catálogo é
versionado em `src/erp/bling/resources.ts`; o painel não aceita endpoints
arbitrários nem promove a confirmação por um simples clique. Recursos extras
sem caminho ou identidade confirmados permanecem bloqueados.

Antes da liberação real, registrar URL e data das referências oficiais para
endpoints, paginação, filtros, variantes excluídas, escopos de leitura,
limites e identificação da conta. Conferir separadamente OAuth, expiração,
rotação do refresh token, retorno e procedimento de revogação. Não inferir um
endpoint de identificação ou revogação a partir do seu nome. A montagem deve
receber uma prova oficial de identidade antes de liberar a autorização real.
Essa pendência não pode ser resolvida usando dados do simulador.

O procedimento exclusivo do dono está em
[Primeira coleta](RECEBER-BLING-PRIMEIRA-COLETA.md).

## Aplicativo, retorno e configuração

1. O dono registra seu próprio aplicativo no Bling, seguindo a referência
   oficial que conferiu. Não usar aplicativo de terceiro nem credenciais de
   demonstração.
2. Um administrador abre Configuração, informa identificador e segredo do
   aplicativo e salva. A resposta mostra somente a presença da configuração,
   sua revisão e o retorno público; nunca mostra novamente o segredo.
3. Copia o retorno exato apresentado, derivado do endereço canônico confiável
   da instalação: `https://<endereço-público>/api/public/erp-bling/<área>/callback`.
   Registra esse mesmo HTTPS no aplicativo. Não usar URL de desenvolvimento,
   `Host` recebido de terceiros ou redirecionamento improvisado.
4. Confere os nomes oficiais dos escopos de leitura exigidos pelos recursos
   selecionados. A lista local ainda sem escopos confirmados não prova que o
   aplicativo tenha acesso. Não solicitar escopos de escrita para esta fatia.
5. Define seleção, período, quota e permissões; revisa a lista de conferência
   de dez itens; aciona **Ligar recebimento** e depois **Autorizar conta**.
6. Conclui a autorização no mesmo navegador e sessão administrativa. O
   retorno valida estado de uso único, cookie protegido, sessão, área,
   revisões e validade de até dez minutos. Confere a empresa vinculada antes
   de pedir a primeira passagem.

Uma área vincula uma única conta. Reautorizar a mesma conta conserva acervo e
checkpoints; uma conta diferente é recusada. Para outra empresa, não tentar
trocar manualmente IDs no SQLite ou no cofre.

A API de dados usa apenas GET. A troca e a renovação OAuth usam POST
protocolar, separados do transporte de dados; isso não escreve entidades no
Bling. A renovação é exclusiva e usa comparação de revisão. Se o provedor
puder ter rotacionado o refresh token e a resposta se perder antes da custódia,
a autorização fica incerta e exige nova autorização.

## Cobertura e limites de interpretação

As 18 entidades originais têm coleta declarada; a seleção efetiva continua
dependendo da confirmação oficial e dos escopos da conta:

| Recursos | Semântica temporal local a conferir oficialmente |
|---|---|
| Contatos, produtos, pedidos de venda e vendedores | Alteração com hora; variantes excluídas podem não ter filtro temporal. |
| Propostas, pedidos de compra e ordens de serviço | Intervalo de datas. |
| Contas a receber e a pagar | Emissão; revisitas de títulos conhecidos abertos/parciais complementam a varredura. |
| NF-e e NFC-e | Emissão com hora, variantes por direção/situação; identidades separadas. |
| Formas de pagamento, depósitos, categorias de produtos e financeiras, contas contábeis | Sem filtro temporal. |
| Caixas | Intervalo de datas e variantes de registrados/excluídos; recortes persistidos da página recebida. |
| Saldos de estoque | Produtos conhecidos, até 25 IDs por grupo e três partições; cobertura incompleta. |

Janelas usam São Paulo e sobreposição de quinze minutos quando aplicável.
“A partir de” não limita recursos sem filtro temporal. Página curta não
comprova fim nos recursos de página de origem. Ausência em lista ou 404 de
detalhe não prova exclusão. Saldo ausente ou desconhecido não vira zero.
Estoque observado não é movimento, reserva, lote nem saldo de abertura.

Contratos, produção, listas de preços, naturezas, campos customizados,
borderôs, NFS-e, estruturas/fornecedores/lotes/movimentos/variações de produtos,
grupos, tipos de contato, situações/módulos/transições, logística e seus
subrecursos, empresas e usuários são lacunas visíveis enquanto os contratos
de acesso e identidade estiverem `nao_confirmado`. Depois de confirmados,
seu destino inicial é bruto sem interpretação operacional presumida.
Marketplace, anúncios, lojas virtuais e canais de venda ficam fora.

URLs de imagens e anexos permanecem referências no bruto; seus bytes não são
arquivados. Uma definição fiscal preservada não transporta regras fiscais,
e NFS-e bruta não implementa emissão ou escrituração.

## Histórico fiscal e XML

**XML de NF-e/NFC-e** é uma seleção própria (`fiscal_xml`). Selecionar NF-e
ou NFC-e coleta as fontes fiscais; para obter os arquivos, selecionar também
XML e conferir sua referência oficial. Pode-se pedir apenas XML quando as
fontes já existem no acervo. Sem fonte fiscal com chave/modelo comprovados,
não há arquivo a buscar.

XML de NF-e/NFC-e é privado por área no binding `MEDIA`, com chave derivada
do SHA-256. Reserva, obtenção, gravação, verificação e manifesto são etapas
duráveis. Arquivo gravado sem manifesto é reconciliado ou removido; o download
autenticado usa referência opaca e verifica o conteúdo.

O parser recusa estruturas proibidas, incluindo DTD/ENTITY, verifica limites,
identidade fiscal e presença estrutural de assinatura/protocolo. Isso não
certifica assinatura criptográfica, autorização fiscal ou escrituração.
Conservar as lacunas de XML indisponível, eventos ausentes e diferenças entre
produção e homologação. O contador deve conferir amostras e a cobertura do
pacote fiscal, inclusive a distinção entre recebido do Bling e XML nativo.

## Duração, espaço e retomada

Há no máximo uma unidade e um GET de dados por acordada elegível. O trabalho
operacional e os arquivos vencidos do ERP têm prioridade. A unidade externa
tem até quatro segundos, HTTP até três segundos, respeitando o próximo
vencimento operacional. Não há espera ativa ou repetição escondida: 429,
`Retry-After`, quota, falhas temporárias e timeout persistem a próxima tentativa.
403 de escopo bloqueia o recurso; 401 solicita renovação exclusiva.

A proteção inicial é de até **20 mil chamadas de dados por dia por conta**,
ajustável para baixo, e intervalo mínimo de **700 ms**. São limites locais,
não uma atribuição de quota oficial ao Bling. Aumento depende de conferência
oficial e nova projeção. Detalhes, revisitas, variantes e XML aumentam o número
de chamadas; uma lista de dez registros costuma exigir a lista mais seus
detalhes. A coleta pode durar dias e pode não caber inteira.

Progresso e cobertura apresenta as chamadas de dados no dia registrado e,
por pista, revisão do checkpoint, observados/alterados, início e conclusão
da passagem, próxima tentativa e frescor comprovado. Pista sem contador ou
passagem suficiente continua identificada como desconhecida. O frescor
agregado usa o início mais antigo das últimas passagens necessárias
concluídas; o horário do último GET não substitui essa evidência.
XML é acompanhado pelos manifestos confirmados no Histórico fiscal;
seus contadores por pista continuam desconhecidos e não reutilizam os
contadores de coleta de NF-e/NFC-e.

O teto conservador do SQLite é **10.000.000.000 bytes**: aviso em 70% e
parada em 80%, ou antes de a próxima transação ultrapassar 80%. Medem-se os
bytes reais da instância; o acervo tem estimativa própria, e os XML em R2
são separados. Versões antigas, índices, recibos e metadados também ocupam
espaço. Não há descarte automático de versões. Crescimento diário, médias
por entidade e projeção com intervalo de incerteza ainda são desconhecidos;
dependem da medição de amostras comparáveis, descrita no roteiro do dono.

O recibo torna o replay idempotente: repetir uma unidade confirmada não
duplica versão ou checkpoint. Queda antes do commit pode repetir GET, mas
não presume gravação. Mesmo conteúdo atualiza observação sem aumentar a
versão semântica; A→B→A mantém três versões. Fonte comprovadamente mais
antiga não substitui a corrente mais recente.
Capturas lexicais conservam a precisão original, com limite de 128 KiB de
evidência no armazenamento; exceder a capacidade interrompe a unidade sem
truncar ou substituir valores por números arredondados.

Desligar Vendas, Estoque, Financeiro ou Fiscal não interrompe o acervo,
que depende somente da Base. Desligar a Base suspende I/O e commits. Religar
qualquer parte não adota dados nem executa documentos históricos.

## Proteção, pessoas e IA

Configuração, autorização, coleta manual, desligamento, desconexão e
apagamento exigem administrador. Leituras começam restritas ao administrador;
concessões adicionais pertencem à configuração da área. Outra área não lê
acervo, XML, recibos ou credenciais desta área.

As operações estão definidas uma única vez em
`src/erp/bling/schema.ts`, com nomes estáveis, entradas, saídas, efeitos,
resumos em português, classificação sensível e OpenAPI. Bots usam essas
mesmas operações, dentro da interseção pessoa ∩ bot. Ações sensíveis exigem
confirmação humana por padrão, com liberação configurável pelo administrador.
Dados pessoais começam mascarados, e dados sensíveis/IA desligados. Habilitar
o envio ao provedor de IA exige aviso explícito e auditoria. Não existe
proibição estrutural de um tipo de dado comercial para IA.

O catálogo geral ainda não descobre o OpenAPI do ERP; conectá-lo é outra
trilha. O contrato e a política do servidor estão preparados, mas não se
deve anunciar a operação como descoberta pelo catálogo antes dessa conexão.
A opção de entrega dos próprios dados ao cliente exige também o caminho de
identidade verificada; configurar a opção não amplia a autoridade de uma
origem externa. WhatsApp e demais origens externas não adquirem poder
administrativo por usarem o telefone de alguém da equipe.

Identificador/segredo do aplicativo e tokens ficam cifrados no cofre do núcleo,
separados por `erp-bling:<área>`. Não entram no SQLite do ERP, erros, logs,
recibos, exportação ou backup lógico. Auditoria contém atores, operações,
revisões, hashes, contagens e códigos saneados, sem cargas comerciais completas.

O backup lógico conserva acervo, hashes, checkpoints e recibos não secretos;
exclui credenciais e estados OAuth transitórios. Restauração mantém a coleta
desligada, invalida posses e requer nova validação de conta/credencial. O
backup lógico do SQLite não substitui a preservação dos objetos XML em R2.

## Parar, desconectar, revogar e apagar

- **Desligar:** impede novas chamadas e invalida commits em curso; conserva
  o acervo. Religar exige configuração/aprovação válidas e respeita as esperas.
- **Desconectar:** também remove o material secreto e conserva uma revisão
  de invalidação, para uma resposta atrasada não restaurar credenciais.
  Conserva os dados históricos.
- **Revogar no Bling:** o dono remove a autorização do aplicativo no próprio
  Bling, segundo procedimento oficial conferido. Não há chamada inventada de
  revogação remota.
- **Apagar acervo:** revisar a prévia com escopo, geração, contagens e arquivos;
  confirmar seu hash. O trabalho desliga a coleta, aposenta a geração e apaga
  SQL/R2 em lotes retomáveis. Conteúdo referenciado por adoção, vínculo
  operacional ou envio em revisão impede o apagamento. A conclusão só vale
  após conferência SQL e R2; recibo mínimo/auditoria permanecem, e comandos
  antigos não podem ressuscitar o acervo.

O apagamento excepcional suspende somente os gatilhos DELETE da allowlist
do acervo dentro da mesma transação síncrona, restaura as definições e
confere FKs. Não usa a restauração geral de backup nem desliga guardas
operacionais. Não apagar arquivos diretamente no R2 como atalho.

## Evidências de aceite

Os testes `tests/erp/org/*.test.mjs` e `tests/org-*.test.ts` distinguem o
servidor de recursos simulado (somente GET, zero mutações) do provedor OAuth
falso. A prova integrada compara conteúdo e contagens operacionais,
recibos/checkpoints, retomada e isolamento; testes do adaptador OAuth
inspecionam os POSTs com `fetch` injetado, sem rede.

O conjunto de verificação externa é `npm run check`, `npm run test:erp`,
as seis suítes `tests/org-{base,auth,coleta,acervo,api,painel}.test.ts`,
`tests/org-fecha.test.ts` e `npm run test:erp:painel`. A aprovação deve citar
o resultado efetivamente executado; teste escrito não é teste aprovado.
O diferencial e seu oráculo não são alterados para acomodar esta função.
Nenhum desses testes substitui o roteiro do dono ou autoriza implantação.

| Contrato | Onde conferir no aceite |
|---|---|
| A1 — escopo | Montagem no `Coordinator`, Base independente, API de dados GET e comparação operacional antes/depois. |
| A2 — semântica herdada | Recibos/CAS, revisitas, precisão, histórico e XML; aplicadores, vínculo operacional e envio permanecem fora. |
| A3 — dados | Tabelas da versão 11, corrente único, arquivo anterior, hash do envelope, replay e geração aposentada. |
| A4 — recursos | Catálogo versionado de 18 entidades, XML e extras não confirmados; evidência oficial continua pendente. |
| A5 — alarme | Uma unidade/GET, orçamento e prioridade operacional, esperas persistidas e revalidação após I/O. |
| A6 — autorização | Cofre cifrado/CAS, estado/cookie/sessão, mesma conta, refresh incerto e restauração suspensa. |
| A7 — operações | Descritores/OpenAPI, mesmas operações para pessoa/bot, política persistida, quatro abas e apagamento retomável; descoberta pelo catálogo é outra trilha. |
| A8 — arquivos e capacidade | XML privado por área, hash/manifesto, bytes SQL/R2 separados, parada preventiva e backup sem autorização. |
| A9 — conferência | Avisos e aprovação administrativos, auditoria saneada e roteiro do dono; métricas sem evidência não comprovam cobertura. |
| A10 — integração | Portas concretas montadas, simuladores separados, interrupções/replay e invariância operacional; registrar os resultados das verificações externas. |
