// /imagemwa aberto no navegador: o mesmo aviso da prévia do link que o QR do
// cupom da senha deixa escrito no WhatsApp (src/send-hint.ts serve a prévia).
import React from "react";

export function SendHint() {
  return (
    <main
      style={{
        maxWidth: 640,
        margin: "0 auto",
        padding: "24px 16px",
        textAlign: "center",
        fontSize: "1.2rem",
      }}
    >
      <h1>Aperte ENVIAR para ser chamado pelo WhatsApp</h1>
      <img
        src="/imagemwa.png"
        width={1200}
        height={630}
        alt="Seta apontando o botão verde de enviar do WhatsApp"
        style={{ width: "100%", height: "auto", borderRadius: 12 }}
      />
      <p>
        Volte para o WhatsApp e toque no botão verde de enviar, no canto da
        conversa. Avisamos por lá quando chegar a sua vez.
      </p>
    </main>
  );
}
