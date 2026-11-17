import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { overview, SEND_HINT_PATH } from "../src/queue";
import { SEND_HINT_IMAGE } from "../src/send-hint";
import wranglerConfig from "../wrangler.jsonc?raw";
import { kioskLine } from "../src/queue-flow";
import { uid, type Actor } from "../src/types";
import {
  configure,
  drain,
  fixture,
  latest,
  receive,
} from "./service-center-fixture";

type F = Awaited<ReturnType<typeof fixture>>;
const run = (f: F, actor: Actor, op: string, data: any = {}) =>
  perform(env, actor, f.profile, op, data, uid());

async function setup() {
  const f = await fixture();
  const queue = await run(f, f.admin, "queue.save", { name: "Geral" });
  const counter = await run(f, f.admin, "counter.save", {
    name: "Guichê 1",
    queue_ids: [queue.id],
  });
  await run(f, f.member, "counter.state", { id: counter.id, status: "open" });
  return { f, queue, counter };
}
const withNumber = (f: F, number = "5511955550000") =>
  exec(
    env,
    "UPDATE connections SET config=? WHERE id=?",
    JSON.stringify({ number }),
    f.line,
  );
const issue = (f: F, queue: any) =>
  run(f, f.admin, "queue.issue", {
    queue_id: queue.id,
    preferential: false,
    source: "kiosk",
  });

describe("cupom da senha", () => {
  it("sem linha de WhatsApp, o QR some com o motivo no snapshot", async () => {
    const { f, queue } = await setup();
    await exec(env, "DELETE FROM connections WHERE profile_id=?", f.profile);
    const ticket = await issue(f, queue);
    expect(ticket.whatsapp_link).toBe(null);
    const { coupon } = await overview(env, f.profile);
    expect(coupon).toMatchObject({
      whatsapp_qr: true,
      whatsapp_qr_issue: "no_line",
      position: true,
    });
    expect(coupon.whatsapp_qr_notice).toContain("não tem linha de WhatsApp");
  });

  it("linha sem número registrado tem motivo próprio", async () => {
    const { f } = await setup();
    const { coupon } = await overview(env, f.profile);
    expect(coupon.whatsapp_qr_issue).toBe("no_number");
  });

  it("com número, o QR deixa a instrução, a senha e o link da imagem escritos", async () => {
    const { f, queue } = await setup();
    await withNumber(f);
    await exec(
      env,
      "INSERT INTO instance_settings(key,value,updated) VALUES('public_origin','https://wabotia.example',0) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    );
    const ticket = await issue(f, queue);
    const url = new URL(ticket.whatsapp_link);
    expect(url.origin + url.pathname).toBe("https://wa.me/5511955550000");
    const row = await one(
      env,
      "SELECT link_code FROM queue_tickets WHERE id=?",
      ticket.id,
    );
    expect(url.searchParams.get("text")).toBe(
      `Aperte ENVIAR para ser chamado pelo WhatsApp.\nSENHA ${ticket.code} ${row.link_code}\nhttps://wabotia.example/api/public/imagemwa`,
    );
    expect((await overview(env, f.profile)).coupon.whatsapp_qr_issue).toBe(
      null,
    );

    // O texto inteiro, como chega do WhatsApp, vincula a senha.
    const c = await receive(
      f,
      f.line,
      url.searchParams.get("text")!,
      "5511920000077",
    );
    await drain(f);
    expect((await latest(c.id)).text).toContain(
      "Pronto! Vamos avisar por aqui.",
    );
    const linked = await one(
      env,
      "SELECT conversation_id FROM queue_tickets WHERE id=?",
      ticket.id,
    );
    expect(linked.conversation_id).toBe(
      (await conversation(env, c.id, f.profile)).id,
    );
    await exec(env, "DELETE FROM instance_settings WHERE key='public_origin'");
  });

  it("cada item liga e desliga; rodapé próprio ou o do estabelecimento", async () => {
    const { f, queue } = await setup();
    await withNumber(f);
    await configure(f, {
      establishment: {
        name: "Clínica Exemplo",
        document: "11222333000181",
        address: "Rua A, 1",
        phone: "(11) 3000-0000",
        footer: "Rodapé do cadastro",
      },
    });
    let { coupon } = await overview(env, f.profile);
    expect(coupon.establishment).toEqual({
      name: "Clínica Exemplo",
      document_type: "cnpj",
      document_display: "11.222.333/0001-81",
      address: "Rua A, 1",
      phone: "(11) 3000-0000",
    });
    expect(coupon.footer).toBe("Rodapé do cadastro");

    await run(f, f.admin, "settings", {
      queue: { coupon: { footer_text: "  Volte sempre!  " } },
    });
    ({ coupon } = await overview(env, f.profile));
    expect(coupon.footer).toBe("Volte sempre!");

    // Parcial: só o QR desliga, o resto continua como estava.
    await run(f, f.admin, "settings", {
      queue: { coupon: { whatsapp_qr: false, position: false } },
    });
    await run(f, f.admin, "settings", { queue: { notify_ahead: 3 } });
    ({ coupon } = await overview(env, f.profile));
    expect(coupon).toMatchObject({
      position: false,
      footer: "Volte sempre!",
      whatsapp_qr: false,
      whatsapp_qr_issue: "disabled",
    });
    expect((await issue(f, queue)).whatsapp_link).toBe(null);

    await run(f, f.admin, "settings", {
      queue: { coupon: { establishment: false, footer: false } },
    });
    ({ coupon } = await overview(env, f.profile));
    expect(coupon.establishment).toBe(null);
    expect(coupon.footer).toBe(null);
  });

  it("CPF do estabelecimento chega ao aparelho mascarado", async () => {
    const { f } = await setup();
    await configure(f, {
      establishment: { name: "Ana Manicure", document: "52998224725" },
    });
    const { coupon } = await overview(env, f.profile);
    expect(coupon.establishment).toMatchObject({
      document_type: "cpf",
      document_display: "***.982.247-**",
    });
    expect(JSON.stringify(coupon)).not.toContain("52998224725");
    expect(JSON.stringify(coupon)).not.toContain("529.982");
  });

  it("valida a configuração e só o administrador grava", async () => {
    const { f } = await setup();
    await expect(
      run(f, f.admin, "settings", { queue: { coupon: { position: "sim" } } }),
    ).rejects.toThrow(/position/);
    await expect(
      run(f, f.admin, "settings", {
        queue: { coupon: { footer_text: "x".repeat(301) } },
      }),
    ).rejects.toThrow(/300 caracteres/);
    await expect(
      run(f, f.member, "settings", { queue: { coupon: { position: false } } }),
    ).rejects.toThrow();
  });

  it("o link da prévia chega ao Worker e a imagem não, como no Cloudflare", () => {
    // Fora de run_worker_first, o fallback de página única dos arquivos
    // estáticos responde com o painel e o Worker nunca vê o pedido.
    const config = JSON.parse(
      wranglerConfig.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"),
    );
    const workerFirst = (path: string) =>
      (config.assets.run_worker_first as string[]).some((pattern) =>
        pattern.endsWith("/*")
          ? path.startsWith(pattern.slice(0, -1))
          : path === pattern,
      );
    expect(workerFirst(SEND_HINT_PATH)).toBe(true);
    // A imagem é arquivo estático (public/), servido antes do Worker.
    expect(workerFirst(SEND_HINT_IMAGE)).toBe(false);
  });

  it("/api/public/imagemwa traz a prévia com a imagem da seta em URL absoluta", async () => {
    const response = await SELF.fetch(
      "https://inst.example/api/public/imagemwa",
      {
        headers: { "User-Agent": "WhatsApp/2.24.1.1 A" },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const html = await response.text();
    const head = html.slice(0, html.indexOf("</head>"));
    for (const [property, value] of [
      ["og:title", "Aperte ENVIAR para ser chamado pelo WhatsApp"],
      ["og:url", "https://inst.example/api/public/imagemwa"],
      ["og:image", "https://inst.example/imagemwa.png"],
      ["og:image:width", "1200"],
    ])
      expect(head).toContain(
        `<meta property="${property}" content="${value}">`,
      );
    expect(head).toMatch(/property="og:description" content="[^"]+"/);
  });

  it("a linha da senha só vincula quando o resto é a instrução ou um link", () => {
    expect(kioskLine("SENHA N023 AB23CD")?.[1]).toBe("N023");
    expect(
      kioskLine(
        "Aperte ENVIAR para ser chamado pelo WhatsApp.\nSENHA N023 AB23CD\nhttps://x.example/api/public/imagemwa",
      )?.[2],
    ).toBe("AB23CD");
    expect(kioskLine("minha senha é\nSENHA N023 AB23CD")).toBe(null);
    expect(kioskLine("SENHA N023 AB23CD\nSENHA N024 AB23CE")).toBe(null);
    expect(kioskLine("oi")).toBe(null);
  });
});
