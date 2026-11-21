# Primeira coleta do Bling — roteiro do dono

Este roteiro só é executado pelo dono na instalação dele, depois do aceite
simulado e das conferências oficiais. Não usar conta real nos testes, não
entregar segredos ao executor de testes e não realizar publicação como parte
do aceite. A função é **Receber dados do Bling**, em Base → Sistema.

Leia primeiro [escopo, proteção e limitações](RECEBER-BLING.md). O resultado
é um acervo histórico; os registros operacionais permanecem como estavam.

## 1. Resolver as pendências oficiais antes de ligar

Registrar em documento administrativo privado da instalação, sem segredos:

- Data, responsável e links oficiais vigentes do aplicativo OAuth, retorno,
  troca/renovação, expiração, rotação e revogação.
- Para cada recurso selecionado: endpoint, paginação, detalhe, filtros e
  fuso/data usada, variantes ativas/excluídas, identidade global ou parental,
  escopos de leitura e limites. Conferir XML separadamente.
- Método oficial de leitura que prova a identidade da conta/empresa, o ID
  esperado e a relação com a área do ERP.
- Limites do plano/API, consumo por outros aplicativos e limite vigente do
  armazenamento. A quota local de 20 mil chamadas/dia não prova quota oficial.

Os descritores locais `original_conferido` não bastam. A evidência aprovada
precisa entrar no catálogo versionado e na prova de conta da montagem antes
de selecionar recursos para coleta real. Entradas `nao_confirmado` ficam
desabilitadas. Se algum item não puder ser comprovado, parar neste ponto;
não criar endpoint ou escopo por tentativa, nem reutilizar confirmação do
simulador.

**Outros dados (fatia D).** Listas de preços, naturezas de operação, campos
customizados, contratos, NFS-e, lotes e fornecedores de produto têm só o
acesso **proposto** (`BLING_EXTRA_PROPOSED_ACCESS` em
`src/erp/bling/resources.ts`, com a dúvida de cada um). Para cada um que
for usar: conferir na documentação vigente o caminho, se há detalhe por id,
a paginação e os escopos; fazer **uma coleta real só dele**, abrir alguns
registros no Acervo e conferir os nomes dos campos que a adoção lê (lista
em [Receber dados do Bling](RECEBER-BLING.md), "Outros dados do Bling");
só então registrar a evidência (`confirmBlingExtraResource`). Na aba Outros
dados, ver a prévia antes de adotar: registro com formato diferente aparece
como pendência "formato não conferido", nunca como cadastro. A mão dupla
das listas e dos campos fica desligada até conferir também o `PUT` num
registro de teste.

## 2. Preparar aplicativo, acesso e baseline

1. Registrar aplicativo próprio no Bling e guardar as credenciais somente
   pela tela de Configuração. Não incluí-las em planilha, captura de tela,
   chamado, relatório, log ou backup lógico.
2. Copiar e registrar no aplicativo o retorno HTTPS exato mostrado:
   `https://<endereço-público>/api/public/erp-bling/<área>/callback`.
   Conferir área, endereço canônico e escopos de leitura aprovados.
3. Conferir a Base ligada, sessão administrativa válida e permissões da
   área. Manter IA desligada e leitura restrita até revisar a política;
   eventual liberação precisa do aviso ao administrador e auditoria.
4. Registrar data/hora e tamanho real do banco, estimativa do acervo,
   bytes XML em R2, disponibilidade de R2 e quota local escolhida.
5. Registrar contagens **e conteúdo** das tabelas operacionais relevantes
   por relatório/hash administrativo existente. Incluir cadastros, documentos,
   títulos/baixas, movimentos/saldos e notas. Uma igualdade só de contagens
   não detecta atualização indevida. Não registrar segredos ou dados pessoais
   em evidência pública.
6. Preservar backup apropriado e sua verificação, incluindo política própria
   para XML em R2. Não usar restauração como maneira de manter a coleta ativa.

## 3. Fazer uma seleção inicial pequena

Escolher poucos recursos cujo comportamento e volume tenham sido conferidos.
Usar um período recente nos recursos que realmente aceitam filtro de data,
uma quota menor e uma janela em que o dono possa acompanhar. Não tratar um
recurso sem filtro temporal como uma coleta pequena apenas por preencher
“a partir de”. Para observar estoque, incluir os produtos necessários; saldo
é consultado por IDs conhecidos e não comprova inventário completo.

Para a amostra fiscal, selecionar separadamente **XML de NF-e/NFC-e**
(`fiscal_xml`) e conferir sua referência oficial. Selecionar também NF-e
ou NFC-e para receber as fontes, ou verificar que já há fontes fiscais com
chave/modelo no acervo. Selecionar apenas a entidade fiscal não pede XML;
selecionar apenas XML permite arquivar fontes já recebidas. Acompanhar os
manifestos confirmados na aba Histórico fiscal, sem usar os contadores de
NF-e/NFC-e como contagem de arquivos.

Revisar os dez itens da lista na tela: aplicativo/retorno; referência e
escopos; conta; seleção/datas; chamadas/duração/lacunas; espaço/R2; bruto,
espelho e adoção; ausência de efeitos; consulta/IA; parada/revogação/apagamento.
Confirmar, **Ligar recebimento** e **Autorizar conta** no mesmo navegador.
Conferir a empresa devolvida. Conta diferente, sessão inválida ou identidade
não comprovada são motivo para interromper, sem contorno manual.

Pedir a coleta selecionada. Observar o estado e as pendências; pedidos
repetidos não ultrapassam quota, `Retry-After` ou prioridade operacional.
Não clicar repetidamente para tentar superar uma espera.

## 4. Medir a primeira passagem

Registrar início/fim, seleção, datas, chamadas, itens observados/alterados,
falhas saneadas, novas tentativas e ocupação antes/depois. Medir uma janela
representativa; a latência e o volume reais não foram medidos pelo simulador.

Estimar chamadas restantes a partir das páginas, detalhes, variantes,
revisitas e XML observados. Estimar crescimento com payload, versões e
metadados; manter intervalo de incerteza e indicar amostra insuficiente.
Não publicar previsão exata ou “100% da conta” com base no último GET.
Frescor depende da passagem concluída mais antiga entre as pistas exigidas;
pista sem evidência significa frescor desconhecido.

Conferir novamente o baseline operacional. Se houver diferença, identificar
se corresponde a operação humana normal registrada; uma mudança causada pela
coleta é falha de aceite e exige parada/investigação.

## 5. Conferir amostras e XML

Selecionar amostras no Bling e no acervo por **ID exato**, não por cliente,
SKU, total ou número comercial aproximado. Registrar apenas identificadores
e hashes apropriados à política local, evitando conteúdo pessoal em relatório.

- Conferir bruto, versão, data remota versus observação, valores/quantidades
  decimais, referências, variantes excluídas e campos sem destino.
- Conferir pelo menos uma alteração observada posteriormente: a versão
  anterior continua acessível; repetir o mesmo conteúdo não cria versão.
- Em financeiro, distinguir saldo desconhecido, aberto, parcial e pago; a
  consulta não deve criar baixa. Em estoque, distinguir depósito,
  físico/virtual, instante, partição e produto ausente; ausência não é zero.
- Em fiscal, selecionar NF-e e NFC-e conforme disponibilidade, entrada/saída,
  produção/homologação e situação; conferir chave/modelo, identidade, XML,
  tamanho e hash do download. Registrar arquivos/eventos indisponíveis.
- Solicitar ao contador a conferência fiscal pertinente. Validação estrutural
  não comprova assinatura criptográfica ou autorização fiscal.

Não alterar uma entidade real “só para testar”. Usar mudanças que ocorram no
trabalho normal da empresa ou aguardar a próxima observação legítima.

## 6. Ampliar progressivamente e definir parada

Ampliar seleção ou período somente após conferir amostras, capacidade e
consumo inicial. Repetir medição e registro a cada etapa. Se forem necessários
escopos adicionais, conferir oficialmente e reautorizar a **mesma conta**;
isso preserva acervo e checkpoints. Recursos sem confirmação continuam fora.

Parar imediatamente diante de conta incorreta, vazamento, efeito operacional,
identidade divergente, XML inconsistente, custo/consumo acima do aprovado ou
falha sem diagnóstico. Desligar e preservar evidências saneadas. Para 403,
rever escopos; para autorização incerta, reautorizar sem repetir refresh às
cegas. Para 429, respeitar a espera e rever o consumo compartilhado.

Rever projeção no aviso de 70% do teto; respeitar a parada preventiva em 80%
ou antes da próxima transação. Não elevar teto, reduzir histórico ou apagar
versões automaticamente para concluir. Se a seleção não couber, registrar
a lacuna e decidir seu alcance com o dono.

Verificar uma parada controlada por **Desligar** e a retomada autorizada
quando adequado. Desconectar remove credenciais, não acervo. Revogar no Bling
é ato separado do dono. Só apagar mediante prévia, hash e confirmação, depois
de decidir a retenção e verificar impedimentos; aguardar conclusão SQL/R2.

## 7. Registrar o resultado, sem declarar adoção

Registrar por recurso: confirmação oficial, seleção/período, pistas concluídas,
frescor comprovado ou desconhecido, observações, lacunas, exclusões comprovadas,
campos sem destino, XML/eventos faltantes, referências não resolvidas, espaço,
projeção e responsável pela conferência. Separar resultado simulado, conferência
oficial e observação real da instalação.

Registrar explicitamente a decisão final: **coleta contínua ativa**, com quota
e responsável pelo acompanhamento, ou **coleta desligada**, com motivo e próximo
passo. Registrar também o resultado da comparação operacional final e a política
de IA/consulta em vigor. Não encerrar com “migração concluída”: adoção, abertura
financeira/estoque e escrita de volta ainda exigem revisão e contratos próprios.
