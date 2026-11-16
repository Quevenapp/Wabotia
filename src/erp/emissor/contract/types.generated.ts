// GERADO por src/erp/emissor/contract/sync.mjs a partir de contract/openapi.json.
// Não edite à mão: copie o contrato novo e rode o sync (README.md desta pasta).
// Cofre NFapi 0.3.1 (OpenAPI 3.1.0).
/* eslint-disable */

export const CONTRACT_VERSION = "0.3.1";

export type Erro = {
  erro: {
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
  /** minimum: 0; maximum: 889 */
  serie?: number;
  /** minLength: 1; maxLength: 60 */
  naturezaOperacao: string;
  /** pattern: ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$ */
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
      ibsCbs?: {
        /** pattern: ^\d{3}$ */
        cst: string;
        /** pattern: ^\d{6}$ */
        classificacao: string;
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo?: number;
        ibsUf?: {
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
        };
        ibsMunicipio?: {
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
        };
        cbs?: {
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
        };
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
    /** pattern: ^[A-Za-z0-9]{0,20}$ */
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
      uf: "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA" | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN" | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO";
      /** pattern: ^\d{8}$ */
      cep?: string;
      /** pattern: ^\d{6,14}$ */
      telefone?: string;
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

export type PedidoNfce = Cabecalho & {
  /** minimum: 0; maximum: 889 */
  serie?: number;
  /** minLength: 1; maxLength: 60 */
  naturezaOperacao: string;
  /** pattern: ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$ */
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
      ibsCbs?: {
        /** pattern: ^\d{3}$ */
        cst: string;
        /** pattern: ^\d{6}$ */
        classificacao: string;
        /** minimum: 0; maximum: 9999999999999.99 */
        baseCalculo?: number;
        ibsUf?: {
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
        };
        ibsMunicipio?: {
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
        };
        cbs?: {
          /** minimum: 0; maximum: 999.9999 */
          aliquota: number;
          /** minimum: 0; maximum: 9999999999999.99 */
          valor: number;
        };
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
    /** pattern: ^[A-Za-z0-9]{0,20}$ */
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
      uf: "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA" | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN" | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO";
      /** pattern: ^\d{8}$ */
      cep?: string;
      /** pattern: ^\d{6,14}$ */
      telefone?: string;
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
  /** `indefinida`: a resposta do governo se perdeu; use POST .../consultar ou repita o pedido com a mesma referência. `erro`: barrada pelo cofre antes de transmitir. */
  situacao: "processando" | "autorizada" | "rejeitada" | "denegada" | "erro" | "indefinida" | "cancelada";
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

export type InutilizacaoRegistrada = {
  id?: string;
  modelo?: string;
  ambiente?: "homologacao" | "producao";
  serie?: number;
  numeroInicial?: number;
  numeroFinal?: number;
  protocolo?: string | null;
  /** format: date-time */
  criadaEm?: string;
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

/** Operações do contrato (método e caminho). */
export const CONTRACT_OPERATIONS = [
  "GET /v1/nfe",
  "POST /v1/nfe",
  "GET /v1/nfe/{id}",
  "POST /v1/nfe/{id}/consultar",
  "GET /v1/nfe/{id}/xml",
  "POST /v1/nfe/{id}/cancelar",
  "POST /v1/nfe/{id}/carta-correcao",
  "GET /v1/nfce",
  "POST /v1/nfce",
  "GET /v1/nfce/{id}",
  "POST /v1/nfce/{id}/consultar",
  "GET /v1/nfce/{id}/xml",
  "POST /v1/nfce/{id}/cancelar",
  "GET /v1/nfse",
  "POST /v1/nfse",
  "GET /v1/nfse/{id}",
  "GET /v1/nfse/{id}/xml",
  "POST /v1/nfse/{id}/cancelar",
  "POST /v1/inutilizacoes",
  "GET /v1/series",
  "GET /v1/cofre",
  "GET /v1/sefaz/status",
  "GET /v1/openapi.json",
] as const;
export type ContractOperation = (typeof CONTRACT_OPERATIONS)[number];
