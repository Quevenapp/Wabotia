// Página /api/public/imagemwa: o texto que o QR do cupom da senha deixa
// escrito no WhatsApp termina com este link, e a prévia dele (Open Graph)
// mostra uma imagem com a seta no botão de enviar. O caminho fica sob /api/
// para chegar ao Worker (run_worker_first); a mesma página serve a quem abre
// o link no navegador. Requisitos do WhatsApp
// (Meta, "Link previews"): og:title, og:description e og:url não vazios no
// <head> dentro dos primeiros 300 KB, og:image com URL absoluta, até 600 KB,
// ao menos 300 px de largura e proporção até 4:1. A imagem é estática
// (public/imagemwa.png, 1200 x 630, fonte em scripts/imagemwa/fonte.html).
import { SEND_HINT_PATH } from "./queue";

export const SEND_HINT_IMAGE = "/imagemwa.png";
export const SEND_HINT_TITLE = "Aperte ENVIAR para ser chamado pelo WhatsApp";
export const SEND_HINT_DESCRIPTION =
  "Toque no botão verde de enviar, no canto da conversa. Avisamos por aqui quando chegar a sua vez.";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );

export function sendHintPage(origin: string) {
  const url = escape(`${origin}${SEND_HINT_PATH}`);
  const image = escape(`${origin}${SEND_HINT_IMAGE}`);
  const title = escape(SEND_HINT_TITLE);
  const description = escape(SEND_HINT_DESCRIPTION);
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:locale" content="pt_BR">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${image}">
<meta property="og:image:secure_url" content="${image}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Seta apontando o botão verde de enviar do WhatsApp">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="${url}">
<style>body{margin:0;font-family:system-ui,sans-serif;background:#efeae2;color:#111b21;text-align:center}main{max-width:640px;margin:0 auto;padding:24px 16px}img{width:100%;height:auto;border-radius:12px}h1{font-size:1.6rem}p{font-size:1.2rem}</style>
</head>
<body>
<main>
<h1>${title}</h1>
<img src="${image}" width="1200" height="630" alt="Seta apontando o botão verde de enviar do WhatsApp">
<p>${description}</p>
</main>
</body>
</html>`;
}
