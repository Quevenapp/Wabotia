// Mensagem com o pagamento de uma cobrança já criada (reenvio, segunda via,
// aviso de vencimento): na linha oficial com a janela aberta, botão com URL
// em vez do link solto no texto, e o Pix copia e cola sozinho na mensagem
// seguinte, para copiar inteiro, como faz a Cobrança do núcleo. Na linha QR e
// fora da janela, o texto de antes, com o link e o código numa mensagem só.
import { type Conversation, now } from "../../types";
import type { ModuleContext } from "../api";
import { interactiveLine } from "../../line-service";

/** Corpo do botão com URL: até 1024 caracteres (Meta). */
const BODY_MAX = 1024;
const WINDOW_MS = 86_400_000;

export interface PayData {
  pay_url?: string | null;
  pix_code?: string | null;
}

export async function sendPayMessage(
  ctx: ModuleContext,
  c: Conversation,
  text: string,
  pay: PayData,
  options: {
    key: string;
    notification?: boolean;
    purpose?: "billing";
  },
) {
  // Botão só na linha oficial com a janela aberta. Na QR e fora da janela
  // (modelo pago por mensagem), uma mensagem só com o link e o código.
  const button =
    !!pay.pay_url &&
    (await interactiveLine(ctx.env, c)) &&
    now() - c.last_customer < WINDOW_MS;
  if (!button) {
    await ctx.sendMessage(
      c,
      {
        text: [
          text,
          pay.pay_url ? `Pagar: ${pay.pay_url}` : "",
          pay.pix_code ? `Pix copia e cola:\n${pay.pix_code}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      options,
    );
    return;
  }
  const body = Array.from(text).slice(0, BODY_MAX).join("");
  await ctx.sendInteractive(
    c,
    {
      type: "cta_url",
      body: pay.pix_code
        ? `${body}\n\nToque no botão para ver o QR Code ou copie o código na próxima mensagem.`.slice(
            0,
            BODY_MAX,
          )
        : body,
      display_text: pay.pix_code ? "Ver QR Code Pix" : "Pagar agora",
      url: pay.pay_url!,
    },
    options,
  );
  if (pay.pix_code)
    await ctx.sendMessage(
      c,
      { text: pay.pix_code },
      { ...options, key: `${options.key}:pix` },
    );
}
