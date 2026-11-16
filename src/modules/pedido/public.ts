// Interface pública do Pedido para outros módulos (docs/MODULOS.md,
// "Dependência entre módulos"; docs/PEDIDO.md, "Para outros módulos").
// Contrato estável: use só o que está aqui, nunca as tabelas pedido_.
export {
  onOrderStatusChanged,
  onStatusNotice,
  provideDeliveryInfo,
  provideDeliverySlip,
  type DeliveryInfo,
  type DeliverySlip,
  type DeliverySlipRequest,
  type StatusChange,
  type StatusNotice,
} from "./listeners";
