# E-mail como canal: recebimento manual

Este guia é para a pessoa administradora da instalação. O recebimento usa **Cloudflare Email Routing → Worker desta instalação**. O envio reutiliza a configuração de **Gestão → Sistema → E-mail**. São configurações distintas; configurar uma não comprova a outra.

**Situação desta versão:** o adaptador REST do canal de e-mail está sem confirmação do formato `raw` e dos campos de resposta do fornecedor. A composição de produção retorna `provider_contract_unverified` ao preparar esse transporte. Isso bloqueia o envio do canal, incluindo a entrega do desafio de recebimento; não há configuração de tela que confirme o contrato. Os passos abaixo são o procedimento de operação quando essa pendência técnica estiver resolvida com evidência da conta real. Não marque a conexão como verificada manualmente para contornar o teste.

O aceite não acessou uma conta Cloudflare nem alterou DNS, enviou ou recebeu e-mail real. Nomes atuais do painel, convivência de MX de subdomínio com provedor externo e repetição após falha do handler estão **a conferir com a conta real**.

## 1. Escolher domínio e endereço

1. Escolha um domínio ou subdomínio cujo DNS esteja na Cloudflare e anote o endereço exato, por exemplo `atendimento@recebimento.suaempresa.com.br`.
2. Confira os registros MX atuais e quem recebe os e-mails da empresa. Se o domínio principal usa Google, Microsoft ou outro provedor, preserve seus MX. Valide o uso de um subdomínio para o Wabotia antes de modificar qualquer registro.
3. Verifique se o endereço escolhido ainda não pertence a outra conexão desta instalação. A exclusividade é global, inclusive entre áreas.

O endereço é normalizado em minúsculas e o domínio é normalizado. Pontos e `+tag` permanecem significativos: `atendimento+loja@…` e `atendimento@…` são endereços distintos. Informe um endereço só, sem lista.

## 2. Configurar o recebimento na Cloudflare

1. Abra o serviço **Email Routing** da zona escolhida e confira o procedimento que o painel mostra para habilitar recebimento.
2. Revise os MX propostos antes de salvar. Não remova os MX do provedor existente por uma instrução automática deste guia; confirme primeiro a configuração do subdomínio na conta real.
3. Crie uma regra de **endereço exato → Worker** e selecione o Worker desta instalação Wabotia. Evite usar uma regra abrangente para substituir a correspondência exata.
4. Anote o nome do Worker e mantenha-o. Se ele mudar, revise a regra na Cloudflare. Atualização do Wabotia não ajusta esse vínculo automaticamente.

O instalador e o atualizador não cadastram domínio, não alteram DNS/MX, não criam a regra de Email Routing e não recebem token de zona. Nenhum recurso Cloudflare adicional é necessário no código desta leva.

## 3. Configurar o mesmo endereço no Wabotia

1. Entre como pessoa administradora e abra `/app?canais=2` para mostrar o catálogo novo.
2. Em Conexões, crie a conexão de **E-mail** e informe exatamente o destinatário da regra.
3. Mantenha bot e confirmação automática desligados durante o recebimento inicial. Eles são opções independentes, explicitamente ativadas depois.
4. Confira a configuração de envio do Sistema conforme [EMAIL.md](EMAIL.md). A conexão não recebe SMTP, token de zona ou credencial própria. Uma configuração presente aparece como **configurado**, sem revelar o segredo.
5. Execute **Testar recebimento**. O desafio é aleatório, tem uso único e validade de dez minutos; seu registro guarda o hash. O e-mail de teste volta ao mesmo endereço pela regra de recebimento.
6. Aguarde a situação **recebido**. O teste é reconhecido antes de criar contato ou conversa. Desafio incorreto, repetido ou expirado não ativa a conexão; timeout significa **teste inconclusivo**, não prova de falha definitiva do roteamento.

No código atual, o desafio pode entrar na fila, mas sua entrega não se completa enquanto persistir `provider_contract_unverified`. Confirme essa pendência antes de investigar DNS. O envio de teste do Sistema e a transcrição usam contratos próprios; seu sucesso não confirma o envio do canal com MIME e encadeamento.

Mudar um endereço sem histórico exige novo teste. Se já existem conversas ou entradas recebidas, o servidor exige outra conexão; não reaponta o histórico silenciosamente.

## 4. Conferir uma entrada humana

Após resolver a pendência do transporte e confirmar o desafio, envie de uma caixa de teste autorizada uma mensagem simples com acentos, assunto e um anexo pequeno permitido. Confira destinatário, assunto, corpo em texto, aviso **Remetente não confirmado** e anexo privado. Faça essa prova somente em conta autorizada e registre o resultado sem incluir credenciais ou conteúdo pessoal no relatório técnico.

O remetente do envelope define o agrupamento operacional. `From` e `Reply-To` diferentes aparecem para a equipe, sem trocar automaticamente o destinatário de resposta. SPF, DKIM, DMARC e `Authentication-Results` recebidos são informação não confiável para autenticar uma pessoa. Até um e-mail falsificado pode chegar: o sistema protege os dados por não lhe conceder prova de identidade.

Bot e confirmação automática permanecem desligados por padrão. Se o bot for ligado, responde somente informação geral e encaminhamento, sem ficha, histórico privado, protocolo de outra entrada ou dados de módulos. A confirmação é texto fixo, sem dados de cliente, no máximo uma por remetente/hora, com `Auto-Submitted: auto-replied`.

## 5. Caixas, limites e retenção

| Situação | Comportamento esperado |
|---|---|
| Automático, lista, boletim, devolução ou teste | Fica na caixa da conexão; não cria contato/conversa e não dispara bot ou confirmação. |
| Endereço/domínio bloqueado | Comparação exata após normalização; não abre atendimento. |
| Mesmo bruto recebido novamente | Chave por conexão, remetente/destinatário do envelope e hash evita nova mensagem. |
| Mesmo `Message-ID`, conteúdo divergente | Quarentena; a mensagem anterior não é substituída. |
| HTML sem texto | Conversão por parser para texto; scripts, estilos, `cid:` ativo e recursos remotos não são exibidos/carregados. |
| Bruto acima de 25 MiB | Recusado pelo limite do stream efetivo, mesmo se `rawSize` disser menos. |
| Bruto acima de 8 MiB e dentro de 25 MiB | Quarentena pelo limite local de processamento MIME; não abre atendimento. |
| Anexo recusado | Texto seguro preservado e aviso; até 32 anexos e limites por tipo, sujeitos também ao envelope. |
| Falha de R2 ou D1 na recepção | Não é registrada como sucesso. A política de reentrega da Cloudflare permanece a conferir. |

O bruto fica privado no R2 e não é um anexo do atendimento nem pode ser baixado pelo endpoint normal de mídia. O handler registra pendência durável; o Coordinator faz parsing e anexos com lease e deduplicação. R2 e D1 não formam uma transação: a manutenção recolhe órfãos e retoma pendências.

O bruto processado é elegível para exclusão após sete dias; automático, bloqueado, quarentena ou erro, após trinta dias. A limpeza ocorre em rodadas do cron, portanto o prazo é de elegibilidade, não promessa de exclusão no segundo exato. Exclusão explícita de dados pessoais abrange pendências e bruto aplicáveis. Não há promessa de antivírus ou inspeção universal por assinatura binária.

## 6. Resposta, cota e diagnóstico

Depois de confirmado o contrato remoto, o envio usa o endereço fixo da conexão, um destinatário e nenhum CC/BCC. O assunto aceita até 200 caracteres sem CR/LF/NUL; número de pedido e URL são permitidos. O texto aceita até 50.000 caracteres. Uma resposta parte do assunto da última entrada com um único `Re:`, editável pela pessoa, e referencia a entrada apropriada à thread. A conversa por remetente não é tratada como uma única thread de assunto.

O MIME completo enviado, incluindo anexos e cabeçalhos, tem teto de 25 MiB; a requisição REST codificada também tem teto local de 25 MiB, podendo reduzir o tamanho útil. Cabeçalhos são saneados, com até 50 referências e 8 KiB no conjunto. Não há envio silencioso sem anexo ou encadeamento quando o formato é desconhecido.

Há 200 reservas de saída por área em 24 horas móveis e dez por remetente em uma hora; confirmação automática tem seu limite adicional de uma por hora. Replay não reserva de novo. Transcrição e módulos mantêm cotas e finalidades próprias. Aceitação HTTP não comprova entrega na caixa postal. Resultado **indeterminado** exige conferência humana; não é reenviado automaticamente.

| Diagnóstico | Próximo passo |
|---|---|
| `provider_contract_unverified` | Aguardar confirmação técnica do adaptador com conta real; trocar token, DNS ou assunto não confirma o contrato. |
| Envio do Sistema ausente | Configurar em Gestão → Sistema → E-mail; não cadastrar credencial na conexão. |
| Teste inconclusivo/expirado | Conferir regra exata, endereço, nome do Worker e diagnósticos; repetir como novo teste após resolver a causa. |
| Quarentena por MIME/tamanho | Conferir o motivo e pedir texto/anexo menor por um canal apropriado; não expor o bruto como mídia comum. |
| Cota local ou 429 comprovado | Aguardar a liberação indicada; não gerar intenções repetidas para contornar a reserva. |
| Indeterminado após possível envio | Conferir o resultado remoto antes de decidir nova intenção. |

Pendências de fornecedor estão em [CANAIS-FORMATOS-PENDENTES.md](CANAIS-FORMATOS-PENDENTES.md); execução efetiva das provas, em [CANAIS-SEGUNDA-LEVA-ACEITE.md](CANAIS-SEGUNDA-LEVA-ACEITE.md).
