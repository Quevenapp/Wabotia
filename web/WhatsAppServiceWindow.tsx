import React, { useEffect, useMemo, useState } from "react";
import { whatsappServiceWindow } from "./whatsapp-service-window";
import "./whatsapp-insights.css";

export function WhatsAppServiceWindow({
  lastCustomer,
  serverNow,
}: {
  lastCustomer: number;
  serverNow?: number;
}) {
  const [tick, setTick] = useState(() => performance.now());
  const anchor = useMemo(
    () => ({
      server: Number.isFinite(serverNow) ? serverNow! : Date.now(),
      elapsed: performance.now(),
    }),
    [serverNow],
  );
  useEffect(() => {
    const timer = setInterval(() => setTick(performance.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const current = anchor.server + Math.max(0, tick - anchor.elapsed);
  const window = whatsappServiceWindow(lastCustomer, current);
  const expiration = window.expiresAt
    ? new Date(window.expiresAt).toLocaleString("pt-BR")
    : null;
  return (
    <div className={`whatsapp-service-window${window.open ? "" : " closed"}`}>
      <strong>
        {window.open
          ? "Janela de atendimento aberta"
          : "Janela de atendimento fechada"}
      </strong>
      {window.expiresAt && (
        <span className="service-window-last-customer">
          Última mensagem do cliente:{" "}
          {new Date(lastCustomer).toLocaleString("pt-BR")}.
        </span>
      )}
      {window.open ? (
        <>
          <span>
            Tempo restante: <time>{window.countdown}</time> · Expira em{" "}
            {expiration}.
          </span>
        </>
      ) : (
        <span>
          {expiration
            ? `Expirou em ${expiration}.`
            : "Ainda não há mensagem recebida do cliente."}{" "}
          Aguarde uma nova mensagem do cliente ou use um template aprovado
          conforme as permissões da linha.
        </span>
      )}
      <small>
        A janela dura 24 horas desde a última mensagem do cliente neste
        telefone. Templates e outras mensagens enviadas não abrem nem renovam
        esse prazo.
      </small>
    </div>
  );
}
