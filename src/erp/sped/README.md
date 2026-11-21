# SPED e SINTEGRA (Fiscal)

SPED Fiscal (EFD ICMS/IPI), EFD-Contribuições (PIS/COFINS) e SINTEGRA (Convênio 57/95) do mês, com a
conferência do que falta antes de gerar. Tela: Fiscal › SPED e SINTEGRA (`/sped-fiscal`, `web/erp/Sped.tsx`).
**Nada é transmitido ao governo**: o arquivo é para o contador ou para o validador oficial (PVA).

## Quem pode

- Parte Fiscal ligada (com o ERP). Desligada: `409 module_disabled` dizendo qual módulo ligar; some do menu.
- Ver (conferência, arquivos, configuração, baixar): papel fiscal, administrador ou consulta.
- Gerar, configurar e enviar: fiscal ou administrador. Portão do ERP (horário e segundo fator).
- Bot (assunto NF-e): `nfe.sped.conferir`, `nfe.sped.gerar`, `nfe.sped.arquivos`; `nfe.sped.enviar` é sensível.

## Rotas (`/api/v1/profiles/{área}/erp-sped`)

| Rota | Operação | O quê |
|---|---|---|
| `GET /conferencia?tipo&de&ate[&inventario&ambiente]` | `nfe.sped.conferir` | O que falta, em palavras, com o atalho para corrigir. |
| `POST /arquivos` `{tipo, de, ate, ambiente?, inventario?, saldo_credor_anterior?, refazer?}` | `nfe.sped.gerar` | 201 pede; 200 devolve o mesmo arquivo do período. |
| `GET /arquivos` | `nfe.sped.arquivos` | Arquivos e pedidos de envio. |
| `GET /arquivos/{id}` · `GET /arquivos/{id}/conteudo` | (tela) | Situação; o texto (ISO-8859-1, CR LF). |
| `GET/PUT /configuracao` | (tela) | Perfil, atividade, contador (0100), PIS/COFINS, E116, SINTEGRA, pacote. |
| `POST /envios` `{arquivo, canal?}` · `GET /envios` | `nfe.sped.enviar` | Pelo envio do pacote do contador. |

## Como sai

- **De onde**: XML das NF-e e NFC-e emitidas (e NFS-e na EFD-Contribuições) lidos do emissor; inutilizações do
  emissor; notas recebidas com entrada ativa, pelo dia da entrada (XML do R2 conferido pelo SHA-256), com o
  produto que a entrada ligou a cada item; empresa, produtos e o inventário do Estoque (soma dos lançamentos
  até o dia, custo médio) quando pedido.
- **Montagem** no alarme do objeto da área (`job.ts`), uma etapa curta por acordada, como o pacote do
  contador; estado na versão 29 (`erp_sped__file`, `erp_sped__doc`, `erp_sped__settings`); o texto em partes
  no R2 (`erp/{área}/sped/{id}/{montagem}/parte-NNNNN`).
- **Layout** como dado versionado (`layout.ts`): campos de cada registro, COD_VER pelo ano, ordem dos blocos,
  registros de 126 posições do SINTEGRA. `validate.ts` confere linha a linha antes de gravar (campos, tipos,
  obrigatórios, aberturas e x990, 9900/9990/9999, totais do 90). Falhou: o arquivo não é gravado.
- **Pendência que impede** (IE, município, contador do 0100, NCM ou unidade de produto ligado, fornecedor sem
  documento, nota recebida sem XML ou sem item, XML ilegível, ICMS a recolher sem código de receita): o arquivo
  fica "com pendências", com a lista e o atalho; nada sai em silêncio.
- **Pacote do contador**: com a opção ligada, o arquivo pronto entra na pasta `obrigacoes/` do pacote do mesmo
  período (gancho `extras` no fecho de `src/erp/contador/package.ts`). Enviar: se o pacote do período já ficou
  pronto depois do arquivo, o link sai na hora; senão o pacote é montado de novo e o pedido espera no D1
  (`erp_sped_pending_sends`, migração 0240) até o agendador do módulo ERP mandar (`command.ts`).

## Regras aplicadas (resumo)

- SPED Fiscal: NF-e própria com C100 e C190, sem C170; NFC-e com C100 sem participante e sem ST/IPI/PIS/COFINS,
  e C190; cancelada/denegada só com a identificação; inutilizada um C100 por número; entrada com C170, CFOP e
  CST do IPI de entrada, CSOSN convertido em CST. E110 pelos C190 (saídas 5/6/7 a débito, entradas 1/2/3 a
  crédito), E116 com o código de receita, E200/E210 do ST retido por UF, E500 a E520 na atividade industrial.
  Blocos B, D, G e K vazios; 1010 com tudo "N".
- EFD-Contribuições: A100/A170 das NFS-e; C100/C170 das NF-e; C100/C175 das NFC-e; entradas só no não
  cumulativo, com crédito básico (item − ICMS); M100/M105, M200/M210, M500/M505, M600/M610.
- SINTEGRA: 10, 11, 50 por CFOP e alíquota, 54 por item (e 991/992/999), 61 e 61R das NFC-e, 74, 75 e 90.

## O que fica com o contador

Ajustes de apuração (E111, E220), recolhimento do ST (E250), receitas sem PIS/COFINS (M400/M410, M800/M810),
CIAP, bloco K de produção, plano de contas (COD_CTA), filiais em arquivo próprio e as notas emitidas no Bling
antes do corte: o arquivo avisa quando o caso aparece.
