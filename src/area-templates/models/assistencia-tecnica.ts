import type { AreaTemplate } from "../validation";
import { equipamentoEletronicoObjectType, eletrodomesticoObjectType, veiculoObjectType } from "./service-object-seeds";

// Adaptado do primeiro bloco JSON de docs/areas/servicos.md ao contrato da seção 7.
// O embutido é apenas referenciado; as limitações do rascunho ficam nos passos manuais.
export const assistenciaTecnicaTemplate: AreaTemplate = {
  "schema_version": 1,
  "id": "assistencia_tecnica",
  "version": 4,
  "name": "Assistência técnica",
  "description": "Assistência técnica com a Ordem de serviço embutida e tipos opcionais para eletrônicos, eletrodomésticos, veículos e peças de roupa.",
  "work_types": [
    {
      "schema_version": 1,
      "kind": "custom",
      "id": "at_eletronicos",
      "revision": 1,
      "archived": false,
      "labels": {
        "singular": "Reparo de eletrônico",
        "plural": "Reparos de eletrônicos",
        "item": "Equipamento",
        "problem": "Defeito relatado",
        "customer_singular": "Cliente",
        "customer_plural": "Clientes"
      },
      "number_prefix": "ELE",
      "terms": "Autorizo a avaliação do equipamento descrito. O reparo depende da minha aprovação do orçamento. Alterações de preço ou escopo exigem nova aprovação. Não devo enviar senhas ou códigos pelo WhatsApp. A equipe combinará comigo qualquer acesso necessário ao equipamento.",
      "fields": [
        {
          "id": "acessorios",
          "label": "Acessórios recebidos",
          "help": "",
          "required": false,
          "client_visible": true,
          "sensitive": false,
          "kind": "text",
          "multiline": true,
          "max_length": 2000
        },
        {
          "id": "estado_entrada",
          "label": "Estado aparente na entrada",
          "help": "",
          "required": false,
          "client_visible": true,
          "sensitive": false,
          "kind": "text",
          "multiline": true,
          "max_length": 2000
        },
        {
          "id": "servico_executado",
          "label": "Serviço executado",
          "help": "Descreva o serviço realizado e a conferência antes de concluir o reparo.",
          "required": false,
          "client_visible": true,
          "sensitive": false,
          "kind": "text",
          "multiline": true,
          "max_length": 2000
        }
      ],
      "retired_field_ids": [
        "categoria",
        "marca_modelo",
        "numero_serie"
      ],
      "stages": [
        {
          "id": "recebido",
          "label": "Recebido",
          "base_status": "received",
          "message": "Recebemos a solicitação nº {numero}. Nossa equipe fará a avaliação."
        },
        {
          "id": "analise",
          "label": "Em avaliação",
          "base_status": "analyzing",
          "message": "A solicitação nº {numero} está em avaliação."
        },
        {
          "id": "orcamento",
          "label": "Orçamento enviado",
          "base_status": "quoted",
          "message": ""
        },
        {
          "id": "aprovado",
          "label": "Aprovado",
          "base_status": "approved",
          "message": "O orçamento nº {numero} foi aprovado. Vamos organizar a execução."
        },
        {
          "id": "recusado",
          "label": "Recusado",
          "base_status": "declined",
          "message": "O orçamento nº {numero} foi recusado. A equipe combinará a devolução ou o encerramento."
        },
        {
          "id": "execucao",
          "label": "Em execução",
          "base_status": "in_progress",
          "message": "Iniciamos a execução da solicitação nº {numero}."
        },
        {
          "id": "pronto",
          "label": "Reparo concluído",
          "base_status": "ready",
          "message": "O reparo nº {numero} foi concluído. A equipe combinará a entrega ou o encerramento no local."
        },
        {
          "id": "entregue",
          "label": "Entregue após reparo",
          "base_status": "delivered",
          "message": "Registramos a entrega ou o encerramento no local após reparo da solicitação nº {numero}. Obrigado pela preferência!"
        },
        {
          "id": "devolvido_sem_reparo",
          "label": "Devolvido sem reparo",
          "base_status": "cancelled",
          "message": "Registramos a devolução ou o encerramento no local sem reparo da solicitação nº {numero}. Para esclarecer alguma pendência, fale com a equipe."
        },
        {
          "id": "cancelado",
          "label": "Cancelado",
          "base_status": "cancelled",
          "message": "Solicitação nº {numero} cancelada. Para esclarecer alguma pendência, fale com a equipe."
        }
      ],
      "retired_stage_ids": [],
      "initial_stage": "recebido",
      "transitions": [
        {
          "id": "recebido_analise",
          "from": "recebido",
          "to": "analise",
          "label": "Em avaliação",
          "kind": "manual"
        },
        {
          "id": "recebido_cancelado",
          "from": "recebido",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "analise_cancelado",
          "from": "analise",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "orcamento_cancelado",
          "from": "orcamento",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "aprovado_execucao",
          "from": "aprovado",
          "to": "execucao",
          "label": "Em execução",
          "kind": "manual"
        },
        {
          "id": "aprovado_cancelado",
          "from": "aprovado",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "recusado_analise",
          "from": "recusado",
          "to": "analise",
          "label": "Em avaliação",
          "kind": "manual"
        },
        {
          "id": "devolver_sem_reparo",
          "from": "recusado",
          "to": "devolvido_sem_reparo",
          "label": "Confirmar devolução sem reparo e registrar destinação",
          "kind": "manual"
        },
        {
          "id": "recusado_cancelado",
          "from": "recusado",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "execucao_pronto",
          "from": "execucao",
          "to": "pronto",
          "label": "Atendimento finalizado",
          "kind": "manual"
        },
        {
          "id": "execucao_cancelado",
          "from": "execucao",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "pronto_entregue",
          "from": "pronto",
          "to": "entregue",
          "label": "Entregue ou encerrado",
          "kind": "manual"
        },
        {
          "id": "pronto_execucao",
          "from": "pronto",
          "to": "execucao",
          "label": "Em execução",
          "kind": "manual"
        },
        {
          "id": "pronto_cancelado",
          "from": "pronto",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        }
      ],
      "features": {
        "customer_open": true,
        "tasks": true,
        "people": true,
        "documents": true,
        "entries": true,
        "quote": {
          "default_valid_days": 7,
          "source_stages": [
            "recebido",
            "analise",
            "orcamento",
            "recusado"
          ],
          "sent_stage": "orcamento",
          "approved_stage": "aprovado",
          "declined_stage": "recusado",
          "edited_stage": "analise"
        },
        "warranty_days": 90,
        "pickup_reminder_days": 3,
        "stale_days": 7
      },
      "pickup_reminder_text": "Lembrete: o atendimento nº {numero} aguarda retirada. Fale com a equipe para combinar.",
      "object_type_id": "equipamento_eletronico",
      "stage_field_rules": [
        {
          "field_id": "servico_executado",
          "required_from_stage": "pronto"
        }
      ],
      "list_fields": [
        {
          "ref": {
            "scope": "object",
            "field_id": "identificacao"
          },
          "column": true,
          "filter": true
        },
        {
          "ref": {
            "scope": "object",
            "field_id": "marca_modelo"
          },
          "column": true
        }
      ]
    },
    {
      "schema_version": 1,
      "kind": "custom",
      "id": "at_eletrodomesticos",
      "revision": 1,
      "archived": false,
      "labels": {
        "singular": "Reparo de eletrodoméstico",
        "plural": "Reparos de eletrodomésticos",
        "item": "Eletrodoméstico",
        "problem": "Defeito relatado",
        "customer_singular": "Cliente",
        "customer_plural": "Clientes"
      },
      "number_prefix": "DOM",
      "terms": "Solicito a avaliação do equipamento informado. A visita depende de confirmação de endereço, horário e eventual taxa informada antes do agendamento. O reparo depende da minha aprovação do orçamento. Serviços adicionais exigem nova aprovação.",
      "fields": [
        {
          "id": "modalidade",
          "label": "Atendimento",
          "help": "",
          "required": true,
          "client_visible": true,
          "sensitive": false,
          "kind": "choice",
          "options": [
            {
              "id": "domicilio",
              "label": "domicílio"
            },
            {
              "id": "oficina",
              "label": "oficina"
            }
          ]
        },
        {
          "id": "endereco",
          "label": "Endereço da visita",
          "help": "",
          "required": false,
          "client_visible": false,
          "sensitive": true,
          "kind": "text",
          "multiline": true,
          "max_length": 2000
        },
        {
          "id": "acesso",
          "label": "Orientação de acesso",
          "help": "",
          "required": false,
          "client_visible": false,
          "sensitive": true,
          "kind": "text",
          "multiline": true,
          "max_length": 2000
        },
        {
          "id": "servico_executado",
          "label": "Serviço executado",
          "help": "Descreva o serviço realizado e a conferência antes de concluir o reparo.",
          "required": false,
          "client_visible": true,
          "sensitive": false,
          "kind": "text",
          "multiline": true,
          "max_length": 2000
        }
      ],
      "retired_field_ids": [
        "marca_modelo",
        "tensao"
      ],
      "stages": [
        {
          "id": "recebido",
          "label": "Recebido",
          "base_status": "received",
          "message": "Recebemos a solicitação nº {numero}. Nossa equipe fará a avaliação."
        },
        {
          "id": "analise",
          "label": "Em avaliação",
          "base_status": "analyzing",
          "message": "A solicitação nº {numero} está em avaliação."
        },
        {
          "id": "orcamento",
          "label": "Orçamento enviado",
          "base_status": "quoted",
          "message": ""
        },
        {
          "id": "aprovado",
          "label": "Aprovado",
          "base_status": "approved",
          "message": "O orçamento nº {numero} foi aprovado. Vamos organizar a execução."
        },
        {
          "id": "recusado",
          "label": "Recusado",
          "base_status": "declined",
          "message": "O orçamento nº {numero} foi recusado. A equipe combinará a devolução ou o encerramento."
        },
        {
          "id": "execucao",
          "label": "Em execução",
          "base_status": "in_progress",
          "message": "Iniciamos a execução da solicitação nº {numero}."
        },
        {
          "id": "pronto",
          "label": "Reparo concluído",
          "base_status": "ready",
          "message": "O reparo nº {numero} foi concluído. A equipe combinará a entrega ou o encerramento no local."
        },
        {
          "id": "entregue",
          "label": "Entregue após reparo",
          "base_status": "delivered",
          "message": "Registramos a entrega ou o encerramento no local após reparo da solicitação nº {numero}. Obrigado pela preferência!"
        },
        {
          "id": "devolvido_sem_reparo",
          "label": "Devolvido sem reparo",
          "base_status": "cancelled",
          "message": "Registramos a devolução ou o encerramento no local sem reparo da solicitação nº {numero}. Para esclarecer alguma pendência, fale com a equipe."
        },
        {
          "id": "cancelado",
          "label": "Cancelado",
          "base_status": "cancelled",
          "message": "Solicitação nº {numero} cancelada. Para esclarecer alguma pendência, fale com a equipe."
        }
      ],
      "retired_stage_ids": [],
      "initial_stage": "recebido",
      "transitions": [
        {
          "id": "recebido_analise",
          "from": "recebido",
          "to": "analise",
          "label": "Em avaliação",
          "kind": "manual"
        },
        {
          "id": "recebido_cancelado",
          "from": "recebido",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "analise_cancelado",
          "from": "analise",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "orcamento_cancelado",
          "from": "orcamento",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "aprovado_execucao",
          "from": "aprovado",
          "to": "execucao",
          "label": "Em execução",
          "kind": "manual"
        },
        {
          "id": "aprovado_cancelado",
          "from": "aprovado",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "recusado_analise",
          "from": "recusado",
          "to": "analise",
          "label": "Em avaliação",
          "kind": "manual"
        },
        {
          "id": "devolver_sem_reparo",
          "from": "recusado",
          "to": "devolvido_sem_reparo",
          "label": "Confirmar devolução sem reparo e registrar destinação",
          "kind": "manual"
        },
        {
          "id": "recusado_cancelado",
          "from": "recusado",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "execucao_pronto",
          "from": "execucao",
          "to": "pronto",
          "label": "Atendimento finalizado",
          "kind": "manual"
        },
        {
          "id": "execucao_cancelado",
          "from": "execucao",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "pronto_entregue",
          "from": "pronto",
          "to": "entregue",
          "label": "Entregue ou encerrado",
          "kind": "manual"
        },
        {
          "id": "pronto_execucao",
          "from": "pronto",
          "to": "execucao",
          "label": "Em execução",
          "kind": "manual"
        },
        {
          "id": "pronto_cancelado",
          "from": "pronto",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        }
      ],
      "features": {
        "customer_open": true,
        "tasks": true,
        "people": true,
        "documents": true,
        "entries": true,
        "quote": {
          "default_valid_days": 7,
          "source_stages": [
            "recebido",
            "analise",
            "orcamento",
            "recusado"
          ],
          "sent_stage": "orcamento",
          "approved_stage": "aprovado",
          "declined_stage": "recusado",
          "edited_stage": "analise"
        },
        "warranty_days": 90,
        "pickup_reminder_days": 0,
        "stale_days": 7
      },
      "pickup_reminder_text": "",
      "object_type_id": "eletrodomestico",
      "stage_field_rules": [
        {
          "field_id": "servico_executado",
          "required_from_stage": "pronto"
        }
      ],
      "list_fields": [
        {
          "ref": {
            "scope": "object",
            "field_id": "identificacao"
          },
          "column": true,
          "filter": true
        },
        {
          "ref": {
            "scope": "object",
            "field_id": "marca_modelo"
          },
          "column": true
        }
      ]
    },
    {
      "schema_version": 1,
      "kind": "custom",
      "id": "at_veiculos",
      "revision": 1,
      "archived": false,
      "labels": {
        "singular": "Serviço de oficina",
        "plural": "Serviços de oficina",
        "item": "Veículo",
        "problem": "Solicitação ou defeito",
        "customer_singular": "Cliente",
        "customer_plural": "Clientes"
      },
      "number_prefix": "VEI",
      "terms": "Autorizo a avaliação do veículo descrito. Peças e mão de obra serão apresentadas no orçamento. A execução e qualquer alteração de escopo dependem da minha aprovação. A equipe registrará as condições do veículo no recebimento e na entrega.",
      "fields": [
        {
          "id": "ultima_manutencao",
          "label": "Última manutenção informada pelo cliente",
          "help": "Data informada pelo cliente.",
          "required": false,
          "client_visible": true,
          "sensitive": false,
          "kind": "date",
          "min": null,
          "max": null
        },
        {
          "id": "quilometragem",
          "label": "Quilometragem de entrada",
          "help": "",
          "required": false,
          "client_visible": true,
          "sensitive": false,
          "kind": "integer",
          "min": 0,
          "max": 2147483647
        },
        {
          "id": "combustivel",
          "label": "Nível de combustível na entrada",
          "help": "Nível observado no recebimento; o tipo de combustível pertence ao cadastro do veículo.",
          "required": false,
          "client_visible": true,
          "sensitive": false,
          "kind": "choice",
          "options": [
            {
              "id": "reserva",
              "label": "reserva"
            },
            {
              "id": "opcao_2",
              "label": "1/4"
            },
            {
              "id": "opcao_3",
              "label": "1/2"
            },
            {
              "id": "opcao_4",
              "label": "3/4"
            },
            {
              "id": "cheio",
              "label": "cheio"
            },
            {
              "id": "nao_conferido",
              "label": "não conferido"
            }
          ]
        },
        {
          "id": "pecas_previstas",
          "label": "Peças previstas",
          "help": "",
          "required": false,
          "client_visible": true,
          "sensitive": false,
          "kind": "text",
          "multiline": true,
          "max_length": 2000
        },
        {
          "id": "avarias_entrada",
          "label": "Avarias na entrada",
          "help": "",
          "required": false,
          "client_visible": true,
          "sensitive": false,
          "kind": "text",
          "multiline": true,
          "max_length": 2000
        },
        {
          "id": "servico_executado",
          "label": "Serviço executado",
          "help": "Descreva o serviço realizado e a conferência antes de concluir o reparo.",
          "required": false,
          "client_visible": true,
          "sensitive": false,
          "kind": "text",
          "multiline": true,
          "max_length": 2000
        }
      ],
      "retired_field_ids": [
        "placa",
        "marca_modelo",
        "ano",
        "cor"
      ],
      "stages": [
        {
          "id": "recebido",
          "label": "Recebido",
          "base_status": "received",
          "message": "Recebemos a solicitação nº {numero}. Nossa equipe fará a avaliação."
        },
        {
          "id": "analise",
          "label": "Em avaliação",
          "base_status": "analyzing",
          "message": "A solicitação nº {numero} está em avaliação."
        },
        {
          "id": "orcamento",
          "label": "Orçamento enviado",
          "base_status": "quoted",
          "message": ""
        },
        {
          "id": "aprovado",
          "label": "Aprovado",
          "base_status": "approved",
          "message": "O orçamento nº {numero} foi aprovado. Vamos organizar a execução."
        },
        {
          "id": "recusado",
          "label": "Recusado",
          "base_status": "declined",
          "message": "O orçamento nº {numero} foi recusado. A equipe combinará a devolução ou o encerramento."
        },
        {
          "id": "execucao",
          "label": "Em execução",
          "base_status": "in_progress",
          "message": "Iniciamos a execução da solicitação nº {numero}."
        },
        {
          "id": "pronto",
          "label": "Reparo concluído",
          "base_status": "ready",
          "message": "O reparo nº {numero} foi concluído. A equipe combinará a entrega ou o encerramento no local."
        },
        {
          "id": "entregue",
          "label": "Entregue após reparo",
          "base_status": "delivered",
          "message": "Registramos a entrega ou o encerramento no local após reparo da solicitação nº {numero}. Obrigado pela preferência!"
        },
        {
          "id": "devolvido_sem_reparo",
          "label": "Devolvido sem reparo",
          "base_status": "cancelled",
          "message": "Registramos a devolução ou o encerramento no local sem reparo da solicitação nº {numero}. Para esclarecer alguma pendência, fale com a equipe."
        },
        {
          "id": "cancelado",
          "label": "Cancelado",
          "base_status": "cancelled",
          "message": "Solicitação nº {numero} cancelada. Para esclarecer alguma pendência, fale com a equipe."
        }
      ],
      "retired_stage_ids": [],
      "initial_stage": "recebido",
      "transitions": [
        {
          "id": "recebido_analise",
          "from": "recebido",
          "to": "analise",
          "label": "Em avaliação",
          "kind": "manual"
        },
        {
          "id": "recebido_cancelado",
          "from": "recebido",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "analise_cancelado",
          "from": "analise",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "orcamento_cancelado",
          "from": "orcamento",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "aprovado_execucao",
          "from": "aprovado",
          "to": "execucao",
          "label": "Em execução",
          "kind": "manual"
        },
        {
          "id": "aprovado_cancelado",
          "from": "aprovado",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "recusado_analise",
          "from": "recusado",
          "to": "analise",
          "label": "Em avaliação",
          "kind": "manual"
        },
        {
          "id": "devolver_sem_reparo",
          "from": "recusado",
          "to": "devolvido_sem_reparo",
          "label": "Confirmar devolução sem reparo e registrar destinação",
          "kind": "manual"
        },
        {
          "id": "recusado_cancelado",
          "from": "recusado",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "execucao_pronto",
          "from": "execucao",
          "to": "pronto",
          "label": "Atendimento finalizado",
          "kind": "manual"
        },
        {
          "id": "execucao_cancelado",
          "from": "execucao",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "pronto_entregue",
          "from": "pronto",
          "to": "entregue",
          "label": "Entregue ou encerrado",
          "kind": "manual"
        },
        {
          "id": "pronto_execucao",
          "from": "pronto",
          "to": "execucao",
          "label": "Em execução",
          "kind": "manual"
        },
        {
          "id": "pronto_cancelado",
          "from": "pronto",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        }
      ],
      "features": {
        "customer_open": true,
        "tasks": true,
        "people": true,
        "documents": true,
        "entries": true,
        "quote": {
          "default_valid_days": 7,
          "source_stages": [
            "recebido",
            "analise",
            "orcamento",
            "recusado"
          ],
          "sent_stage": "orcamento",
          "approved_stage": "aprovado",
          "declined_stage": "recusado",
          "edited_stage": "analise"
        },
        "warranty_days": 90,
        "pickup_reminder_days": 3,
        "stale_days": 7
      },
      "pickup_reminder_text": "Lembrete: o atendimento nº {numero} aguarda retirada. Fale com a equipe para combinar.",
      "object_type_id": "veiculo",
      "stage_field_rules": [
        {
          "field_id": "quilometragem",
          "required_on_exit": [
            "recebido"
          ]
        },
        {
          "field_id": "servico_executado",
          "required_from_stage": "pronto"
        }
      ],
      "list_fields": [
        {
          "ref": {
            "scope": "object",
            "field_id": "placa"
          },
          "column": true,
          "filter": true
        },
        {
          "ref": {
            "scope": "object",
            "field_id": "marca_modelo"
          },
          "column": true
        },
        {
          "ref": {
            "scope": "order",
            "field_id": "quilometragem"
          },
          "column": true
        }
      ]
    },
    {
      "schema_version": 1,
      "kind": "custom",
      "id": "at_roupas",
      "revision": 1,
      "archived": false,
      "labels": {
        "singular": "Serviço de roupa",
        "plural": "Serviços de roupas",
        "item": "Peça ou lote",
        "problem": "Serviço solicitado",
        "customer_singular": "Cliente",
        "customer_plural": "Clientes"
      },
      "number_prefix": "PEC",
      "terms": "Solicito o serviço descrito. A equipe confirmará a quantidade de peças, o valor e a data de entrega antes da execução. Qualquer serviço adicional depende de nova combinação. As condições das peças serão registradas no recebimento.",
      "fields": [
        {
          "id": "modalidade",
          "label": "Serviço",
          "help": "",
          "required": true,
          "client_visible": true,
          "sensitive": false,
          "kind": "choice",
          "options": [
            {
              "id": "lavagem",
              "label": "lavagem"
            },
            {
              "id": "passadoria",
              "label": "passadoria"
            },
            {
              "id": "ajuste",
              "label": "ajuste"
            },
            {
              "id": "conserto",
              "label": "conserto"
            }
          ]
        },
        {
          "id": "quantidade",
          "label": "Quantidade de peças",
          "help": "Informe um número inteiro maior que zero; a equipe conferirá o lote.",
          "required": true,
          "client_visible": true,
          "sensitive": false,
          "kind": "integer",
          "min": 1,
          "max": 2147483647
        },
        {
          "id": "valor_combinado",
          "label": "Valor combinado",
          "help": "",
          "required": false,
          "client_visible": true,
          "sensitive": false,
          "kind": "decimal",
          "min": 0,
          "max": 1000000000,
          "scale": 2
        },
        {
          "id": "cuidados",
          "label": "Cuidados e observações da peça",
          "help": "",
          "required": false,
          "client_visible": true,
          "sensitive": false,
          "kind": "text",
          "multiline": true,
          "max_length": 2000
        },
        {
          "id": "data_prometida",
          "label": "Data combinada",
          "help": "",
          "required": false,
          "client_visible": true,
          "sensitive": false,
          "kind": "date",
          "min": null,
          "max": null
        }
      ],
      "retired_field_ids": [],
      "stages": [
        {
          "id": "recebido",
          "label": "Recebido",
          "base_status": "received",
          "message": "Solicitação nº {numero} recebida. Vamos conferir as peças, o valor e o prazo."
        },
        {
          "id": "execucao",
          "label": "Em execução",
          "base_status": "in_progress",
          "message": "Iniciamos o serviço nº {numero}, conforme o valor e o prazo combinados."
        },
        {
          "id": "pronto",
          "label": "Pronto para retirada",
          "base_status": "ready",
          "message": "O serviço nº {numero} está pronto para retirada."
        },
        {
          "id": "entregue",
          "label": "Entregue",
          "base_status": "delivered",
          "message": "Registramos a entrega do serviço nº {numero}. Obrigado pela preferência!"
        },
        {
          "id": "cancelado",
          "label": "Cancelado",
          "base_status": "cancelled",
          "message": "O serviço nº {numero} foi cancelado. A equipe combinará a devolução das peças, se necessário."
        }
      ],
      "retired_stage_ids": [],
      "initial_stage": "recebido",
      "transitions": [
        {
          "id": "recebido_execucao",
          "from": "recebido",
          "to": "execucao",
          "label": "Em execução",
          "kind": "manual"
        },
        {
          "id": "recebido_cancelado",
          "from": "recebido",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "execucao_pronto",
          "from": "execucao",
          "to": "pronto",
          "label": "Pronto para retirada",
          "kind": "manual"
        },
        {
          "id": "execucao_cancelado",
          "from": "execucao",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        },
        {
          "id": "pronto_entregue",
          "from": "pronto",
          "to": "entregue",
          "label": "Entregue",
          "kind": "manual"
        },
        {
          "id": "pronto_execucao",
          "from": "pronto",
          "to": "execucao",
          "label": "Em execução",
          "kind": "manual"
        },
        {
          "id": "pronto_cancelado",
          "from": "pronto",
          "to": "cancelado",
          "label": "Cancelado",
          "kind": "manual"
        }
      ],
      "features": {
        "customer_open": true,
        "tasks": true,
        "people": true,
        "documents": true,
        "entries": true,
        "quote": null,
        "warranty_days": 0,
        "pickup_reminder_days": 3,
        "stale_days": 7
      },
      "pickup_reminder_text": "Lembrete: o serviço nº {numero} está pronto para retirada."
    }
  ],
  "modules": {
    "os": true,
    "payments": false,
    "agenda": false,
    "mensalidade": false,
    "forms": false,
    "reserva": false,
    "erp": true,
    "erp-produtos": true,
    "erp-vendas": true,
    "erp-compras": false,
    "erp-estoque": true,
    "erp-financeiro": true,
    "erp-fiscal": true,
    "erp-cobranca": false,
    "erp-pdv": false
  },
  "vocabulary": {
    "collection_label": "Atendimentos",
    "customer_singular": "Cliente",
    "customer_plural": "Clientes"
  },
  "departments": [
    {
      "id": "recepcao",
      "name": "Recepção",
      "members": [],
      "enabled": true
    },
    {
      "id": "tecnica",
      "name": "Técnica",
      "members": [],
      "enabled": true
    },
    {
      "id": "financeiro",
      "name": "Financeiro",
      "members": [],
      "enabled": true
    }
  ],
  "ticket_categories": [
    {
      "id": "abertura",
      "name": "Abertura",
      "enabled": true
    },
    {
      "id": "prazo",
      "name": "Prazo",
      "enabled": true
    },
    {
      "id": "retirada",
      "name": "Retirada",
      "enabled": true
    },
    {
      "id": "agendamento",
      "name": "Agendamento",
      "enabled": true
    },
    {
      "id": "diagnostico",
      "name": "Diagnóstico",
      "enabled": true
    },
    {
      "id": "reparo",
      "name": "Reparo",
      "enabled": true
    },
    {
      "id": "retrabalho",
      "name": "Retrabalho",
      "enabled": true
    },
    {
      "id": "garantia",
      "name": "Garantia",
      "enabled": true
    },
    {
      "id": "cobranca",
      "name": "Cobrança",
      "enabled": true
    },
    {
      "id": "desconto",
      "name": "Desconto",
      "enabled": true
    },
    {
      "id": "comprovante",
      "name": "Comprovante",
      "enabled": true
    },
    {
      "id": "estorno",
      "name": "Estorno",
      "enabled": true
    }
  ],
  "menus": [
    {
      "id": "at_abrir",
      "label": "Abrir ordem de serviço",
      "type": "os_open",
      "type_id": "service_order"
    },
    {
      "id": "at_acompanhar",
      "label": "Acompanhar ordem de serviço",
      "type": "os_track",
      "type_id": "service_order"
    },
    {
      "id": "at_equipe",
      "label": "Falar com a equipe",
      "type": "human",
      "department_id": "recepcao"
    },
    {
      "id": "tipo_1_abrir",
      "label": "Reparo de eletrônico",
      "type": "os_open",
      "type_id": "at_eletronicos"
    },
    {
      "id": "tipo_1_acompanhar",
      "label": "Reparos de eletrônicos",
      "type": "os_track",
      "type_id": "at_eletronicos"
    },
    {
      "id": "tipo_2_abrir",
      "label": "Reparo de eletrodoméstico",
      "type": "os_open",
      "type_id": "at_eletrodomesticos"
    },
    {
      "id": "tipo_2_acompanhar",
      "label": "Reparos de eletrodomésticos",
      "type": "os_track",
      "type_id": "at_eletrodomesticos"
    },
    {
      "id": "tipo_3_abrir",
      "label": "Serviço de oficina",
      "type": "os_open",
      "type_id": "at_veiculos"
    },
    {
      "id": "tipo_3_acompanhar",
      "label": "Serviços de oficina",
      "type": "os_track",
      "type_id": "at_veiculos"
    },
    {
      "id": "tipo_4_abrir",
      "label": "Serviço de roupa",
      "type": "os_open",
      "type_id": "at_roupas"
    },
    {
      "id": "tipo_4_acompanhar",
      "label": "Serviços de roupas",
      "type": "os_track",
      "type_id": "at_roupas"
    }
  ],
  "texts": {},
  "bot": {
    "instructions": "Você atende uma assistência técnica. Use frases curtas e claras. Siga as operações e os dados autorizados pelo administrador, com configuração inicial conservadora. Pelo WhatsApp, use a identidade autenticada da conversa para abrir e acompanhar somente os atendimentos e objetos do próprio cliente; telefone, placa ou série informados não provam propriedade. Para novo objeto, use o formulário autorizado. Informe apenas etapas, previsões e valores obtidos pelas ferramentas autorizadas. Não invente diagnóstico, preço, prazo ou disponibilidade de peça. Encaminhe a aprovação ou recusa ao mecanismo próprio do orçamento; não trate uma conversa vaga como aprovação. Para visitas, use apenas a Agenda configurada e peça confirmação do cliente. Desconto, mudança de escopo, prioridade e garantia precisam de avaliação da equipe. Não peça senhas, PIN, código de desbloqueio, token ou dados bancários. Respeite a classificação dos campos e as permissões de documentos; a conversa do cliente só recebe informações liberadas para ele. Não confirme pagamento por fotografia de comprovante. Quando faltar informação ou houver reclamação sobre dano, encaminhe à equipe.",
    "allowed_operations": [],
    "denied_operations": [],
    "suggested_roles": [
      "os:technician"
    ]
  },
  "manual_steps": [
    "Revisar na prévia Cadastros, Produtos e serviços, Vendas, Estoque, Financeiro, Fiscal e Ordens de serviço. O modelo apenas configura módulos; não concede papéis nem segundo fator de autenticação.",
    "A ponte operacional de Ordens de serviço (os) para estoque, financeiro e fiscal ainda não está entregue por este modelo. Conferir e registrar manualmente peças consumidas, títulos e documentos fiscais, evitando duplicidade. As ordens de serviço comerciais antigas continuam em Vendas; seus registros não são migrados para os.",
    "Configurar empresa, certificado, emissor, numeração e tributos conforme as funcionalidades fiscais disponíveis. A emissão automática de notas a partir de os ainda não está entregue; ligar Fiscal não habilita capacidades ausentes nem substitui a conferência antes de emitir.",
    "PDV e Cobrança bancária permanecem desligados na proposta padrão. Para ligá-los, escolher explicitamente em Módulos ou revisar um manifesto: PDV exige Cadastros, Produtos e serviços, Vendas, Estoque e Financeiro; Cobrança exige Cadastros e Financeiro. Conferir toda a seleção antes de aplicar.",
    "Agenda, Formulários, Pagamentos, Mensalidades, Reservas e Compras são escolhas independentes. Uma opção com valor false propõe desligamento apenas se selecionada; para ativá-la, usar Módulos ou um manifesto revisado. Opções não selecionadas e escolhas locais de reaplicações são preservadas.",
    "Escolher os tipos adicionais que serão publicados.",
    "Selecionar ou cadastrar equipamento ou veículo do contato confirmado. Placa, série e identificação administrativa não comprovam propriedade. Eletrônicos e eletrodomésticos usam tipos distintos; a série ou IMEI continua sensível e opcional. Modelos sem objeto e a Ordem de serviço embutida mantêm o fluxo atual.",
    "Na atualização do padrão, revisar a prévia de campos movidos, requisitos e conflitos. Os campos retirados da ordem são aposentados; nenhuma ordem, placa privada ou valor anterior é convertido ou copiado. Cadastre expressamente os dados do novo objeto e preserve personalizações até resolver conflitos.",
    "Oficina: completar a quilometragem antes de sair de Recebido. Combustível na entrada e última manutenção informada pelo cliente continuam nesta ordem. Nos três modelos de reparo, registrar o serviço executado antes de Reparo concluído; cancelamento e devolução sem reparo permanecem possíveis sem esse preenchimento.",
    "Revisar no administrador as operações e os dados disponíveis aos bots e à IA, inicialmente com configuração conservadora; o manifesto não ativa IA nem concede acesso. Clientes e WhatsApp recebem apenas os próprios dados autorizados.",
    "Revisar termos, taxas, validade do orçamento e garantia. Nos tipos de reparo, a garantia de 90 dias começa somente em Entregue após reparo. Após recusa, confirmar devolução ou encerramento no local e registrar motivo e destinação em lançamento antes de usar Devolvido sem reparo, que encerra sem iniciar garantia. Classificar dados pessoais como sensíveis.",
    "Enquanto aguarda devolução sem reparo, manter Recusado e acompanhar por tarefa manual, sem lembrete automático de retirada. Reservar Reparo concluído e Entregue após reparo ao serviço executado. Uma nova execução após recusa exige reavaliação e aprovação do orçamento.",
    "Associar pessoas aos setores e conferir acessos.",
    "Configurar cobrança e confirmação do provedor.",
    "Cadastrar profissionais, horários e região atendida quando houver visita.",
    "Definir conferência de documentos e retirada por terceiros.",
    "Configurar notificação da linha oficial.",
    "Revisar o menu preservando itens existentes.",
    "Simular o atendimento antes de ativar.",
    "Reparo de eletrônico: cadastrar e acompanhar manualmente as tarefas sugeridas: Conferir equipamento, acessórios e estado de entrada (0 dia(s) após a entrada na etapa recebido); Registrar diagnóstico e preparar orçamento (2 dia(s) após a entrada na etapa analise); Executar reparo e registrar testes (2 dia(s) após a entrada na etapa execucao); Conferir resultado e combinar retirada (0 dia(s) após a entrada na etapa pronto).",
    "Reparo de eletrônico: conferir o resultado antes de finalizar e registrar a devolução dos bens recebidos antes de cancelar. Papéis de pessoas sugeridos: Proprietário, Pessoa autorizada a retirar. Lançamentos sugeridos: Diagnóstico, Reparo, Teste, Horas.",
    "Reparo de eletrodoméstico: cadastrar e acompanhar manualmente as tarefas sugeridas: Confirmar modalidade e dados da visita (0 dia(s) após a entrada na etapa recebido); Vincular visita e registrar diagnóstico (1 dia(s) após a entrada na etapa analise); Registrar execução e teste funcional (1 dia(s) após a entrada na etapa execucao); Confirmar encerramento no local ou devolução (0 dia(s) após a entrada na etapa pronto).",
    "Reparo de eletrodoméstico: conferir o resultado antes de finalizar e registrar a devolução dos bens recebidos antes de cancelar. Papéis de pessoas sugeridos: Contratante, Contato no local. Lançamentos sugeridos: Visita, Diagnóstico, Execução, Horas.",
    "Serviço de oficina: cadastrar e acompanhar manualmente as tarefas sugeridas: Conferir placa, quilometragem e avarias (0 dia(s) após a entrada na etapa recebido); Registrar diagnóstico, peças e mão de obra (1 dia(s) após a entrada na etapa analise); Registrar peças aplicadas e verificações finais (2 dia(s) após a entrada na etapa execucao); Conferir resultado e combinar retirada (0 dia(s) após a entrada na etapa pronto).",
    "Serviço de oficina: conferir o resultado antes de finalizar e registrar a devolução dos bens recebidos antes de cancelar. Papéis de pessoas sugeridos: Proprietário, Condutor, Pessoa autorizada a retirar. Lançamentos sugeridos: Diagnóstico, Peça aplicada, Mão de obra, Teste.",
    "Serviço de roupa: cadastrar e acompanhar manualmente as tarefas sugeridas: Conferir peças, valor e prazo (0 dia(s) após a entrada na etapa recebido); Conferir qualidade (2 dia(s) após a entrada na etapa execucao); Conferir lote para entrega (0 dia(s) após a entrada na etapa pronto).",
    "Serviço de roupa: conferir o resultado antes de finalizar e registrar a devolução dos bens recebidos antes de cancelar. Papéis de pessoas sugeridos: Contratante, Pessoa autorizada a retirar. Lançamentos sugeridos: Lavagem, Passadoria, Ajuste, Retrabalho.",
    "O tipo embutido usa as configurações atuais de service_orders. Revise-as no painel sem copiar os padrões deste documento.",
    "A paralisação dos tipos adicionais usa 7 dias por tipo; os prazos por etapa do rascunho devem ser acompanhados por tarefas manuais.",
    "Agenda e formulário de avaliação são opcionais: configure-os manualmente, incluindo profissionais, horários, serviços e perguntas.",
    "Visita domiciliar: confirmar endereço em canal protegido e vincular o agendamento manualmente antes da visita. Lavanderia: confirmar preço e data combinados antes da execução.",
    "Classifique documentos individualmente: fotos de entrada/saída, relatórios e termos só podem ser enviados se públicos e não sensíveis; diagnósticos internos permanecem restritos."
  ],
  "object_types": [equipamentoEletronicoObjectType, eletrodomesticoObjectType, veiculoObjectType]
};
