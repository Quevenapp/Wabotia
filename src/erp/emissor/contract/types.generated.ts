// GERADO por src/erp/emissor/contract/sync.mjs a partir de contract/openapi.json.
// Não edite à mão: copie o contrato novo e rode o sync (README.md desta pasta).
// Cofre NFapi 0.9.1 (OpenAPI 3.1.0).
/* eslint-disable */

export const CONTRACT_VERSION = "0.9.1";

export type Erro = {
  erro: {
    /** Código estável do erro; a tabela está em `x-codigos`. Novos códigos podem surgir em versões novas: trate um código desconhecido pelo status HTTP. */
    codigo: string;
    mensagem: string;
  };
  /** Em erros de validação da NF-e e NFC-e: o campo recusado. */
  campo?: string | null;
  nfe?: EmissaoNfe;
  nfce?: EmissaoNfe;
  nfse?: EmissaoNfse;
  /** Código e descrição devolvidos pelo governo (na NF-e e NFC-e, cStat e xMotivo) ou pelo cofre. */
  mensagens?: {
    codigo: string;
    descricao: string;
  }[];
};

export type Cabecalho = {
  /** default: homologacao */
  ambiente?: "homologacao" | "producao";
  /**
   * Identificador do pedido no seu sistema. Repetir a referência com o mesmo conteúdo devolve a mesma emissão; com conteúdo diferente, o cofre recusa (409 referencia_com_conteudo_diferente). Só uma nota rejeitada pode ser reenviada corrigida com a mesma referência.
   * pattern: ^[A-Za-z0-9._:-]{1,80}$
   */
  referencia?: string;
};

export type PedidoNfe = Cabecalho & {
  /**
   * Série cadastrada no cofre. Pode ser omitida quando só há uma para o modelo e o ambiente.
   * minimum: 0; maximum: 889
   */
  serie?: number;
  /** minLength: 1; maxLength: 60 */
  naturezaOperacao: string;
  /**
   * Prefira omitir: o cofre usa a hora da emissão, no fuso da UF. Se for informada, entra na comparação de conteúdo da referência, e uma NFC-e com data antiga é rejeitada pela SEFAZ.
   * pattern: ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$
   */
  dataEmissao?: string;
  /** default: normal */
  finalidade?: "normal" | "complementar" | "ajuste" | "devolucao";
  /** maxItems: 999 */
  notasReferenciadas?: string[];
  intermediador?: {
    /** pattern: ^[0-9A-Z]{12}\d{2}$ */
    cnpj: string;
    /** minLength: 2; maxLength: 60 */
    identificacao: string;
  };
  emitente: {
    /** pattern: ^[0-9A-Z]{12}\d{2}$ */
    cnpj?: string;
    /** minLength: 2; maxLength: 60 */
    nome: string;
    /** minLength: 1; maxLength: 60 */
    fantasia?: string;
    /** pattern: ^\d{2,14}$ */
    inscricaoEstadual: string;
    /** minLength: 1; maxLength: 15 */
    inscricaoMunicipal?: string;
    /** pattern: ^\d{7}$ */
    cnae?: string;
    regime: "simples_nacional" | "simples_excesso" | "normal" | "mei";
    endereco: {
      /** minLength: 2; maxLength: 60 */
      logradouro: string;
      /** minLength: 1; maxLength: 60 */
      numero: string;
      /** minLength: 1; maxLength: 60 */
      complemento?: string;
      /** minLength: 2; maxLength: 60 */
      bairro: string;
      /** pattern: ^\d{7}$ */
      codigoMunicipio: string;
      /** minLength: 2; maxLength: 60 */
      municipio: string;
      uf: "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA" | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN" | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO";
      /** pattern: ^\d{8}$ */
      cep: string;
      /** pattern: ^\d{6,14}$ */
      telefone?: string;
    };
  };
  /** minItems: 1; maxItems: 990 */
  itens: {
    /** minLength: 1; maxLength: 60 */
    codigo: string;
    /** pattern: ^(\d{8}|\d{12,14})$ */
    ean?: string;
    /** minLength: 1; maxLength: 120 */
    descricao: string;
    /** pattern: ^(\d{2}|\d{8})$ */
    ncm: string;
    /** pattern: ^\d{7}$ */
    cest?: string;
    /** pattern: ^([A-Za-z0-9]{8}|[A-Za-z0-9]{10}|SEM CBENEF)$ */
    codigoBeneficioFiscal?: string;
    /** pattern: ^\d{4}$ */
    cfop: string;
    /** minLength: 1; maxLength: 6 */
    unidade: string;
    /** maximum: 99999999999.9999; exclusiveMinimum: 0 */
    quantidade: number;
    /** minimum: 0; maximum: 100000000000 */
    valorUnitario: number;
    /** minimum: 0; maximum: 9999999999999.99 */
    valorTotal?: number;
    tributavel?: {
      /** pattern: ^(\d{8}|\d{12,14})$ */
      ean?: string;
      /** minLength: 1; maxLength: 6 */
      unidade: string;
      /** maximum: 99999999999.9999; exclusiveMinimum: 0 */
      quantidade: number;
      /** minimum: 0; maximum: 100000000000 */
      valorUnitario: number;
    };
    /** minimum: 0; maximum: 9999999999999.99 */
    frete?: number;
    /** minimum: 0; maximum: 9999999999999.99 */
    seguro?: number;
    /** minimum: 0; maximum: 9999999999999.99 */
    desconto?: number;
    /** minimum: 0; maximum: 9999999999999.99 */
    outrasDespesas?: number;
    /** default: true */
    compoeTotal?: boolean;
    /** maxItems: 100 */
    importacao?: {
      /** minLength: 1; maxLength: 15 */
      numero: string;
      /** pattern: ^\d{4}-\d{2}-\d{2}$ */
      data: string;
      /** minLength: 1; maxLength: 60 */
      localDesembaraco: string;
      ufDesembaraco: "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA" | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN" | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO";
      /** pattern: ^\d{4}-\d{2}-\d{2}$ */
      dataDesembaraco: string;
      /** minimum: 1; maximum: 13 */
      viaTransporte: number;
      /** minimum: 0; maximum: 9999999999999.99 */
      afrmm?: number;
      /** default: conta_propria */
      intermediacao?: "conta_propria" | "conta_e_ordem" | "encomenda";
      adquirente?: {
        /** pattern: ^[0-9A-Z]{12}\d{2}$ */
        cnpj?: string;
        /** pattern: ^\d{11}$ */
        cpf?: string;
        uf?: "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA" | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN" | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO";
      };
      /** minLength: 1; maxLength: 60 */
      codigoExportador: string;
      /** minItems: 1; maxItems: 999 */
      adicoes: {
        /** minimum: 1; maximum: 999 */
        numero?: number;
        /** minimum: 1; maximum: 99999 */
        sequencia: number;
        /** minLength: 1; maxLength: 60 */
        codigoFabricante: string;
        /** maximum: 9999999999999.99; exclusiveMinimum: 0 */
        desconto?: number;
        /** minLength: 1; maxLength: 20 */
        drawback?: string;
      }[];
    }[];
    /** maxItems: 500 */
    exportacao?: {
      /** minLength: 1; maxLength: 20 */
      drawback?: string;
      indireta?: {
        /** pattern: ^\d{0,12}$ */
        registroExportacao: string;
        /** pattern: ^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$ */
        chaveNfe: string;
        /** minimum: 0; maximum: 99999999999.9999 */
        quantidade: number;
      };
    }[];
    /** minLength: 1; maxLength: 15 */
    numeroPedido?: string;
    /** minimum: 0; maximum: 999999 */
    itemPedido?: number;
    /** minLength: 1; maxLength: 500 */
    informacoesAdicionais?: string;
    impostos: {
      /** minimum: 0; maximum: 9999999999999.99 */
      valorAproximadoTributos?: number;
      icms: {
        /** minimum: 0; maximum: 8; default: 0 */
        origem?: number;
        cst?: "10" | "20" | "30" | "40" | "41" | "50" | "51" | "60" | "70" | "90" | "00";
        csosn?: "101" | "102" | "103" | "201" | "202" | "203" | "300" | "400" | "500" | "900";
        /** minimum: 0; maximum: 3 */
        modalidadeBc?: number;
        /** minimum: 0; maximum: 999.9999 */
        reducaoBc?: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo?: number;
        /** minimum: 0; maximum: 999.9999 */
        aliquota?: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        valor?: number;
        fcp?: {
          /** minimum: 0; maximum: 9999999999999.99 */
          baseCalculo?: number;
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
        };
        st?: {
          /** minimum: 0; maximum: 6 */
          modalidadeBc: number;
          /** minimum: 0; maximum: 999.9999 */
          mva?: number;
          /** minimum: 0; maximum: 999.9999 */
          reducaoBc?: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          baseCalculo: number;
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
          fcp?: {
            /** minimum: 0; maximum: 9999999999999.99 */
            baseCalculo?: number;
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
        };
        desoneracao?: {
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
          /** minimum: 1; maximum: 99 */
          motivo: number;
          /** default: false */
          deduzDoTotal?: boolean;
        };
        diferimento?: {
          /** minimum: 0; maximum: 9999999999999.99 */
          valorOperacao: number;
          /** minimum: 0; maximum: 999.9999 */
          percentual: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valorDiferido: number;
        };
        creditoSimples?: {
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
        };
        retidoAnteriormente?: {
          /** minimum: 0; maximum: 9999999999999.99 */
          baseCalculo: number;
          /** minimum: 0; maximum: 999.9999 */
          aliquotaConsumidorFinal: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valorSubstituto?: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
          fcp?: {
            /** minimum: 0; maximum: 9999999999999.99 */
            baseCalculo: number;
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
        };
      };
      ipi?: {
        cst: "49" | "50" | "51" | "52" | "53" | "54" | "55" | "99" | "00" | "01" | "02" | "03" | "04" | "05";
        /** pattern: ^\d{1,3}$; default: 999 */
        codigoEnquadramento?: string;
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo?: number;
        /** minimum: 0; maximum: 999.9999 */
        aliquota?: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        valor?: number;
      };
      ii?: {
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        despesasAduaneiras: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        valor: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        iof: number;
      };
      pis?: {
        /** pattern: ^(0[1-9]|49|5[0-6]|6[0-7]|7[0-5]|98|99)$ */
        cst: string;
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo?: number;
        /** minimum: 0; maximum: 999.9999 */
        aliquota?: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        valor?: number;
      };
      cofins?: {
        /** pattern: ^(0[1-9]|49|5[0-6]|6[0-7]|7[0-5]|98|99)$ */
        cst: string;
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo?: number;
        /** minimum: 0; maximum: 999.9999 */
        aliquota?: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        valor?: number;
      };
      /** IBS e CBS do item, como calculados pelo sistema emissor. Sem baseCalculo, vão só o CST e a classificação. Não há suporte ao regime monofásico (combustíveis), à transferência de crédito, ao ajuste de competência nem ao crédito presumido da Zona Franca de Manaus. */
      ibsCbs?: {
        /** pattern: ^\d{3}$ */
        cst: string;
        /** pattern: ^\d{6}$ */
        classificacao: string;
        doacao?: boolean;
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo?: number;
        ibsUf?: {
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
          diferimento?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          devolucao?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual?: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          reducao?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual: number;
            /** minimum: 0; maximum: 999.9999 */
            aliquotaEfetiva: number;
          };
        };
        ibsMunicipio?: {
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
          diferimento?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          devolucao?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual?: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          reducao?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual: number;
            /** minimum: 0; maximum: 999.9999 */
            aliquotaEfetiva: number;
          };
        };
        cbs?: {
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
          diferimento?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          devolucao?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual?: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          reducao?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual: number;
            /** minimum: 0; maximum: 999.9999 */
            aliquotaEfetiva: number;
          };
        };
        tributacaoRegular?: {
          /** pattern: ^\d{3}$ */
          cst: string;
          /** pattern: ^\d{6}$ */
          classificacao: string;
          ibsUf: {
            /** minimum: 0; maximum: 999.9999 */
            aliquotaEfetiva: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          ibsMunicipio: {
            /** minimum: 0; maximum: 999.9999 */
            aliquotaEfetiva: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          cbs: {
            /** minimum: 0; maximum: 999.9999 */
            aliquotaEfetiva: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
        };
        compraGovernamental?: {
          ibsUf: {
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          ibsMunicipio: {
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          cbs: {
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
        };
        simplesNacional?: {
          ibs?: {
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          cbs: {
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
        };
        estornoCredito?: {
          /** minimum: 0; maximum: 9999999999999.99 */
          ibs: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          cbs: number;
        };
        creditoPresumido?: {
          /** minimum: 0; maximum: 9999999999999.99 */
          baseCalculo: number;
          /** pattern: ^\d{2}$ */
          codigo: string;
          ibs?: {
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
            /** default: false */
            condicaoSuspensiva?: boolean;
          };
          cbs?: {
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
            /** default: false */
            condicaoSuspensiva?: boolean;
          };
        };
      };
      impostoSeletivo?: {
        /** pattern: ^\d{3}$ */
        cst: string;
        /** pattern: ^\d{6}$ */
        classificacao: string;
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo?: number;
        /** minimum: 0; maximum: 999.9999 */
        aliquota?: number;
        /** minimum: 0; maximum: 999.9999 */
        aliquotaEspecifica?: number;
        /** minLength: 1; maxLength: 6 */
        unidade?: string;
        /** minimum: 0; maximum: 99999999999.9999 */
        quantidade?: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        valor?: number;
      };
      difal?: {
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo: number;
        /** minimum: 0; maximum: 999.9999 */
        aliquotaInterna: number;
        /** minimum: 0; maximum: 999.9999 */
        aliquotaInterestadual: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        valorDestino: number;
        fcp?: {
          /** minimum: 0; maximum: 9999999999999.99 */
          baseCalculo?: number;
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
        };
      };
    };
  }[];
  /** minItems: 1; maxItems: 100 */
  pagamentos: {
    /** pattern: ^\d{2}$ */
    forma: string;
    /** minimum: 0; maximum: 9999999999999.99 */
    valor: number;
    /** minLength: 2; maxLength: 60 */
    descricao?: string;
    indicador?: "a_vista" | "a_prazo";
    cartao?: {
      /** default: nao_integrado */
      integracao?: "integrado" | "nao_integrado";
      /** pattern: ^[0-9A-Z]{12}\d{2}$ */
      cnpjCredenciadora?: string;
      /** pattern: ^\d{2}$ */
      bandeira?: string;
      /** minLength: 1; maxLength: 128 */
      autorizacao?: string;
    };
  }[];
  /** minimum: 0; maximum: 9999999999999.99 */
  troco?: number;
  /** minLength: 1; maxLength: 5000 */
  informacoesComplementares?: string;
  /** minLength: 1; maxLength: 2000 */
  informacoesFisco?: string;
  responsavelTecnico?: {
    /** pattern: ^[0-9A-Z]{12}\d{2}$ */
    cnpj: string;
    /** minLength: 2; maxLength: 60 */
    contato: string;
    /** format: email; pattern: ^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$; minLength: 6; maxLength: 60 */
    email: string;
    /** pattern: ^\d{6,14}$ */
    telefone: string;
  };
  /** default: saida */
  tipo?: "saida" | "entrada";
  /** pattern: ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$ */
  dataSaida?: string;
  /** default: false */
  consumidorFinal?: boolean;
  presenca: "nao_se_aplica" | "presencial" | "internet" | "teleatendimento" | "entrega_domicilio" | "presencial_fora" | "outros";
  destinoOperacao?: "interna" | "interestadual" | "exterior";
  destinatario: {
    /** pattern: ^[0-9A-Z]{12}\d{2}$ */
    cnpj?: string;
    /** pattern: ^\d{11}$ */
    cpf?: string;
    /**
     * Passaporte ou outro documento do estrangeiro. Use "" quando não houver documento.
     * pattern: ^([A-Za-z0-9]{5,20})?$
     */
    idEstrangeiro?: string;
    /** minLength: 2; maxLength: 60 */
    nome?: string;
    /** default: nao_contribuinte */
    indicadorIe?: "contribuinte" | "isento" | "nao_contribuinte";
    /** pattern: ^\d{2,14}$ */
    inscricaoEstadual?: string;
    /** format: email; pattern: ^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$; maxLength: 60 */
    email?: string;
    endereco?: {
      /** minLength: 2; maxLength: 60 */
      logradouro: string;
      /** minLength: 1; maxLength: 60 */
      numero: string;
      /** minLength: 1; maxLength: 60 */
      complemento?: string;
      /** minLength: 2; maxLength: 60 */
      bairro: string;
      /** pattern: ^\d{7}$ */
      codigoMunicipio: string;
      /** minLength: 2; maxLength: 60 */
      municipio: string;
      /** UF do destinatário. No exterior: "EX", com codigoMunicipio "9999999" e municipio "EXTERIOR". */
      uf: "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA" | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN" | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO" | "EX";
      /** pattern: ^\d{8}$ */
      cep?: string;
      /** pattern: ^\d{6,14}$ */
      telefone?: string;
      /**
       * Código do país na tabela do Banco Central (padrão: 1058, Brasil).
       * pattern: ^\d{1,4}$
       */
      codigoPais?: string;
      /**
       * Nome do país (padrão: Brasil).
       * minLength: 1; maxLength: 60
       */
      pais?: string;
    };
  };
  exportacao?: {
    ufEmbarque: "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA" | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN" | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO";
    /** minLength: 1; maxLength: 60 */
    localEmbarque: string;
    /** minLength: 1; maxLength: 60 */
    localDespacho?: string;
  };
  /** default: {"modalidade":9} */
  transporte?: {
    /** default: 9 */
    modalidade?: 0 | 1 | 2 | 3 | 4 | 9;
    transportadora?: {
      /** pattern: ^[0-9A-Z]{12}\d{2}$ */
      cnpj?: string;
      /** pattern: ^\d{11}$ */
      cpf?: string;
      /** minLength: 2; maxLength: 60 */
      nome?: string;
      /** pattern: ^\d{2,14}$ */
      inscricaoEstadual?: string;
      /** minLength: 1; maxLength: 60 */
      endereco?: string;
      /** minLength: 1; maxLength: 60 */
      municipio?: string;
      uf?: "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA" | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN" | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO";
    };
    veiculo?: {
      /** pattern: ^[A-Z]{2,3}[0-9]{4}$|^[A-Z]{3,4}[0-9]{3}$|^[A-Z0-9]{7}$ */
      placa: string;
      uf?: "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA" | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN" | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO";
      /** minLength: 1; maxLength: 20 */
      rntc?: string;
    };
    /** maxItems: 5000 */
    volumes?: {
      /** minimum: 0; maximum: 9007199254740991 */
      quantidade?: number;
      /** minLength: 1; maxLength: 60 */
      especie?: string;
      /** minLength: 1; maxLength: 60 */
      marca?: string;
      /** minLength: 1; maxLength: 60 */
      numeracao?: string;
      /** minimum: 0 */
      pesoLiquido?: number;
      /** minimum: 0 */
      pesoBruto?: number;
    }[];
  };
  cobranca?: {
    fatura?: {
      /** minLength: 1; maxLength: 60 */
      numero: string;
      /** minimum: 0; maximum: 9999999999999.99 */
      valorOriginal: number;
      /** minimum: 0; maximum: 9999999999999.99 */
      desconto?: number;
      /** minimum: 0; maximum: 9999999999999.99 */
      valorLiquido: number;
    };
    /** maxItems: 120 */
    duplicatas?: {
      /** minLength: 1; maxLength: 60 */
      numero: string;
      /** pattern: ^\d{4}-\d{2}-\d{2}$ */
      vencimento: string;
      /** minimum: 0; maximum: 9999999999999.99 */
      valor: number;
    }[];
  };
};

export type OpcoesNfce = {
  /**
   * O que fazer quando a SEFAZ não responde. `automatica`: o cofre espera até 20 segundos e, sem resposta conclusiva, emite a nota em contingência offline (tipo de emissão 9), com número novo, e a devolve com `situacao: "contingencia"` para o caixa imprimir; enquanto a SEFAZ segue fora, as vendas seguintes saem direto em contingência. `forcada`: emite direto em contingência. `nunca`: devolve 502. O cofre transmite as notas pendentes sozinho quando a SEFAZ volta. Não entra na comparação de conteúdo da referência. O DANFCE da nota em contingência tem textos e vias próprios, e o prazo legal de transmissão é o fim do primeiro dia útil seguinte.
   * default: nunca
   */
  contingencia?: "nunca" | "automatica" | "forcada";
};

export type PedidoNfce = Cabecalho & OpcoesNfce & {
  /**
   * Série cadastrada no cofre. Pode ser omitida quando só há uma para o modelo e o ambiente.
   * minimum: 0; maximum: 889
   */
  serie?: number;
  /** minLength: 1; maxLength: 60 */
  naturezaOperacao: string;
  /**
   * Prefira omitir: o cofre usa a hora da emissão, no fuso da UF. Se for informada, entra na comparação de conteúdo da referência, e uma NFC-e com data antiga é rejeitada pela SEFAZ.
   * pattern: ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$
   */
  dataEmissao?: string;
  /** default: normal */
  finalidade?: "normal" | "complementar" | "ajuste" | "devolucao";
  /** maxItems: 999 */
  notasReferenciadas?: string[];
  intermediador?: {
    /** pattern: ^[0-9A-Z]{12}\d{2}$ */
    cnpj: string;
    /** minLength: 2; maxLength: 60 */
    identificacao: string;
  };
  emitente: {
    /** pattern: ^[0-9A-Z]{12}\d{2}$ */
    cnpj?: string;
    /** minLength: 2; maxLength: 60 */
    nome: string;
    /** minLength: 1; maxLength: 60 */
    fantasia?: string;
    /** pattern: ^\d{2,14}$ */
    inscricaoEstadual: string;
    /** minLength: 1; maxLength: 15 */
    inscricaoMunicipal?: string;
    /** pattern: ^\d{7}$ */
    cnae?: string;
    regime: "simples_nacional" | "simples_excesso" | "normal" | "mei";
    endereco: {
      /** minLength: 2; maxLength: 60 */
      logradouro: string;
      /** minLength: 1; maxLength: 60 */
      numero: string;
      /** minLength: 1; maxLength: 60 */
      complemento?: string;
      /** minLength: 2; maxLength: 60 */
      bairro: string;
      /** pattern: ^\d{7}$ */
      codigoMunicipio: string;
      /** minLength: 2; maxLength: 60 */
      municipio: string;
      uf: "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA" | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN" | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO";
      /** pattern: ^\d{8}$ */
      cep: string;
      /** pattern: ^\d{6,14}$ */
      telefone?: string;
    };
  };
  /** minItems: 1; maxItems: 990 */
  itens: {
    /** minLength: 1; maxLength: 60 */
    codigo: string;
    /** pattern: ^(\d{8}|\d{12,14})$ */
    ean?: string;
    /** minLength: 1; maxLength: 120 */
    descricao: string;
    /** pattern: ^(\d{2}|\d{8})$ */
    ncm: string;
    /** pattern: ^\d{7}$ */
    cest?: string;
    /** pattern: ^([A-Za-z0-9]{8}|[A-Za-z0-9]{10}|SEM CBENEF)$ */
    codigoBeneficioFiscal?: string;
    /** pattern: ^\d{4}$ */
    cfop: string;
    /** minLength: 1; maxLength: 6 */
    unidade: string;
    /** maximum: 99999999999.9999; exclusiveMinimum: 0 */
    quantidade: number;
    /** minimum: 0; maximum: 100000000000 */
    valorUnitario: number;
    /** minimum: 0; maximum: 9999999999999.99 */
    valorTotal?: number;
    tributavel?: {
      /** pattern: ^(\d{8}|\d{12,14})$ */
      ean?: string;
      /** minLength: 1; maxLength: 6 */
      unidade: string;
      /** maximum: 99999999999.9999; exclusiveMinimum: 0 */
      quantidade: number;
      /** minimum: 0; maximum: 100000000000 */
      valorUnitario: number;
    };
    /** minimum: 0; maximum: 9999999999999.99 */
    frete?: number;
    /** minimum: 0; maximum: 9999999999999.99 */
    seguro?: number;
    /** minimum: 0; maximum: 9999999999999.99 */
    desconto?: number;
    /** minimum: 0; maximum: 9999999999999.99 */
    outrasDespesas?: number;
    /** default: true */
    compoeTotal?: boolean;
    /** maxItems: 100 */
    importacao?: {
      /** minLength: 1; maxLength: 15 */
      numero: string;
      /** pattern: ^\d{4}-\d{2}-\d{2}$ */
      data: string;
      /** minLength: 1; maxLength: 60 */
      localDesembaraco: string;
      ufDesembaraco: "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA" | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN" | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO";
      /** pattern: ^\d{4}-\d{2}-\d{2}$ */
      dataDesembaraco: string;
      /** minimum: 1; maximum: 13 */
      viaTransporte: number;
      /** minimum: 0; maximum: 9999999999999.99 */
      afrmm?: number;
      /** default: conta_propria */
      intermediacao?: "conta_propria" | "conta_e_ordem" | "encomenda";
      adquirente?: {
        /** pattern: ^[0-9A-Z]{12}\d{2}$ */
        cnpj?: string;
        /** pattern: ^\d{11}$ */
        cpf?: string;
        uf?: "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA" | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN" | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO";
      };
      /** minLength: 1; maxLength: 60 */
      codigoExportador: string;
      /** minItems: 1; maxItems: 999 */
      adicoes: {
        /** minimum: 1; maximum: 999 */
        numero?: number;
        /** minimum: 1; maximum: 99999 */
        sequencia: number;
        /** minLength: 1; maxLength: 60 */
        codigoFabricante: string;
        /** maximum: 9999999999999.99; exclusiveMinimum: 0 */
        desconto?: number;
        /** minLength: 1; maxLength: 20 */
        drawback?: string;
      }[];
    }[];
    /** maxItems: 500 */
    exportacao?: {
      /** minLength: 1; maxLength: 20 */
      drawback?: string;
      indireta?: {
        /** pattern: ^\d{0,12}$ */
        registroExportacao: string;
        /** pattern: ^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$ */
        chaveNfe: string;
        /** minimum: 0; maximum: 99999999999.9999 */
        quantidade: number;
      };
    }[];
    /** minLength: 1; maxLength: 15 */
    numeroPedido?: string;
    /** minimum: 0; maximum: 999999 */
    itemPedido?: number;
    /** minLength: 1; maxLength: 500 */
    informacoesAdicionais?: string;
    impostos: {
      /** minimum: 0; maximum: 9999999999999.99 */
      valorAproximadoTributos?: number;
      icms: {
        /** minimum: 0; maximum: 8; default: 0 */
        origem?: number;
        cst?: "10" | "20" | "30" | "40" | "41" | "50" | "51" | "60" | "70" | "90" | "00";
        csosn?: "101" | "102" | "103" | "201" | "202" | "203" | "300" | "400" | "500" | "900";
        /** minimum: 0; maximum: 3 */
        modalidadeBc?: number;
        /** minimum: 0; maximum: 999.9999 */
        reducaoBc?: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo?: number;
        /** minimum: 0; maximum: 999.9999 */
        aliquota?: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        valor?: number;
        fcp?: {
          /** minimum: 0; maximum: 9999999999999.99 */
          baseCalculo?: number;
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
        };
        st?: {
          /** minimum: 0; maximum: 6 */
          modalidadeBc: number;
          /** minimum: 0; maximum: 999.9999 */
          mva?: number;
          /** minimum: 0; maximum: 999.9999 */
          reducaoBc?: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          baseCalculo: number;
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
          fcp?: {
            /** minimum: 0; maximum: 9999999999999.99 */
            baseCalculo?: number;
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
        };
        desoneracao?: {
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
          /** minimum: 1; maximum: 99 */
          motivo: number;
          /** default: false */
          deduzDoTotal?: boolean;
        };
        diferimento?: {
          /** minimum: 0; maximum: 9999999999999.99 */
          valorOperacao: number;
          /** minimum: 0; maximum: 999.9999 */
          percentual: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valorDiferido: number;
        };
        creditoSimples?: {
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
        };
        retidoAnteriormente?: {
          /** minimum: 0; maximum: 9999999999999.99 */
          baseCalculo: number;
          /** minimum: 0; maximum: 999.9999 */
          aliquotaConsumidorFinal: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valorSubstituto?: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
          fcp?: {
            /** minimum: 0; maximum: 9999999999999.99 */
            baseCalculo: number;
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
        };
      };
      ipi?: {
        cst: "49" | "50" | "51" | "52" | "53" | "54" | "55" | "99" | "00" | "01" | "02" | "03" | "04" | "05";
        /** pattern: ^\d{1,3}$; default: 999 */
        codigoEnquadramento?: string;
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo?: number;
        /** minimum: 0; maximum: 999.9999 */
        aliquota?: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        valor?: number;
      };
      ii?: {
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        despesasAduaneiras: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        valor: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        iof: number;
      };
      pis?: {
        /** pattern: ^(0[1-9]|49|5[0-6]|6[0-7]|7[0-5]|98|99)$ */
        cst: string;
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo?: number;
        /** minimum: 0; maximum: 999.9999 */
        aliquota?: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        valor?: number;
      };
      cofins?: {
        /** pattern: ^(0[1-9]|49|5[0-6]|6[0-7]|7[0-5]|98|99)$ */
        cst: string;
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo?: number;
        /** minimum: 0; maximum: 999.9999 */
        aliquota?: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        valor?: number;
      };
      /** IBS e CBS do item, como calculados pelo sistema emissor. Sem baseCalculo, vão só o CST e a classificação. Não há suporte ao regime monofásico (combustíveis), à transferência de crédito, ao ajuste de competência nem ao crédito presumido da Zona Franca de Manaus. */
      ibsCbs?: {
        /** pattern: ^\d{3}$ */
        cst: string;
        /** pattern: ^\d{6}$ */
        classificacao: string;
        doacao?: boolean;
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo?: number;
        ibsUf?: {
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
          diferimento?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          devolucao?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual?: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          reducao?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual: number;
            /** minimum: 0; maximum: 999.9999 */
            aliquotaEfetiva: number;
          };
        };
        ibsMunicipio?: {
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
          diferimento?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          devolucao?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual?: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          reducao?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual: number;
            /** minimum: 0; maximum: 999.9999 */
            aliquotaEfetiva: number;
          };
        };
        cbs?: {
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
          diferimento?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          devolucao?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual?: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          reducao?: {
            /** minimum: 0; maximum: 999.9999 */
            percentual: number;
            /** minimum: 0; maximum: 999.9999 */
            aliquotaEfetiva: number;
          };
        };
        tributacaoRegular?: {
          /** pattern: ^\d{3}$ */
          cst: string;
          /** pattern: ^\d{6}$ */
          classificacao: string;
          ibsUf: {
            /** minimum: 0; maximum: 999.9999 */
            aliquotaEfetiva: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          ibsMunicipio: {
            /** minimum: 0; maximum: 999.9999 */
            aliquotaEfetiva: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          cbs: {
            /** minimum: 0; maximum: 999.9999 */
            aliquotaEfetiva: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
        };
        compraGovernamental?: {
          ibsUf: {
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          ibsMunicipio: {
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          cbs: {
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
        };
        simplesNacional?: {
          ibs?: {
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
          cbs: {
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
          };
        };
        estornoCredito?: {
          /** minimum: 0; maximum: 9999999999999.99 */
          ibs: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          cbs: number;
        };
        creditoPresumido?: {
          /** minimum: 0; maximum: 9999999999999.99 */
          baseCalculo: number;
          /** pattern: ^\d{2}$ */
          codigo: string;
          ibs?: {
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
            /** default: false */
            condicaoSuspensiva?: boolean;
          };
          cbs?: {
            /** minimum: 0; maximum: 999.9999 */
            aliquota: number;
            /** minimum: 0; maximum: 9999999999999.99 */
            valor: number;
            /** default: false */
            condicaoSuspensiva?: boolean;
          };
        };
      };
      impostoSeletivo?: {
        /** pattern: ^\d{3}$ */
        cst: string;
        /** pattern: ^\d{6}$ */
        classificacao: string;
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo?: number;
        /** minimum: 0; maximum: 999.9999 */
        aliquota?: number;
        /** minimum: 0; maximum: 999.9999 */
        aliquotaEspecifica?: number;
        /** minLength: 1; maxLength: 6 */
        unidade?: string;
        /** minimum: 0; maximum: 99999999999.9999 */
        quantidade?: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        valor?: number;
      };
      difal?: {
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo: number;
        /** minimum: 0; maximum: 999.9999 */
        aliquotaInterna: number;
        /** minimum: 0; maximum: 999.9999 */
        aliquotaInterestadual: number;
        /** minimum: 0; maximum: 9999999999999.99 */
        valorDestino: number;
        fcp?: {
          /** minimum: 0; maximum: 9999999999999.99 */
          baseCalculo?: number;
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
        };
      };
    };
  }[];
  /** minItems: 1; maxItems: 100 */
  pagamentos: {
    /** pattern: ^\d{2}$ */
    forma: string;
    /** minimum: 0; maximum: 9999999999999.99 */
    valor: number;
    /** minLength: 2; maxLength: 60 */
    descricao?: string;
    indicador?: "a_vista" | "a_prazo";
    cartao?: {
      /** default: nao_integrado */
      integracao?: "integrado" | "nao_integrado";
      /** pattern: ^[0-9A-Z]{12}\d{2}$ */
      cnpjCredenciadora?: string;
      /** pattern: ^\d{2}$ */
      bandeira?: string;
      /** minLength: 1; maxLength: 128 */
      autorizacao?: string;
    };
  }[];
  /** minimum: 0; maximum: 9999999999999.99 */
  troco?: number;
  /** minLength: 1; maxLength: 5000 */
  informacoesComplementares?: string;
  /** minLength: 1; maxLength: 2000 */
  informacoesFisco?: string;
  responsavelTecnico?: {
    /** pattern: ^[0-9A-Z]{12}\d{2}$ */
    cnpj: string;
    /** minLength: 2; maxLength: 60 */
    contato: string;
    /** format: email; pattern: ^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$; minLength: 6; maxLength: 60 */
    email: string;
    /** pattern: ^\d{6,14}$ */
    telefone: string;
  };
  /** default: presencial */
  presenca?: "presencial" | "entrega_domicilio";
  destinatario?: {
    /** pattern: ^[0-9A-Z]{12}\d{2}$ */
    cnpj?: string;
    /** pattern: ^\d{11}$ */
    cpf?: string;
    /**
     * Passaporte ou outro documento do estrangeiro. Use "" quando não houver documento.
     * pattern: ^([A-Za-z0-9]{5,20})?$
     */
    idEstrangeiro?: string;
    /** minLength: 2; maxLength: 60 */
    nome?: string;
    /** default: nao_contribuinte */
    indicadorIe?: "contribuinte" | "isento" | "nao_contribuinte";
    /** pattern: ^\d{2,14}$ */
    inscricaoEstadual?: string;
    /** format: email; pattern: ^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$; maxLength: 60 */
    email?: string;
    endereco?: {
      /** minLength: 2; maxLength: 60 */
      logradouro: string;
      /** minLength: 1; maxLength: 60 */
      numero: string;
      /** minLength: 1; maxLength: 60 */
      complemento?: string;
      /** minLength: 2; maxLength: 60 */
      bairro: string;
      /** pattern: ^\d{7}$ */
      codigoMunicipio: string;
      /** minLength: 2; maxLength: 60 */
      municipio: string;
      /** UF do destinatário. No exterior: "EX", com codigoMunicipio "9999999" e municipio "EXTERIOR". */
      uf: "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA" | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN" | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO" | "EX";
      /** pattern: ^\d{8}$ */
      cep?: string;
      /** pattern: ^\d{6,14}$ */
      telefone?: string;
      /**
       * Código do país na tabela do Banco Central (padrão: 1058, Brasil).
       * pattern: ^\d{1,4}$
       */
      codigoPais?: string;
      /**
       * Nome do país (padrão: Brasil).
       * minLength: 1; maxLength: 60
       */
      pais?: string;
    };
  };
  /** default: {"modalidade":9} */
  transporte?: {
    /** default: 9 */
    modalidade?: 0 | 1 | 2 | 3 | 4 | 9;
    transportadora?: {
      /** pattern: ^[0-9A-Z]{12}\d{2}$ */
      cnpj?: string;
      /** pattern: ^\d{11}$ */
      cpf?: string;
      /** minLength: 2; maxLength: 60 */
      nome?: string;
      /** pattern: ^\d{2,14}$ */
      inscricaoEstadual?: string;
      /** minLength: 1; maxLength: 60 */
      endereco?: string;
      /** minLength: 1; maxLength: 60 */
      municipio?: string;
      uf?: "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA" | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN" | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO";
    };
    veiculo?: {
      /** pattern: ^[A-Z]{2,3}[0-9]{4}$|^[A-Z]{3,4}[0-9]{3}$|^[A-Z0-9]{7}$ */
      placa: string;
      uf?: "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA" | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN" | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO";
      /** minLength: 1; maxLength: 20 */
      rntc?: string;
    };
    /** maxItems: 5000 */
    volumes?: {
      /** minimum: 0; maximum: 9007199254740991 */
      quantidade?: number;
      /** minLength: 1; maxLength: 60 */
      especie?: string;
      /** minLength: 1; maxLength: 60 */
      marca?: string;
      /** minLength: 1; maxLength: 60 */
      numeracao?: string;
      /** minimum: 0 */
      pesoLiquido?: number;
      /** minimum: 0 */
      pesoBruto?: number;
    }[];
  };
};

export type PedidoNfse = Cabecalho & {
  /** pattern: ^\d{1,5}$; default: 1 */
  serie?: string;
  /** maximum: 999999999999999; exclusiveMinimum: 0 */
  numero?: number;
  /** format: date-time; pattern: ^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$ */
  dataEmissao?: string;
  /** format: date; pattern: ^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))$ */
  dataCompetencia?: string;
  prestador: {
    /** pattern: ^\d{7}$ */
    codigoMunicipio: string;
    /** minLength: 1; maxLength: 15 */
    inscricaoMunicipal?: string;
    /** pattern: ^\d{6,20}$ */
    telefone?: string;
    /** format: email; pattern: ^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$; maxLength: 80 */
    email?: string;
    regimeTributario: {
      simplesNacional: "nao_optante" | "mei" | "me_epp";
      apuracaoSimples?: 1 | 2 | 3;
      /** default: 0 */
      regimeEspecial?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 9;
    };
  };
  tomador?: {
    /** pattern: ^[0-9A-Z]{12}\d{2}$ */
    cnpj?: string;
    /** pattern: ^\d{11}$ */
    cpf?: string;
    /** minLength: 1; maxLength: 300 */
    nome: string;
    /** minLength: 1; maxLength: 15 */
    inscricaoMunicipal?: string;
    endereco?: {
      /** pattern: ^\d{7}$ */
      codigoMunicipio: string;
      /** pattern: ^\d{8}$ */
      cep: string;
      /** minLength: 1; maxLength: 255 */
      logradouro: string;
      /** minLength: 1; maxLength: 60 */
      numero: string;
      /** minLength: 1; maxLength: 156 */
      complemento?: string;
      /** minLength: 1; maxLength: 60 */
      bairro: string;
    };
    /** pattern: ^\d{6,20}$ */
    telefone?: string;
    /** format: email; pattern: ^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$; maxLength: 80 */
    email?: string;
  };
  servico: {
    /** pattern: ^\d{7}$ */
    codigoMunicipioPrestacao: string;
    /** pattern: ^\d{6}$ */
    codigoTributacaoNacional: string;
    /** pattern: ^\d{3}$ */
    codigoTributacaoMunicipal?: string;
    /** minLength: 1; maxLength: 2000 */
    descricao: string;
    /** pattern: ^\d{9}$ */
    codigoNbs?: string;
    /** pattern: ^[a-zA-Z0-9]{1,20}$ */
    codigoInterno?: string;
    /** minLength: 1; maxLength: 2000 */
    informacoesComplementares?: string;
  };
  valores: {
    /** minimum: 0; maximum: 999999999999999 */
    servico: number;
    /** minimum: 0; maximum: 999999999999999 */
    descontoIncondicionado?: number;
    /** minimum: 0; maximum: 999999999999999 */
    descontoCondicionado?: number;
  };
  tributacao: {
    issqn: {
      /** default: tributavel */
      tipo?: "tributavel" | "imunidade" | "exportacao" | "nao_incidencia";
      /** minimum: 0; maximum: 5 */
      tipoImunidade?: number;
      /** default: nao_retido */
      retencao?: "nao_retido" | "retido_tomador" | "retido_intermediario";
      /** minimum: 0; maximum: 9.99 */
      aliquota?: number;
    };
    federal?: {
      pisCofins?: {
        /** pattern: ^\d{2}$ */
        cst: string;
        /** minimum: 0; maximum: 999999999999999 */
        baseCalculo?: number;
        /** minimum: 0; maximum: 99.99 */
        aliquotaPis?: number;
        /** minimum: 0; maximum: 99.99 */
        aliquotaCofins?: number;
        /** minimum: 0; maximum: 999999999999999 */
        valorPis?: number;
        /** minimum: 0; maximum: 999999999999999 */
        valorCofins?: number;
        /** minimum: 0; maximum: 9 */
        retencao?: number;
      };
      /** minimum: 0; maximum: 999999999999999 */
      retencaoCp?: number;
      /** minimum: 0; maximum: 999999999999999 */
      retencaoIrrf?: number;
      /** minimum: 0; maximum: 999999999999999 */
      retencaoCsll?: number;
    };
    /** default: {"tipo":"nao_informado"} */
    totalTributos?: {
      tipo: "nao_informado";
    } | {
      tipo: "percentual_simples";
      /** minimum: 0; maximum: 99.99 */
      percentual: number;
    } | {
      tipo: "valores";
      /** minimum: 0; maximum: 999999999999999 */
      federal: number;
      /** minimum: 0; maximum: 999999999999999 */
      estadual: number;
      /** minimum: 0; maximum: 999999999999999 */
      municipal: number;
    } | {
      tipo: "percentuais";
      /** minimum: 0; maximum: 999.99 */
      federal: number;
      /** minimum: 0; maximum: 999.99 */
      estadual: number;
      /** minimum: 0; maximum: 999.99 */
      municipal: number;
    };
  };
};

export type CancelamentoNfe = {
  /** minLength: 15; maxLength: 255 */
  justificativa: string;
};

export type CancelamentoNfse = {
  motivo: "erro_emissao" | "servico_nao_prestado" | "outros";
  /** minLength: 15; maxLength: 255 */
  justificativa: string;
};

export type CartaCorrecao = {
  /** minLength: 15; maxLength: 1000 */
  correcao: string;
};

export type Inutilizacao = {
  modelo: "nfe" | "nfce";
  /** default: homologacao */
  ambiente?: "homologacao" | "producao";
  /** minimum: 0; maximum: 889 */
  serie: number;
  /** minimum: 1; maximum: 999999999 */
  numeroInicial: number;
  /** minimum: 1; maximum: 999999999 */
  numeroFinal: number;
  /** minLength: 15; maxLength: 255 */
  justificativa: string;
  uf: "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA" | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN" | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO";
  /** pattern: ^[0-9A-Z]{12}\d{2}$ */
  cnpj?: string;
};

export type EmissaoNfe = {
  id: string;
  modelo: "nfe" | "nfce";
  ambiente: "homologacao" | "producao";
  referencia?: string | null;
  serie: number;
  numero: number;
  /** `indefinida`: a resposta do governo se perdeu; use POST .../consultar ou repita o pedido com a mesma referência. `erro`: barrada pelo cofre antes de transmitir. `contingencia`: NFC-e emitida offline; vale para o consumidor, ainda sem protocolo, e o cofre a transmite quando a SEFAZ voltar. */
  situacao: "processando" | "autorizada" | "contingencia" | "rejeitada" | "denegada" | "erro" | "indefinida" | "cancelada";
  chaveAcesso?: string | null;
  protocolo?: string | null;
  /** Data e hora de emissão que estão no XML (dhEmi), com o fuso da UF. */
  emitidaEm?: string | null;
  /** Data e hora em que a SEFAZ autorizou (dhRecbto). Com o protocolo, vai impressa no DANFE e no DANFCE. */
  autorizadaEm?: string | null;
  /** Valor total da nota (vNF), somado pelo cofre. */
  valor?: number | null;
  /** Só na NFC-e: conteúdo do QR Code. */
  qrCode?: string | null;
  /** Só na NFC-e: endereço de consulta pela chave. */
  urlConsulta?: string | null;
  cartasCorrecao?: number;
  /** Só na NFC-e emitida em contingência offline; null nas demais. */
  contingencia?: {
    /** A nota ainda aguarda a transmissão à SEFAZ. */
    pendente?: boolean;
    /** Quando o emitente entrou em contingência (dhCont). */
    desde?: string | null;
    motivo?: string | null;
    tentativasDeTransmissao?: number;
    ultimaTentativa?: string | null;
    /** Chave da NFC-e normal da mesma venda que ficou sem resposta: o cofre ainda vai conferi-la na SEFAZ. */
    notaNormalEmConferencia?: string | null;
    /** A SEFAZ rejeitou o cancelamento da nota normal: precisa de ação do emitente. */
    falhaNaConferencia?: string | null;
    /** Chave da NFC-e normal que acabou autorizada e foi cancelada por substituição (evento 110112). */
    notaNormalCancelada?: string | null;
  } | null;
  /** Código e descrição devolvidos pelo governo (na NF-e e NFC-e, cStat e xMotivo) ou pelo cofre. */
  mensagens: {
    codigo: string;
    descricao: string;
  }[];
  /** Na contingência pendente, o XML é a nota assinada sem protocolo; depois de autorizada, o nfeProc. */
  xmlDisponivel: boolean;
  /** format: date-time */
  criadaEm?: string;
  /** format: date-time */
  atualizadaEm?: string;
};

export type EmissaoNfse = {
  id: string;
  ambiente: "homologacao" | "producao";
  referencia?: string | null;
  serie: string;
  /** Número da DPS. */
  numero: number;
  idDps?: string;
  situacao: "processando" | "autorizada" | "rejeitada" | "erro" | "indefinida" | "cancelada";
  chaveAcesso?: string | null;
  numeroNfse?: string | null;
  /** Código e descrição devolvidos pelo governo (na NF-e e NFC-e, cStat e xMotivo) ou pelo cofre. */
  mensagens: {
    codigo: string;
    descricao: string;
  }[];
  xmlDisponivel: boolean;
  /** format: date-time */
  criadaEm?: string;
  /** format: date-time */
  atualizadaEm?: string;
};

/** Conteúdo do DANFE NFC-e, na ordem e com os dizeres do manual oficial (versão 6.0), para o caixa imprimir na bobina. Imprima as seções na ordem em que vêm e as linhas na ordem em que vêm. Não há largura, corte nem avanço de papel: isso é do caixa. Os textos fixos usam só caracteres das páginas de código comuns de impressora; os que vêm da nota (nomes, descrições, informações adicionais) saem como estão no XML. */
export type Cupom = {
  id: string;
  /** Situação da emissão no cofre. Uma nota `cancelada` ainda devolve o cupom: não o entregue ao consumidor. */
  situacao: string;
  modelo: "nfce";
  chaveAcesso: string;
  ambiente: "homologacao" | "producao";
  /** Nota emitida em contingência offline. Imprima também a via do estabelecimento (`?via=estabelecimento`). */
  contingencia: boolean;
  /** A nota em contingência ainda não foi autorizada: o cupom sai com os dizeres de contingência e sem protocolo. */
  pendenteDeAutorizacao: boolean;
  via: "consumidor" | "estabelecimento";
  numero: number;
  serie: number;
  emitidaEm: string;
  protocolo?: string | null;
  autorizadaEm?: string | null;
  valorAPagar: number;
  /** O mesmo texto da linha `qrcode`, para quem monta o cupom por conta própria. */
  qrCode: string;
  /** Endereço de consulta pela chave de acesso. */
  urlConsulta: string;
  /** Divisões do DANFE NFC-e que têm conteúdo, na ordem de impressão. */
  secoes: {
    divisao: "cabecalho" | "itens" | "totais" | "consulta" | "consumidor" | "identificacao" | "qrcode" | "mensagem_fiscal" | "mensagem_contribuinte";
    linhas: LinhaDoCupom[];
  }[];
};

/** Uma linha do cupom. O campo `tipo` diz o formato. */
export type LinhaDoCupom = {
  tipo: "texto";
  texto: string;
  alinhamento: "esquerda" | "centro" | "direita";
  negrito: boolean;
  /** `dobrado`: altura e largura dobradas, quando a impressora tiver. */
  tamanho: "normal" | "dobrado";
} | {
  tipo: "separador";
} | {
  tipo: "item";
  numero: number;
  codigo: string;
  descricao: string;
  quantidade: number;
  unidade: string;
  valorUnitario: number;
  valorTotal: number;
  /** A quantidade já no formato de impressão (vírgula decimal). */
  quantidadeTexto: string;
  valorUnitarioTexto: string;
  valorTotalTexto: string;
} | {
  tipo: "par";
  rotulo: string;
  valor: string;
  negrito: boolean;
} | {
  tipo: "chave";
  chave: string;
} | {
  tipo: "qrcode";
  texto: string;
  /** Lado mínimo da imagem impressa, em milímetros. */
  tamanhoMinimoMm: number;
};

/** NF-e que outra empresa emitiu e que interessa ao titular do cofre. Nasce do resumo entregue pelo Ambiente Nacional e ganha o XML completo depois da manifestação do destinatário. */
export type NotaRecebida = {
  id: string;
  ambiente: "homologacao" | "producao";
  /** CNPJ do titular (ou da filial) a quem a nota interessa. */
  cnpj: string;
  chaveAcesso: string;
  /** Cresce a cada mudança da nota (XML que chegou, cancelamento, manifestação). É o cursor de leitura: guarde a maior que já viu e passe em `?depois=`. */
  sequencia: number;
  /** `terceiro`: o titular é transportador ou autorizado a baixar o XML, não o destinatário. Só confronte com pedido de compra as notas de papel `destinatario`. */
  papel: "destinatario" | "terceiro";
  emitente?: {
    documento?: string;
    nome?: string | null;
    ie?: string | null;
  };
  serie?: number;
  numero?: number;
  emitidaEm?: string | null;
  autorizadaEm?: string | null;
  protocolo?: string | null;
  /** Do ponto de vista do emitente da nota. */
  tipoOperacao?: "entrada" | "saida" | null;
  /** Valor total da nota (vNF). */
  valor?: number | null;
  /** Nulo enquanto o cofre só conhece a chave (manifestação feita antes de o resumo chegar). */
  situacao?: "autorizada" | "cancelada" | "denegada" | null;
  /** O cofre já tem o XML completo (nfeProc)? Antes da manifestação só há o resumo. */
  xmlDisponivel: boolean;
  /** A última manifestação: é a que vale. */
  manifestacao?: ManifestacaoRegistrada | null;
  manifestacoes: ManifestacaoRegistrada[];
  /** Motivo da recusa quando a ciência automática foi tentada e o Ambiente Nacional não aceitou. */
  cienciaAutomaticaRecusada?: {
    codigo?: string;
    descricao?: string;
  } | null;
  /** Só na consulta de uma nota: os eventos recebidos (cancelamento, carta de correção...). */
  eventos?: DocumentoDistribuido[];
  /** format: date-time */
  recebidaEm?: string;
  /** format: date-time */
  atualizadaEm?: string;
  /** Só na resposta da manifestação: ela já estava registrada e nada novo foi enviado. */
  repetido?: boolean;
};

export type ManifestacaoRegistrada = {
  tipo?: "ciencia" | "confirmacao" | "desconhecimento" | "nao_realizada";
  /** 1, ou 2 na retificação de uma manifestação conclusiva. */
  sequencia?: number;
  /** Nulo quando o evento já estava no Ambiente Nacional, registrado fora do cofre. */
  protocolo?: string | null;
  /** format: date-time */
  registradaEm?: string;
  justificativa?: string | null;
  /** `agendador` na ciência automática; senão, a chave de API (`chave:...`) ou o painel (`admin`). */
  origem?: string;
  xmlDisponivel?: boolean;
};

/** Um documento entregue pelo Ambiente Nacional, como chegou. */
export type DocumentoDistribuido = {
  /** Ordem de chegada no cofre; cursor de leitura de GET /v1/distribuicao/documentos. */
  sequencia?: number;
  ambiente?: "homologacao" | "producao";
  cnpj?: string;
  /** NSU do documento no Ambiente Nacional; nulo no que veio da consulta por chave. */
  nsu?: number | null;
  tipo?: "resumo_nfe" | "nfe" | "resumo_evento" | "evento" | "outro";
  /** Schema informado pelo Ambiente Nacional, como `resNFe_v1.01.xsd`. */
  schema?: string;
  chaveAcesso?: string | null;
  evento?: {
    /** tpEvento: 110111 cancelamento, 110110 carta de correção, 2102xx manifestação do destinatário... */
    codigo?: string;
    sequencia?: number;
    descricao?: string | null;
    registradoEm?: string | null;
    protocolo?: string | null;
    autor?: string | null;
  } | null;
  /** format: date-time */
  recebidoEm?: string;
};

/** Estado da consulta das notas recebidas de um CNPJ em um ambiente. O último NSU e a espera entre consultas são controlados só pelo cofre. */
export type Distribuicao = {
  cnpj?: string;
  ambiente?: "homologacao" | "producao";
  uf?: string;
  /** O cofre consulta sozinho (ligado pelo emitente na tela do cofre). */
  consultaAutomatica?: boolean;
  /** O cofre registra sozinho a ciência da operação das notas novas (ligado pelo emitente). */
  cienciaAutomatica?: boolean;
  ultimoNsu?: number;
  maiorNsu?: number;
  /** format: date-time */
  ultimaConsulta?: string | null;
  /**
   * Antes deste instante o cofre não consulta: depois de "nenhum documento" o Ambiente Nacional exige uma hora de espera. Nulo quando já pode consultar.
   * format: date-time
   */
  proximaConsulta?: string | null;
  /** O Ambiente Nacional bloqueou as consultas do CNPJ (consumo indevido) até `proximaConsulta`. */
  bloqueada?: boolean;
  /** Última resposta: 138 documentos localizados, 137 nenhum documento, 656 consumo indevido. */
  mensagem?: {
    codigo?: string;
    descricao?: string;
  } | null;
  /** Consultas pontuais (por chave e por NSU) na última hora e o limite do cofre. */
  consultasPorChave?: {
    naUltimaHora?: number;
    limite?: number;
  };
  /** Documentos que ficaram para trás e que o cofre ainda vai buscar um a um, sozinho, a cerca de 12 por hora. Acontece quando outro sistema (o do contador, por exemplo) consulta o mesmo CNPJ: o Ambiente Nacional recusa a consulta do cofre (656) e devolve o NSU em que o outro parou. Zero no uso normal. */
  documentosARecuperar?: number;
};

export type Sincronizacao = {
  /** false: a espera ainda não venceu (ou outra consulta está em andamento) e nada foi enviado ao Ambiente Nacional. */
  consultou?: boolean;
  lotes?: number;
  /** Documentos novos no cofre nesta consulta, contando os recuperados. */
  documentos?: number;
  /** Dos documentos, quantos tinham ficado para trás e foram buscados pelo NSU (ver `documentosARecuperar`). */
  recuperados?: number;
  notasNovas?: number;
  distribuicao?: Distribuicao;
};

export type InutilizacaoRegistrada = {
  id?: string;
  modelo?: string;
  ambiente?: "homologacao" | "producao";
  serie?: number;
  numeroInicial?: number;
  numeroFinal?: number;
  /** Nulo quando a SEFAZ só confirmou que a faixa já estava inutilizada. */
  protocolo?: string | null;
  justificativa?: string;
  xmlDisponivel?: boolean;
  /** format: date-time */
  criadaEm?: string;
  /** Só na resposta do POST: a faixa já estava inutilizada. */
  repetido?: boolean;
};

export type Serie = {
  modelo?: "nfe" | "nfce";
  ambiente?: "homologacao" | "producao";
  serie?: number;
  /** Número que a próxima nota da série vai receber. */
  proximoNumero?: number;
  descricao?: string | null;
  cnpj?: string;
};

export type Cofre = {
  versao?: string;
  atualizacao?: {
    versaoPublicada?: string | null;
    pendente?: boolean;
  };
  certificado?: {
    titular?: string;
    documento?: {
      kind?: "cnpj" | "cpf";
      id?: string;
    };
    /** format: date-time */
    validoAte?: string;
    diasRestantes?: number;
  } | null;
  producaoLiberada?: boolean;
  contingencia?: {
    /** NFC-e emitidas em contingência que ainda aguardam a transmissão à SEFAZ. */
    notasPendentes?: number;
  };
  /** Há logotipo cadastrado no cofre. A imagem sai em GET /v1/cofre/logotipo. */
  logotipo?: boolean;
  chave?: {
    escopo?: "completo" | "homologacao";
    ambientes?: ("homologacao" | "producao")[];
  };
  /** O que este cofre emite e, para NF-e e NFC-e, em quais UFs. */
  documentos?: {
    nfse?: boolean;
    nfe?: {
      ufs?: string[];
    };
    nfce?: {
      ufs?: string[];
    };
  };
};

export type StatusSefaz = {
  modelo?: string;
  uf?: string;
  ambiente?: "homologacao" | "producao";
  autorizador?: string;
  emOperacao?: boolean;
  mensagem?: {
    codigo?: string;
    descricao?: string;
  };
  tempoMedioSegundos?: number | null;
};

/** Códigos de erro do contrato (Erro.erro.codigo, `x-codigos`) e o status HTTP de cada um. */
export const CONTRACT_ERROR_CODES = {
  requisicao_invalida: 400,
  nao_autenticado: 401,
  chave_somente_homologacao: 403,
  nao_encontrado: 404,
  certificado_ausente: 409,
  certificado_vencido: 409,
  emissao_em_andamento: 409,
  referencia_com_conteudo_diferente: 409,
  numero_ja_utilizado: 409,
  nfe_nao_autorizada: 409,
  nfse_nao_autorizada: 409,
  faixa_em_uso: 409,
  serie_nao_cadastrada: 422,
  serie_obrigatoria: 422,
  uf_nao_suportada: 422,
  emitente_divergente: 422,
  producao_bloqueada: 422,
  nfe_rejeitada: 422,
  nfe_denegada: 422,
  nfse_rejeitada: 422,
  cancelamento_rejeitado: 422,
  carta_rejeitada: 422,
  carta_nao_se_aplica: 422,
  limite_de_cartas: 422,
  inutilizacao_rejeitada: 422,
  inutilizacao_extinta: 422,
  host_nao_permitido: 422,
  certificado_do_cliente_invalido: 422,
  distribuicao_nao_configurada: 409,
  xml_indisponivel: 409,
  manifestacao_ja_registrada: 409,
  chave_de_acesso_invalida: 422,
  justificativa_obrigatoria: 422,
  limite_de_manifestacoes: 422,
  manifestacao_rejeitada: 422,
  nota_nao_localizada: 422,
  consulta_rejeitada: 422,
  consumo_indevido: 429,
  limite_de_consultas: 429,
  sem_resposta_conclusiva: 502,
  sem_conexao: 200,
  erro_interno: 500,
  cofre_nao_configurado: 503,
} as const;
export type ContractErrorCode = keyof typeof CONTRACT_ERROR_CODES;

/** Operações do contrato (método e caminho). */
export const CONTRACT_OPERATIONS = [
  "GET /v1/nfe",
  "POST /v1/nfe",
  "GET /v1/nfe/{id}",
  "POST /v1/nfe/{id}/consultar",
  "GET /v1/nfe/{id}/xml",
  "POST /v1/nfe/{id}/cancelar",
  "GET /v1/nfe/{id}/cancelamento/xml",
  "GET /v1/nfe/{id}/danfe",
  "GET /v1/nfe/{id}/carta-correcao/{sequencia}/xml",
  "POST /v1/nfe/{id}/carta-correcao",
  "GET /v1/nfce",
  "POST /v1/nfce",
  "GET /v1/nfce/{id}",
  "POST /v1/nfce/{id}/consultar",
  "GET /v1/nfce/{id}/xml",
  "POST /v1/nfce/{id}/cancelar",
  "GET /v1/nfce/{id}/cancelamento/xml",
  "GET /v1/nfce/{id}/cupom",
  "GET /v1/nfce/{id}/danfce",
  "GET /v1/nfe-recebidas",
  "POST /v1/nfe-recebidas/manifestar",
  "GET /v1/nfe-recebidas/{id}",
  "GET /v1/nfe-recebidas/{id}/xml",
  "GET /v1/nfe-recebidas/{id}/danfe",
  "POST /v1/nfe-recebidas/{id}/manifestar",
  "GET /v1/nfe-recebidas/{id}/manifestacoes/{tipo}/{sequencia}/xml",
  "GET /v1/distribuicao",
  "POST /v1/distribuicao/sincronizar",
  "POST /v1/distribuicao/consultar-chave",
  "GET /v1/distribuicao/documentos",
  "GET /v1/distribuicao/documentos/{sequencia}/xml",
  "GET /v1/nfse",
  "POST /v1/nfse",
  "GET /v1/nfse/{id}",
  "GET /v1/nfse/{id}/xml",
  "GET /v1/nfse/{id}/cancelamento/xml",
  "POST /v1/nfse/{id}/cancelar",
  "GET /v1/inutilizacoes",
  "POST /v1/inutilizacoes",
  "GET /v1/inutilizacoes/{id}",
  "GET /v1/inutilizacoes/{id}/xml",
  "GET /v1/series",
  "GET /v1/cofre",
  "GET /v1/cofre/logotipo",
  "GET /v1/sefaz/status",
  "GET /v1/openapi.json",
] as const;
export type ContractOperation = (typeof CONTRACT_OPERATIONS)[number];
