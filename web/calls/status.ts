// Estados de ligação em português (mesmos textos dos aplicativos).
import type { Row } from "../lib/api";

export const callStatus: Row = {
  ringing: "Recebendo ligação",
  dialing: "Chamando",
  connecting: "Conectando áudio",
  preaccepted: "Preparando áudio",
  active: "Em ligação",
  completed: "Encerrada",
  missed: "Não atendida",
  rejected: "Recusada",
  failed: "Falhou",
  unknown: "Sem confirmação",
};
/** Ligação ainda em curso (inclui "sem confirmação", que pede conferência). */
export const liveCall = (status: string) =>
  !["completed", "missed", "rejected", "failed"].includes(status);
/** Perdida, recusada ou com falha: seta vermelha no histórico. */
export const callFailed = (status: string) =>
  ["missed", "rejected", "failed"].includes(status);

/** Pedido de "Atender" feito no cartão da lista, lido pela tela da ligação. */
export const CALL_INTENT_KEY = "wabotia:call-intent";
