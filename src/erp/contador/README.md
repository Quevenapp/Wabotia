# Para o contador (Fiscal)

Pacote de arquivos fiscais do período, relatórios fiscais de conferência e envio
ao contador. Tela: Fiscal › Para o contador (`/contador-fiscal`, `web/erp/Contador.tsx`);
cadastro do contador também por Preferências › Notas Fiscais.

## Quem pode

- Parte Fiscal ligada (com o ERP). Desligada: `409 module_disabled` dizendo qual módulo ligar; some do menu.
- Ver (relatórios, pacotes, envios, baixar): papel fiscal, administrador ou consulta.
- Montar pacote, cadastrar o contador e enviar: fiscal ou administrador.
- Portão do ERP (horário de acesso e segundo fator), como em `/erp-fiscal-cofre`.
- Bot: só as operações concedidas (assunto NF-e). Enviar é sensível (o bot propõe, a pessoa confirma);
  montar grava e, como toda escrita do bot, também passa pela proposta confirmada.

## Rotas (`/api/v1/profiles/{área}/erp-contador`)

| Rota | Operação | O quê |
|---|---|---|
| `GET /pacotes` | `nfe.contador.pacotes` | Pacotes e últimos envios. |
| `POST /pacotes` `{de, ate, ambiente?, refazer?}` | `nfe.contador.pacote` | 201 cria; 200 devolve o mesmo pacote do período (`reaproveitado`). |
| `GET /pacotes/{id}` | (tela) | Situação e contagens. |
| `GET /pacotes/{id}/arquivo` | (tela) | O ZIP, das partes do R2 na ordem. |
| `GET /relatorio?de&ate&ambiente[&formato=csv]` | `nfe.contador.relatorio` | Relatórios; `formato=csv` para planilha. |
| `GET/PUT /contador` | (tela) | Cadastro, envio automático e anexos do Simples. |
| `GET /envios` | (tela) | Registro dos envios. |
| `POST /envios` `{pacote, canal?}` | `nfe.contador.enviar` | Link de 7 dias pelo WhatsApp da área ou por e-mail. |

Link público: `GET /api/public/contador/{código}` (código de 256 bits só na mensagem; o D1 guarda o SHA-256).

## Pacote

Montado no objeto do ERP da área (`do.ts`, `package.ts`), uma parte por acordada do alarme, sem trabalho
operacional na mesma acordada. Estado nas tabelas da versão 22 (`erp_contador__package`, `erp_contador__part`);
partes em `erp/{área}/contador/{id}/{montagem}/` no R2. Pastas do ZIP: `emitidas/{NFe,NFCe,NFSe}/{xml,pdf,eventos}`,
`emitidas/inutilizacoes`, `recebidas/{xml,pdf}`, `acervo-bling/{NFe,NFCe}` e a planilha `indice-notas_*.csv`.

- Emitidas: pela data de emissão no emissor; NFS-e sem PDF (o emissor não oferece DANFSe).
- Recebidas: só as com entrada ativa no ERP, pela data da entrada; XML do R2 conferido pelo SHA-256.
- Sem emissor configurado: as emitidas ficam de fora, com aviso na planilha.
- Falha passageira do emissor: a unidade volta com espera crescente; 12 seguidas param o pacote com a mensagem.

## Envio automático

Desligado por padrão. Ligado, no dia escolhido (1 a 28) monta o pacote do mês anterior (produção) e envia
assim que fica pronto. Cada mês é tratado uma vez (`auto_last_month`), tenha saído ou falhado; a falha fica no registro.
