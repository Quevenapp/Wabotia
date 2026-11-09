# Decisão JEV após a interpretação do Atendente

Em **Automação → Regras de atendimento**, configure a chave JEV e ligue a opção **Usar JEV**. A chave é criptografada no servidor. O recurso vem desligado; desligá-lo mantém o atendimento normal pelo Hermes.

O Atendente interpreta o pedido e propõe uma ação estruturada. O Wabotia envia ao JEV um resumo operacional, a ação proposta e as fontes disponíveis. O contrato usa [System One](https://docs.typesafe.ai/api/system-one), `POST https://api.typesafe.ai/v1/systemone`, modelo `jev-latest`.

```text
Cliente → Atendente Hermes → interpretação → JEV → ação autorizada
                                               ├─ responder com fontes
                                               ├─ consultar especialista Hermes
                                               ├─ apresentar menu ou protocolos
                                               ├─ pedir informação que falta
                                               └─ encaminhar à equipe humana
```

O JEV aprova a ação proposta, solicita esclarecimento ou encaminha a uma pessoa. Ele não cria credenciais, escolhe bots fora das ações autorizadas nem produz fatos novos para a resposta. Uma consulta a especialista retorna ao Atendente; a resposta preparada também passa pelo JEV. O especialista mantém as credenciais da API do sistema no Hermes.

O bot deve devolver `interpretation: { intent, summary, missing_information }` junto da ação estruturada. `summary` é um resumo da necessidade do cliente. As instruções de execução do Wabotia já pedem esse formato. `clarification` pode conter a pergunta a fazer quando faltar informação.

Uma resposta do JEV só libera a ação se a opção for autorizada e tanto a probabilidade da escolha quanto a confiança forem pelo menos 0,8. Chave ausente, interpretação inválida, indisponibilidade, baixa confiança e resposta incompatível encaminham para atendimento humano. As permissões do número, titularidade dos protocolos, responsabilidade da conversa e janela de atendimento continuam sendo verificadas.

O registro `jev_decisions` guarda a decisão por execução. Não há repetição automática de uma chamada sem confirmação, pois o contrato consultado não documenta garantia de idempotência. Se uma pessoa assumir durante a decisão, a resposta automática é descartada. A migração `0013_jev_decisions.sql` deve ser aplicada antes do novo Worker.

Os testes locais cobrem ordem Hermes/JEV, desligamento, validação de escolhas, indisponibilidade, repetição de eventos e intervenção humana. A integração com chave e bots reais precisa ser homologada na instalação.
