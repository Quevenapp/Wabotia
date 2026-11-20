import type { ServiceObjectType } from "../../modules/os/contracts";

// Definições declarativas. O motor remapeia os IDs por manifesto e área;
// compartilhar esta semente não une cadastros nem transfere valores antigos.
export const veiculoObjectType: ServiceObjectType = {
  schema_version: 1, id: "veiculo", revision: 1, archived: false,
  labels: { singular: "Veículo", plural: "Veículos" },
  identifier_field_id: "placa",
  fields: [
    { id: "placa", label: "Placa", help: "Informe expressamente no cadastro. A placa não comprova propriedade nem autoriza acesso.", kind: "text", multiline: false, max_length: 10, required: false, client_visible: true, sensitive: false },
    { id: "marca_modelo", label: "Marca e modelo", help: "", kind: "text", multiline: false, max_length: 240, required: false, client_visible: true, sensitive: false },
    { id: "ano", label: "Ano", help: "", kind: "integer", min: 1900, max: 2100, required: false, client_visible: true, sensitive: false },
    { id: "cor", label: "Cor", help: "", kind: "text", multiline: false, max_length: 80, required: false, client_visible: true, sensitive: false },
    {
      id: "tipo_combustivel", label: "Tipo de combustível", help: "Característica do veículo. O nível observado na entrada pertence a cada atendimento.",
      kind: "choice", required: false, client_visible: true, sensitive: false,
      options: [
        { id: "gasolina", label: "Gasolina" }, { id: "etanol", label: "Etanol" },
        { id: "flex", label: "Flex" }, { id: "diesel", label: "Diesel" },
        { id: "gnv", label: "GNV" }, { id: "eletrico", label: "Elétrico" },
        { id: "hibrido", label: "Híbrido" }, { id: "outro", label: "Outro" },
        { id: "nao_informado", label: "Não informado" },
      ],
    },
  ],
  retired_field_ids: [],
};

export const equipamentoEletronicoObjectType: ServiceObjectType = {
  schema_version: 1, id: "equipamento_eletronico", revision: 1, archived: false,
  labels: { singular: "Equipamento", plural: "Equipamentos" },
  identifier_field_id: "identificacao",
  fields: [
    { id: "identificacao", label: "Identificação administrativa", help: "Referência opcional do equipamento, sem senha ou código de acesso.", kind: "text", multiline: false, max_length: 120, required: false, client_visible: true, sensitive: false },
    {
      id: "categoria", label: "Categoria", help: "", kind: "choice", required: true, client_visible: true, sensitive: false,
      options: [
        { id: "celular", label: "celular" }, { id: "tablet", label: "tablet" },
        { id: "computador", label: "computador" }, { id: "notebook", label: "notebook" },
        { id: "periferico", label: "periférico" },
      ],
    },
    { id: "marca_modelo", label: "Marca e modelo", help: "", kind: "text", multiline: false, max_length: 240, required: false, client_visible: true, sensitive: false },
    { id: "numero_serie", label: "Número de série ou IMEI", help: "", kind: "text", multiline: false, max_length: 240, required: false, client_visible: false, sensitive: true },
  ],
  retired_field_ids: [],
};

export const eletrodomesticoObjectType: ServiceObjectType = {
  schema_version: 1, id: "eletrodomestico", revision: 1, archived: false,
  labels: { singular: "Equipamento", plural: "Equipamentos" },
  identifier_field_id: "identificacao",
  fields: [
    { id: "identificacao", label: "Identificação administrativa", help: "Referência opcional do equipamento.", kind: "text", multiline: false, max_length: 120, required: false, client_visible: true, sensitive: false },
    { id: "marca_modelo", label: "Marca e modelo", help: "", kind: "text", multiline: false, max_length: 240, required: false, client_visible: true, sensitive: false },
    { id: "numero_serie", label: "Número de série", help: "Interno por padrão; o administrador pode configurar sua visibilidade.", kind: "text", multiline: false, max_length: 240, required: false, client_visible: false, sensitive: false },
    {
      id: "tensao", label: "Tensão nominal", help: "Tensão informada para o equipamento; a equipe deve conferir antes do serviço.",
      kind: "choice", required: false, client_visible: true, sensitive: false,
      options: [
        { id: "opcao_1", label: "127 V" }, { id: "opcao_2", label: "220 V" },
        { id: "bivolt", label: "bivolt" }, { id: "nao_sei", label: "não sei" },
      ],
    },
  ],
  retired_field_ids: [],
};

export const animalObjectType: ServiceObjectType = {
  schema_version: 1, id: "animal", revision: 1, archived: false,
  labels: { singular: "Animal", plural: "Animais" },
  identifier_field_id: "nome",
  fields: [
    { id: "nome", label: "Nome administrativo do animal", help: "Identificação do cadastro, sem informações clínicas.", kind: "text", multiline: false, max_length: 120, required: false, client_visible: true, sensitive: false },
    { id: "especie", label: "Espécie", help: "", kind: "text", multiline: false, max_length: 80, required: false, client_visible: true, sensitive: false },
    { id: "identificacao", label: "Identificação adicional", help: "Referência administrativa opcional; não comprova titularidade nem autoriza acesso.", kind: "text", multiline: false, max_length: 120, required: false, client_visible: true, sensitive: false },
  ],
  retired_field_ids: [],
};

export const imovelObjectType: ServiceObjectType = {
  schema_version: 1, id: "imovel", revision: 1, archived: false,
  labels: { singular: "Imóvel", plural: "Imóveis" },
  identifier_field_id: "identificacao",
  fields: [
    { id: "identificacao", label: "Identificação administrativa do imóvel", help: "Referência opcional. Não comprova propriedade nem autoriza acesso.", kind: "text", multiline: false, max_length: 120, required: false, client_visible: true, sensitive: false },
    { id: "municipio", label: "Município e UF", help: "", kind: "text", multiline: false, max_length: 240, required: true, client_visible: true, sensitive: false },
    // A classificação privada dos modelos anteriores é preservada.
    { id: "endereco", label: "Endereço do imóvel", help: "", kind: "text", multiline: true, max_length: 2000, required: false, client_visible: false, sensitive: true },
  ],
  retired_field_ids: [],
};

export const eventoObjectType: ServiceObjectType = {
  schema_version: 1, id: "evento", revision: 1, archived: false,
  labels: { singular: "Evento", plural: "Eventos" },
  identifier_field_id: "nome",
  fields: [
    { id: "nome", label: "Nome administrativo do evento", help: "Use uma referência como Festa de novembro; não é necessário informar nome de criança.", kind: "text", multiline: false, max_length: 120, required: false, client_visible: true, sensitive: false },
    { id: "data_festa", label: "Data da festa", help: "Data informada; não reserva agenda, equipe ou materiais.", kind: "date", min: null, max: null, required: false, client_visible: true, sensitive: false },
    { id: "tema", label: "Tema", help: "", kind: "text", multiline: false, max_length: 240, required: false, client_visible: true, sensitive: false },
    { id: "local", label: "Local", help: "Local informado pelo contratante, disponível somente no seu atendimento autorizado.", kind: "text", multiline: false, max_length: 240, required: false, client_visible: true, sensitive: false },
  ],
  retired_field_ids: [],
};
