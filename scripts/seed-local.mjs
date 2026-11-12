#!/usr/bin/env node
// Dados de demonstração para o Wabotia LOCAL (wrangler dev + D1 local).
//
//   node scripts/seed-local.mjs               cria tudo (ou renova os relógios se já criou)
//   node scripts/seed-local.mjs --reset       apaga o D1 local e cria tudo de novo
//   node scripts/seed-local.mjs --connector   faz o papel do conector da linha QR de teste:
//                                             confirma os envios e devolve entregue/lida
//   --url http://127.0.0.1:8787               (ou WABOTIA_LOCAL_URL) só localhost / 127.0.0.1 / [::1]
//
// Usa a API normal (setup, usuários, /inbound, ações, protocolos, contatos,
// conversa interna, presença) e ajusta no D1 local apenas o que a API não
// permite: bots sem Hermes, idade das mensagens, estados de entrega, reações,
// vínculo das conversas com as linhas, grupo e histórico de ligações.
// Os logins de teste gerados ficam em seed-logins.local.json (ignorado pelo git).
// Nenhuma senha, token ou segredo é impresso.
//
// Três tipos de conversa, para exercitar cada situação do painel:
//   - linha oficial (Zernio, pausada): relógio da janela de 24 h e recursos da
//     linha; o que for enviado pelo painel fica "na fila" (nada sai da máquina);
//   - linha QR de teste: sem janela, com editar/apagar/menções; os envios são
//     confirmados (enviada -> entregue -> lida) enquanto `--connector` roda;
//   - "simulação" (sem linha, etiqueta Simulação): o envio é entregue na hora.
//
// Variáveis só para teste isolado: WABOTIA_LOCAL_PERSIST (pasta de
// `wrangler dev --persist-to`) e WABOTIA_SEED_LOGINS (outro arquivo de logins).
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const loginsFile = process.env.WABOTIA_SEED_LOGINS
  ? resolve(process.env.WABOTIA_SEED_LOGINS)
  : join(root, "seed-logins.local.json");
// Para testar contra uma instância isolada (wrangler dev --persist-to DIR).
const persist = process.env.WABOTIA_LOCAL_PERSIST
  ? ["--persist-to", resolve(process.env.WABOTIA_LOCAL_PERSIST)]
  : [];
const wranglerBin = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

// --- somente servidor local -------------------------------------------------
const base = String(
  option("--url") || process.env.WABOTIA_LOCAL_URL || "http://127.0.0.1:8787",
).replace(/\/+$/, "");
const host = (() => {
  try {
    return new URL(base).hostname;
  } catch {
    return "";
  }
})();
if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
  console.error(
    "Este script só roda contra o servidor local (localhost, 127.0.0.1 ou [::1]). Endereço recusado.",
  );
  process.exit(2);
}

const origin = new URL(base).origin;
const log = (text) => console.log("- " + text);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const NOW = Date.now();
const MIN = 60_000;
/** Instante "há N minutos". */
const ago = (minutes) => Math.round(NOW - minutes * MIN);
const hex = (bytes) => randomBytes(bytes).toString("hex");
const password = () => randomBytes(15).toString("base64url"); // 20 caracteres
const sq = (value) =>
  value === null || value === undefined
    ? "NULL"
    : typeof value === "number"
      ? String(Math.round(value))
      : "'" + String(value).replaceAll("'", "''") + "'";
const sqJson = (value) => sq(JSON.stringify(value));

// --- D1 local (nunca --remote) ----------------------------------------------
function wrangler(parameters) {
  return execFileSync(process.execPath, [wranglerBin, ...parameters], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    maxBuffer: 64 * 1024 * 1024,
  });
}
function d1Query(sql) {
  const out = wrangler([
    "d1",
    "execute",
    "DB",
    "--local",
    ...persist,
    "--json",
    "--command",
    sql,
  ]);
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return parsed[0]?.results || [];
}
function d1Run(statements) {
  if (!statements.length) return;
  const dir = mkdtempSync(join(tmpdir(), "wabotia-seed-"));
  const file = join(dir, "seed.sql");
  try {
    writeFileSync(file, statements.join(";\n") + ";\n", "utf8");
    wrangler(["d1", "execute", "DB", "--local", ...persist, "--yes", "--file", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function ensureMigrations() {
  const columns = d1Query("SELECT name FROM pragma_table_info('tickets')").map(
    (row) => row.name,
  );
  if (!columns.length)
    throw new Error(
      "Banco local sem tabelas. Rode `npm run migrate:local` e inicie `npm run dev`.",
    );
  if (!existsSync(join(root, "migrations", "0016_service_center.sql"))) return;
  if (columns.includes("category")) return;
  log("aplicando migrações locais pendentes (wrangler d1 migrations apply DB --local)");
  wrangler(["d1", "migrations", "apply", "DB", "--local", ...persist]);
}
/** Apaga todas as linhas do D1 local (a instalação volta a pedir o primeiro administrador). */
function resetLocalDatabase() {
  const tables = d1Query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'chunks_%'",
  ).map((row) => row.name);
  // Filhos antes dos pais; o que sobrar é repetido até não haver mais erro de chave.
  const first = [
    "conversation_contacts",
    "internal_messages",
    "internal_chats",
    "media_parts",
    "media_uploads",
    "whatsapp_groups",
    "calls",
    "router_affinities",
    "number_pool_members",
    "number_router_grants",
    "number_pools",
    "meta_numbers",
    "meta_accounts",
    "team_connection_presence",
    "messages",
    "contacts",
    "api_keys",
    "sessions",
    "devices",
    "bots",
    "conversations",
    "connections",
  ].filter((name) => tables.includes(name));
  const ordered = [...first, ...tables.filter((name) => !first.includes(name))];
  d1Run([
    "PRAGMA defer_foreign_keys = true",
    ...ordered.map((name) => `DELETE FROM "${name}"`),
  ]);
}

// --- HTTP com cookie de sessão ------------------------------------------------
class ApiFailure extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
async function parse(response) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* sem corpo JSON */
  }
  if (!response.ok)
    throw new ApiFailure(
      response.status,
      data?.error?.code || "",
      data?.error?.message || `HTTP ${response.status}`,
    );
  return data;
}
async function publicCall(path, method = "GET", body) {
  return parse(
    await fetch(base + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}
class Session {
  constructor(person) {
    this.person = person;
    this.cookie = "";
  }
  async login(retry = true) {
    const response = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: this.person.email,
        password: this.person.password,
      }),
    });
    if (response.status === 429 && retry) {
      // Limite de tentativas de login por IP: no banco local pode ser zerado.
      d1Run(["DELETE FROM rate_limits WHERE key LIKE 'login:%'"]);
      return this.login(false);
    }
    await parse(response);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .find((value) => value.startsWith("wabotia="));
    if (!cookie) throw new Error("O servidor não devolveu o cookie de sessão.");
    this.cookie = cookie;
    this.me = await this.call("v1/me");
    return this;
  }
  async call(path, method = "GET", body, key) {
    const write = method !== "GET";
    return parse(
      await fetch(base + "/api/" + path, {
        method,
        headers: {
          Cookie: this.cookie,
          // Escritas com cookie exigem a mesma origem do servidor.
          ...(write ? { Origin: origin, "Content-Type": "application/json" } : {}),
          ...(write ? { "Idempotency-Key": key || randomUUID() } : {}),
        },
        body: write ? JSON.stringify(body ?? {}) : undefined,
      }),
    );
  }
  /** Envio em partes, como o painel e os aplicativos fazem. */
  async upload(area, name, type, bytes) {
    const upload = await this.call(`${area}/media/uploads`, "POST", {
      name,
      type,
      size: bytes.length,
    });
    for (let part = 0; part < upload.parts; part++)
      await parse(
        await fetch(
          `${base}/api/${area}/media/uploads/${upload.id}/parts/${part + 1}`,
          {
            method: "PUT",
            headers: {
              Cookie: this.cookie,
              Origin: origin,
              "Content-Type": "application/octet-stream",
              "Idempotency-Key": `${upload.id}:${part + 1}`,
            },
            body: bytes.subarray(
              part * upload.part_size,
              (part + 1) * upload.part_size,
            ),
          },
        ),
      );
    return (
      await this.call(`${area}/media/uploads/${upload.id}/complete`, "POST", {})
    ).id;
  }
}

// --- arquivos pequenos e válidos, gerados em memória -----------------------------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** PNG 480×320 com cara de comprovante (faixa verde, linhas e um selo). */
function pngReceipt() {
  const width = 480,
    height = 320;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      let color = [250, 250, 247];
      if (y < 64) color = [0, 128 + Math.round((x / width) * 40), 105];
      else if (x > 36 && x < 444 && y > 96 && (y - 96) % 34 < 9 && y < 250)
        color = (y - 96) % 68 < 34 ? [205, 212, 216] : [226, 231, 234];
      else if ((x - 400) ** 2 + (y - 268) ** 2 < 26 ** 2) color = [37, 211, 102];
      if (y < 64 && x > 36 && x < 220 && y > 24 && y < 40) color = [255, 255, 255];
      raw.set(color, row + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/** PDF de uma página com três linhas de texto. */
function pdfStatement() {
  const stream =
    "BT /F1 20 Tf 60 760 Td (Extrato - novembro/2026) Tj ET\n" +
    "BT /F1 12 Tf 60 724 Td (03/11  PIX recebido  R$ 189,90) Tj ET\n" +
    "BT /F1 12 Tf 60 704 Td (03/11  PIX recebido  R$ 189,90  (duplicado)) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    pdf += String(offset).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
/** OGG/Opus mono com `seconds` de silêncio (quadros de 20 ms). */
function oggSilence(seconds, serial) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let r = n << 24;
    for (let k = 0; k < 8; k++)
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    return r >>> 0;
  });
  const oggCrc = (bytes) => {
    let c = 0;
    for (const byte of bytes) c = ((c << 8) ^ table[((c >>> 24) ^ byte) & 0xff]) >>> 0;
    return c;
  };
  let sequence = 0;
  const page = (packets, granule, type) => {
    const data = Buffer.concat(packets);
    const head = Buffer.alloc(27 + packets.length);
    head.write("OggS", 0, "ascii");
    head[5] = type;
    head.writeBigUInt64LE(BigInt(granule), 6);
    head.writeUInt32LE(serial, 14);
    head.writeUInt32LE(sequence++, 18);
    head[26] = packets.length;
    packets.forEach((packet, index) => (head[27 + index] = packet.length));
    const out = Buffer.concat([head, data]);
    out.writeUInt32LE(oggCrc(out), 22);
    return out;
  };
  const opusHead = Buffer.alloc(19);
  opusHead.write("OpusHead", 0, "ascii");
  opusHead[8] = 1; // versão
  opusHead[9] = 1; // canais
  opusHead.writeUInt16LE(312, 10); // pre-skip
  opusHead.writeUInt32LE(48000, 12);
  const vendor = Buffer.from("wabotia-seed", "ascii");
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write("OpusTags", 0, "ascii");
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  const pages = [page([opusHead], 0, 2), page([tags], 0, 0)];
  const silence = Buffer.from([0xf8, 0xff, 0xfe]);
  for (let second = 1; second <= seconds; second++)
    pages.push(
      page(
        Array.from({ length: 50 }, () => silence),
        312 + second * 48000,
        second === seconds ? 4 : 0,
      ),
    );
  return Buffer.concat(pages);
}

// --- pessoas e configuração da área ------------------------------------------------
const people = () => ({
  admin: {
    name: "Camila Duarte",
    email: "camila.duarte@wabotia.test",
    password: password(),
  },
  operators: [
    {
      name: "Ana Beatriz Lopes",
      email: "ana.lopes@wabotia.test",
      password: password(),
    },
    {
      name: "Bruno Carvalho",
      email: "bruno.carvalho@wabotia.test",
      password: password(),
    },
  ],
});
const categories = [
  { id: "wabotia", name: "Wabotia", enabled: true },
  { id: "printher", name: "Printher", enabled: true },
  { id: "fagoo-erp", name: "Fagoo ERP", enabled: true },
  { id: "pagamentos", name: "Pagamentos e notas", enabled: true },
  { id: "outro", name: "Outro ou não sei", enabled: true },
];
const BOT_ATTENDANT = "seed-bot-atendente",
  BOT_FINANCE = "seed-bot-financeiro";
const menus = (withTicket) =>
  [
    { id: "seed-suporte", label: "Suporte técnico", type: "submenu" },
    {
      id: "seed-suporte-bot",
      parent_id: "seed-suporte",
      label: "Tirar dúvida com o assistente",
      type: "bot",
      bot_id: BOT_ATTENDANT,
    },
    {
      id: "seed-suporte-pessoa",
      parent_id: "seed-suporte",
      label: "Falar com o suporte",
      type: "human",
      department_id: "suporte",
    },
    withTicket && {
      id: "seed-suporte-protocolo",
      parent_id: "seed-suporte",
      label: "Abrir protocolo",
      type: "ticket",
      category_id: "wabotia",
      content:
        "Descreva em uma mensagem o que aconteceu. Se puder, diga o que tentou.",
    },
    { id: "seed-financeiro", label: "Financeiro", type: "submenu" },
    {
      id: "seed-financeiro-boleto",
      parent_id: "seed-financeiro",
      label: "Segunda via de boleto",
      type: "content",
      content:
        "Para a segunda via, informe seu CPF ou CNPJ. O boleto atualizado chega em instantes por aqui.",
    },
    {
      id: "seed-financeiro-pessoa",
      parent_id: "seed-financeiro",
      label: "Falar com o financeiro",
      type: "human",
      department_id: "financeiro",
    },
    { id: "seed-protocolos", label: "Meus protocolos", type: "protocols" },
    {
      id: "seed-horario",
      label: "Horário de atendimento",
      type: "content",
      content: "Atendemos de segunda a sexta, das 9h às 18h (horário de Brasília).",
    },
    {
      id: "seed-site",
      label: "Central de ajuda",
      type: "link",
      url: "https://ajuda.exemplo.com.br",
      content: "Artigos e vídeos passo a passo:",
    },
    {
      id: "seed-avaliar",
      label: "Avaliar o atendimento",
      type: "survey",
      trigger: "manual",
    },
  ]
    .filter(Boolean)
    .map((item) => ({ enabled: true, line_ids: [], trigger: "automatic", ...item }));

// --- roteiro das conversas -----------------------------------------------------------
// line: "official" (Zernio: janela de 24 h), "qr" (sem janela) ou "sim" (sem linha:
// o envio pelo painel é entregue na hora). Passos: in (cliente), out (equipe),
// note, bot (inserido no D1), act (ação da API). `t` = minutos atrás.
const conversations = [
  {
    key: "thiago",
    line: "official",
    phone: "5519991234001",
    steps: [
      { t: 4300, in: "Quero uma proposta para 15 licenças do Fagoo ERP." },
      // Ninguém online neste momento: o encaminhamento abre um protocolo sozinho.
      { act: "transfer", by: "admin", department_id: "comercial" },
    ],
    final: { state: "waiting", department_id: "comercial" },
  },
  {
    key: "mariana",
    line: "official",
    phone: "5511987654321",
    contact: {
      name: "Mariana Albuquerque",
      email: "mariana.albuquerque@exemplo.com.br",
      company: "Studio Albuquerque",
      notes: "Cliente desde 2023. Prefere contato pela manhã.",
    },
    tags: ["VIP", "Financeiro"],
    steps: [
      {
        t: 1560,
        id: "m1",
        in: "Boa tarde! Fiz um PIX em duplicidade na mensalidade de novembro. Conseguem me ajudar?",
      },
      {
        t: 1559,
        bot: "Olá, Mariana! Sou o assistente virtual. Vou encaminhar você para o financeiro.",
      },
      { act: "claim", by: "admin" },
      {
        t: 1550,
        out: "Oi, Mariana! Aqui é a Camila, do financeiro. Pode me enviar o comprovante do segundo pagamento, por favor?",
        status: "read",
      },
      {
        t: 1545,
        id: "m-comprovante",
        in: "Segue o comprovante",
        file: "image",
      },
      { t: 1544, in: "", file: "voice" },
      {
        t: 1540,
        note: "Cliente VIP. Confirmar no banco antes de prometer prazo de estorno.",
      },
      {
        t: 1535,
        out: "Recebido! Localizei os dois lançamentos aqui.",
        quote: "m-comprovante",
        status: "read",
      },
      {
        t: 1534,
        out: "Segue o extrato com os dois lançamentos destacados.",
        file: "document",
        status: "read",
      },
      {
        act: "ticket",
        by: "admin",
        ticket: "estorno",
      },
      { t: 70, in: "Bom dia! Alguma novidade sobre o estorno?" },
      {
        t: 66,
        id: "m-estorno",
        out: "Bom dia! O banco confirmou o estorno: o valor cai na sua conta até amanhã.",
        status: "read",
        reaction: { by: "customer", emoji: "❤️" },
      },
      {
        t: 64,
        in: "Aproveitando: a loja ainda fica neste endereço?",
        content: {
          type: "location",
          location: {
            latitude: -23.561414,
            longitude: -46.655881,
            name: "Av. Paulista, 1578",
            address: "Bela Vista, São Paulo - SP",
          },
        },
      },
      {
        t: 60,
        out: "Mudamos! Agora estamos aqui:",
        content: {
          type: "location",
          location: {
            latitude: -23.556735,
            longitude: -46.662222,
            name: "Wabotia Store · Consolação",
            address: "Rua da Consolação, 2302 - São Paulo - SP",
          },
        },
        status: "read",
      },
      {
        t: 58,
        in: "Pode combinar a retirada com meu marido:",
        content: {
          type: "contacts",
          contacts: [{ name: "Carlos Albuquerque", phone: "5511912345678" }],
        },
      },
      {
        t: 57,
        out: "",
        content: {
          type: "contacts",
          contacts: [{ name: "Retiradas Wabotia Store", phone: "551140001234" }],
        },
        status: "delivered",
      },
      { t: 56, out: "", file: "voice", status: "played" },
      {
        t: 55,
        in: "Perfeito, muito obrigada! 🙏",
        reaction: { by: "admin", emoji: "👍" },
      },
      {
        t: 54,
        out: "Imagina! Qualquer coisa é só chamar.",
        status: "delivered",
      },
      {
        t: 53,
        out: "Se preferir, a segunda via do recibo fica em https://exemplo.com.br/recibos/1189",
        status: "sent",
      },
      {
        t: 52,
        out: "Também enviei o recibo para o seu e-mail cadastrado.",
        status: "failed",
      },
    ],
    // Linhas de estado de entrega (fila e falha) que não viraram mensagem.
    outbox: [
      {
        t: 51,
        text: "Vou acompanhar e aviso assim que o valor cair.",
        status: "pending",
      },
      {
        t: 50,
        text: "Segue o vídeo com o passo a passo da retirada.",
        status: "failed",
        error: "O arquivo excede o limite do canal (16 MB).",
      },
    ],
  },
  {
    key: "joao",
    line: "official",
    phone: "5521998765432",
    contact: { name: "João Pedro Santos", company: "Mercado Santos" },
    tags: ["Suporte"],
    steps: [
      { t: 16, in: "Olá, meu aplicativo não sincroniza desde ontem." },
      { t: 15, in: "Já reinstalei e continua igual." },
      { act: "transfer", by: "admin", department_id: "suporte" },
    ],
    final: { state: "waiting", department_id: "suporte", updated: 12 },
  },
  {
    key: "carla",
    line: "official",
    phone: "5531997001122",
    steps: [{ t: 3, in: "Boa tarde, quero saber sobre o plano mensal." }],
    final: { state: "waiting" },
  },
  {
    key: "rafael",
    line: "official",
    phone: "5541996003344",
    contact: { name: "Rafael Lima" },
    steps: [
      { t: 1150, in: "Oi! Qual o horário de atendimento de vocês?" },
      {
        t: 1149,
        bot: "Olá, Rafael! Atendemos de segunda a sexta, das 9h às 18h. Posso ajudar em algo mais?",
      },
      { t: 1146, in: "E no sábado?" },
      {
        t: 1145,
        bot: "Aos sábados o atendimento é somente pelo assistente virtual. Se precisar de uma pessoa, envie MENU.",
      },
    ],
    final: { state: "ai", assigned_bot_id: BOT_ATTENDANT },
  },
  {
    key: "beatriz",
    line: "official",
    phone: "5551995005566",
    steps: [
      { t: 8, in: "Bom dia" },
      {
        t: 8,
        bot: "Olá! Escolha uma opção:\n1. Suporte técnico\n2. Financeiro\n3. Meus protocolos\n4. Horário de atendimento",
      },
      { t: 7, in: "1" },
      {
        t: 7,
        bot: "Suporte técnico:\n1. Tirar dúvida com o assistente\n2. Falar com o suporte\n3. Abrir protocolo\n\nEnvie VOLTAR para o menu anterior.",
      },
    ],
    final: { state: "ai" },
  },
  {
    key: "lucas",
    line: "official",
    phone: "5511976543210",
    contact: { name: "Lucas Ferreira", company: "Ferreira & Filhos Ltda" },
    tags: ["Urgente", "Fiscal"],
    steps: [
      { t: 1445, in: "Preciso emitir a nota fiscal do pedido 4821 ainda hoje." },
      { act: "claim", by: "admin" },
      {
        t: 1440,
        out: "Olá, Lucas! Vou verificar com o fiscal e já retorno.",
        status: "read",
      },
      { t: 1438, note: "Fiscal pediu o CNPJ atualizado antes de emitir." },
      { t: 1400, in: "Meu CNPJ é 12.345.678/0001-90. Conseguem hoje?" },
      { act: "ticket", by: "admin", ticket: "nota" },
    ],
  },
  {
    key: "fernanda",
    line: "official",
    phone: "5519988112233",
    contact: { name: "Fernanda Rocha" },
    steps: [
      { t: 1700, in: "Vocês entregam em Campinas?" },
      { act: "claim", by: "admin" },
      {
        t: 1690,
        out: "Entregamos sim! O frete para Campinas é R$ 25,00.",
        status: "read",
      },
      { t: 1600, in: "Ótimo, vou pensar e retorno." },
      { act: "ticket", by: "admin", ticket: "frete" },
    ],
    outbox: [
      {
        t: 20,
        text: "Oi, Fernanda! Ainda tem interesse? Consigo garantir o frete até sexta.",
        status: "pending",
        error: "Aguardando nova mensagem do cliente (janela de 24h)",
      },
    ],
  },
  {
    key: "paulo",
    line: "official",
    phone: "5562994447788",
    contact: { name: "Paulo Henrique Dias" },
    tags: ["Financeiro"],
    steps: [
      { t: 900, in: "Boa noite, o boleto deste mês veio com o valor errado." },
      { act: "claim", by: "op1" },
      {
        t: 895,
        out: "Boa noite, Paulo! Sou a Ana, do financeiro. Vou corrigir e reenviar.",
        by: "op1",
        status: "read",
      },
      { act: "ticket", by: "op1", ticket: "boleto" },
    ],
  },
  {
    key: "juliana",
    line: "official",
    phone: "5571993336655",
    contact: { name: "Juliana Castro" },
    steps: [
      { t: 1262, in: "Quero cancelar meu pedido 7730." },
      { act: "claim", by: "op2" },
      {
        t: 1260,
        out: "Oi, Juliana. Posso saber o motivo do cancelamento?",
        by: "op2",
        status: "read",
      },
      { t: 1255, in: "Demorou demais para chegar." },
      { act: "ticket", by: "op2", ticket: "cancelamento" },
    ],
  },
  {
    key: "marcos",
    line: "official",
    phone: "5585992221100",
    contact: { name: "Marcos Vinícius Oliveira", company: "Papelaria Oliveira" },
    tags: ["Suporte"],
    steps: [
      { t: 2900, in: "O leitor de código de barras parou de funcionar no Printher." },
      { act: "claim", by: "admin" },
      {
        t: 2895,
        out: "Olá, Marcos! Vamos resolver. Qual é o modelo do leitor?",
        status: "read",
      },
      { t: 2890, in: "É o BR-400." },
      { act: "ticket", by: "admin", ticket: "leitor" },
      {
        t: 2880,
        out: "Atualize o driver pelo link do manual, página 12, e reinicie o aplicativo.",
        status: "read",
      },
      { t: 2860, in: "Funcionou, obrigado!" },
      { act: "ticket-resolve", by: "admin", ticket: "leitor" },
      { act: "resolve", by: "admin" },
      { t: 2855, in: "5 Atendimento rápido e atencioso" },
    ],
  },
  {
    key: "patricia",
    line: "official",
    phone: "5527991110099",
    steps: [
      { t: 1500, in: "Qual o prazo de garantia do equipamento?" },
      { act: "claim", by: "admin" },
      {
        t: 1495,
        out: "Olá, Patrícia! A garantia é de 12 meses a partir da nota fiscal.",
        status: "read",
      },
      { t: 1490, in: "Obrigada!" },
      { act: "ticket", by: "admin", ticket: "garantia" },
      { act: "resolve", by: "admin" },
    ],
  },
  {
    key: "renata",
    line: "qr",
    phone: "5511955443322",
    contact: { name: "Renata Barros" },
    steps: [
      { t: 30, in: "Oi, vocês têm o cabo USB-C de 2 metros?" },
      { act: "claim", by: "admin" },
      {
        t: 26,
        out: "Temos sim, Renata! Sai por R$ 39,90.",
        status: "read",
      },
      { t: 20, in: "Separa um pra mim?" },
      {
        t: 4,
        out: "Separado! Pode retirar até as 18h.",
        status: "delivered",
      },
    ],
  },
  {
    key: "eduardo",
    line: "sim",
    phone: "5511900000001",
    contact: { name: "Eduardo Martins (simulação)" },
    tags: ["Simulação"],
    steps: [
      {
        t: 10,
        in: "Olá! Esta é uma conversa de simulação para testar os envios.",
      },
      { act: "claim", by: "admin" },
      {
        t: 9,
        out: "Perfeito! O que for enviado aqui é entregue na hora.",
        status: "read",
      },
    ],
  },
  {
    key: "debora",
    line: "sim",
    phone: "5511900000002",
    contact: { name: "Débora Nunes (simulação)" },
    tags: ["Simulação"],
    steps: [
      { t: 6, in: "Oi, preciso de ajuda para configurar a impressora." },
      { act: "transfer", by: "admin", department_id: "suporte" },
    ],
    final: { state: "waiting", department_id: "suporte" },
  },
  {
    key: "sofia",
    line: "sim",
    phone: "5511900000003",
    tags: ["Simulação"],
    steps: [{ t: 2, in: "Boa tarde! Vocês atendem aos sábados?" }],
    final: { state: "ai" },
  },
];
// Protocolos: estado final, responsável, categoria, prazo e andamentos.
// created/due/answered em minutos (due negativo = prazo no futuro).
const tickets = {
  estorno: {
    title: "Estorno de PIX em duplicidade",
    category: "pagamentos",
    status: "in_progress",
    text: "Solicitamos o estorno ao banco. O prazo é de até 3 dias úteis.",
    internal: "Banco abriu o chamado 88213. Conferir o retorno amanhã cedo.",
    created: 1530,
    due: -2880,
    answered: 1525,
  },
  nota: {
    title: "Emissão da nota fiscal do pedido 4821",
    category: "pagamentos",
    status: "open",
    created: 1398,
    due: -45, // vence em 45 minutos
  },
  frete: {
    title: "Confirmar frete promocional para Campinas",
    category: "outro",
    status: "in_progress",
    internal: "Comercial ainda não respondeu sobre a validade da promoção.",
    created: 4200,
    due: 1440, // atrasado há 1 dia
  },
  boleto: {
    title: "Boleto de novembro com valor incorreto",
    category: "fagoo-erp",
    status: "waiting_customer",
    text: "Para emitir o novo boleto, precisamos do número do contrato.",
    created: 890,
    due: -3000,
    answered: 889,
  },
  cancelamento: {
    title: "Cancelamento do pedido 7730",
    category: "outro",
    status: "waiting_third",
    internal: "Transportadora vai confirmar se o pacote já saiu para entrega.",
    created: 1250,
    due: -2500,
  },
  leitor: {
    title: "Leitor de código de barras BR-400 sem resposta",
    category: "printher",
    status: "resolved",
    text: "Orientamos a atualização do driver do leitor.",
    resolveText: "Cliente confirmou que o leitor voltou a funcionar.",
    created: 2888,
    due: 1400,
    answered: 2887,
  },
  garantia: {
    title: "Dúvida sobre o prazo de garantia",
    category: "printher",
    status: "closed",
    created: 1489,
    due: 49,
    answered: 1488,
  },
};
const fallbackStatus = {
  waiting_customer: "in_progress",
  waiting_third: "in_progress",
  resolved: "closed",
};

// --- execução ---------------------------------------------------------------------------
function readLogins() {
  if (!existsSync(loginsFile)) return null;
  return JSON.parse(readFileSync(loginsFile, "utf8"));
}
function saveLogins(data) {
  writeFileSync(loginsFile, JSON.stringify(data, null, 2) + "\n", "utf8");
}
function setupToken() {
  const file = join(root, ".dev.vars");
  if (!existsSync(file))
    throw new Error("Arquivo .dev.vars não encontrado (SETUP_TOKEN local).");
  const line = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((entry) => /^\s*SETUP_TOKEN\s*=/.test(entry));
  const value = (line || "")
    .replace(/^\s*SETUP_TOKEN\s*=\s*/, "")
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!value) throw new Error("SETUP_TOKEN ausente em .dev.vars.");
  return value;
}
async function waitForServer() {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const health = await publicCall("/api/health");
      if (health?.service === "wabotia" || health?.ok || health) return;
    } catch {
      /* tenta de novo */
    }
    await sleep(1500);
  }
  throw new Error(
    `O servidor local não respondeu em ${base}. Inicie com \`npm run dev\` e confira se o Worker compilou.`,
  );
}

async function seed() {
  await waitForServer();
  ensureMigrations();
  if (flag("--reset")) {
    log("apagando o D1 local (--reset)");
    resetLocalDatabase();
    if (existsSync(loginsFile)) rmSync(loginsFile);
  }
  const status = await publicCall("/api/auth/status");
  if (!status.configured)
    throw new Error("MASTER_KEY e SETUP_TOKEN precisam estar em .dev.vars.");
  let logins = readLogins();
  if (status.initialized && !logins)
    throw new Error(
      "A instalação local já tem um administrador, mas seed-logins.local.json não existe.\n" +
        "Para recomeçar: rode `node scripts/seed-local.mjs --reset` (apaga o D1 local), ou pare o wrangler,\n" +
        "apague a pasta .wrangler/state, rode `npm run migrate:local`, inicie `npm run dev` e rode este script.",
    );
  if (!status.initialized) {
    logins = { url: base, ...people(), profile_id: null };
    await publicCall("/api/auth/setup", "POST", {
      token: setupToken(),
      name: logins.admin.name,
      email: logins.admin.email,
      password: logins.admin.password,
    });
    saveLogins(logins);
    log("administrador de teste criado");
  }
  const admin = await new Session(logins.admin).login();

  // Área de atendimento.
  let profiles = await admin.call("v1/profiles");
  if (!profiles.length) {
    await admin.call("v1/installation/area/bootstrap", "POST", {});
    profiles = await admin.call("v1/profiles");
  }
  const profile = profiles[0].id,
    area = "v1/profiles/" + profile;
  logins.profile_id = profile;
  saveLogins(logins);

  if (logins.seed?.done) return refresh(logins, admin, area);
  const existing = (await admin.call(area + "/status")).conversations || [];
  if (existing.some((row) => row.count > 0))
    throw new Error(
      "Já existem conversas nesta instalação e a carga anterior não terminou.\n" +
        "Rode `node scripts/seed-local.mjs --reset` para apagar o D1 local e recriar tudo.",
    );

  // Pessoas.
  const users = await admin.call("v1/users");
  for (const operator of logins.operators)
    if (!users.some((user) => user.email === operator.email))
      await admin.call("v1/users", "POST", {
        name: operator.name,
        email: operator.email,
        password: operator.password,
        role: "operator",
        profiles: [profile],
      });
  const op1 = await new Session(logins.operators[0]).login(),
    op2 = await new Session(logins.operators[1]).login();
  const sessions = { admin, op1, op2 };
  const ids = { admin: admin.me.id, op1: op1.me.id, op2: op2.me.id };
  log("2 atendentes de teste criados");

  // Linhas e Hermes de mentira (nada aqui é ativado contra serviços reais:
  // a linha oficial fica pausada e o endereço do Hermes não existe).
  const connect = async (body) =>
    (await admin.call(area + "/connections", "POST", body)).id;
  const official = await connect({
    name: "WhatsApp Oficial · Matriz",
    kind: "zernio",
    config: {
      number: "5511940001000",
      account_id: hex(12),
      zernio_profile_id: hex(12),
      groups_enabled: true,
    },
    secrets: { api_key: "local-seed-" + hex(8), webhook_secret: hex(16) },
  });
  const qr = await connect({
    name: "Loja Centro · QR",
    kind: "qr",
    config: { number: "5511940002000" },
  });
  const connectorToken = (
    await admin.call(`${area}/connections/${qr}/connector-token`, "POST", {})
  ).token;
  const hermes = await connect({
    name: "Hermes (demonstração)",
    kind: "hermes",
    config: {
      url: "https://hermes.demonstracao.invalid",
      api_url: "https://api-hermes.demonstracao.invalid",
    },
    secrets: { profile_keys: { atendente: "local-seed-" + hex(8) } },
  });
  const hermesFinance = await connect({
    name: "Hermes financeiro (demonstração)",
    kind: "hermes",
    config: {
      url: "https://hermes-financeiro.demonstracao.invalid",
      api_url: "https://api-hermes-financeiro.demonstracao.invalid",
    },
    secrets: { profile_keys: { financeiro: "local-seed-" + hex(8) } },
  });
  // Bots só nascem da descoberta no Hermes; aqui entram direto no D1 local.
  // O Hermes de demonstração fica "visto agora" para o Atendente aparecer online;
  // o financeiro fica pausado (offline). A linha QR fica ativa para o modo --connector.
  const farFuture = NOW + 3650 * 24 * 3600_000;
  d1Run([
    `INSERT OR IGNORE INTO bots(id,profile_id,connection_id,remote_profile,name,enabled,line_ids) VALUES(${sq(BOT_ATTENDANT)},${sq(profile)},${sq(hermes)},'atendente','Atendente virtual',1,NULL)`,
    `INSERT OR IGNORE INTO bots(id,profile_id,connection_id,remote_profile,name,enabled,line_ids) VALUES(${sq(BOT_FINANCE)},${sq(profile)},${sq(hermesFinance)},'financeiro','Especialista financeiro',1,'[]')`,
    `UPDATE connections SET status='active',last_seen=${farFuture},config=json_set(config,'$.verified_at',${NOW}) WHERE id=${sq(hermes)}`,
    `UPDATE connections SET status='active',last_seen=${NOW},config=json_set(config,'$.verified_at',${NOW},'$.protocol_version',2,'$.transport_state','open') WHERE id=${sq(qr)}`,
  ]);
  log("linhas (oficial pausada, QR de teste) e 2 bots criados");

  // Regras, setores, categorias e menus.
  const settings = (withTicket) => ({
    attendant_bot: BOT_ATTENDANT,
    instructions:
      "Cumprimente pelo nome, identifique o aplicativo e o objetivo, responda em passos curtos e ofereça protocolo após duas tentativas.",
    surveys_enabled: true,
    departments: [
      { id: "suporte", name: "Suporte", enabled: true, members: [ids.op1, ids.op2] },
      { id: "financeiro", name: "Financeiro", enabled: true, members: [ids.op1] },
      { id: "comercial", name: "Comercial", enabled: true, members: [ids.op2] },
    ],
    ticket_categories: categories,
    protocol_response_unit: "business_days",
    protocol_response_days: 3,
    business_hours: {
      days: [1, 2, 3, 4, 5],
      start: "09:00",
      end: "18:00",
      holidays: ["2026-11-20", "2026-12-25"],
    },
    capabilities: [
      {
        id: "seed-segunda-via",
        name: "Segunda via de boleto",
        bot_id: BOT_FINANCE,
        condition: "Quando o cliente pedir a segunda via de um boleto.",
        instructions: "Consulte o boleto em aberto e devolva a linha digitável.",
        enabled: true,
      },
    ],
    menus: menus(withTicket),
  });
  let sixStates = true;
  try {
    await admin.call(area + "/settings", "PUT", settings(true));
  } catch (error) {
    if (error.status !== 400) throw error;
    // Servidor anterior à 0.14: sem destino "Abrir protocolo".
    sixStates = false;
    await admin.call(area + "/settings", "PUT", settings(false));
  }
  log("setores, categorias, regras e menus gravados");

  // Arquivos da conversa rica.
  const files = {
    image: await admin.upload(area, "comprovante-pix.png", "image/png", pngReceipt()),
    document: await admin.upload(
      area,
      "extrato-novembro.pdf",
      "application/pdf",
      pdfStatement(),
    ),
    voice: await admin.upload(
      area,
      "mensagem-de-voz.ogg",
      "audio/ogg",
      oggSilence(7, 0x5eed0001),
    ),
    voiceIn: await admin.upload(area, "audio-cliente.ogg", "audio/ogg", oggSilence(12, 0x5eed0002)),
  };
  const fileFor = (step, inbound) =>
    step.file === "voice" ? (inbound ? files.voiceIn : files.voice) : files[step.file];

  // Conversas pela API. A primeira (Thiago) roda antes de alguém ficar online.
  const created = {}; // key -> { id, plan: Map(messageId -> step), ... }
  const ticketIds = {};
  const action = (who, id, body) =>
    sessions[who].call(`${area}/conversations/${id}/actions`, "POST", body);
  const settle = async (id) => {
    // Espera a fila de envio desta conversa esvaziar, para manter a ordem.
    for (let attempt = 0; attempt < 40; attempt++) {
      const detail = await admin.call(`${area}/conversations/${id}`);
      if (
        !(detail.deliveries || []).some((delivery) =>
          ["pending", "sending"].includes(delivery.status),
        )
      )
        return detail;
      await sleep(400);
    }
    throw new Error("A fila de envio local não esvaziou (conversa " + id + ").");
  };
  const patchTicket = async (who, id, body) => {
    try {
      return await sessions[who].call(`${area}/tickets/${id}`, "PATCH", body);
    } catch (error) {
      if (error.status !== 400 || !fallbackStatus[body.status]) throw error;
      sixStates = false;
      return sessions[who].call(`${area}/tickets/${id}`, "PATCH", {
        ...body,
        status: fallbackStatus[body.status],
      });
    }
  };
  let presenceSet = false;
  for (const conversation of conversations) {
    const plan = new Map(),
      refs = {},
      botSteps = [];
    let id = null,
      sequence = 0;
    for (const step of conversation.steps) {
      if (step.in !== undefined) {
        const result = await admin.call(area + "/inbound", "POST", {
          external_id: conversation.phone,
          message_id: `seed-${conversation.key}-${++sequence}`,
          text: step.in,
          ...(step.file ? { attachments: [fileFor(step, true)] } : {}),
          ...(step.content || step.file
            ? { content: step.content || { type: step.file } }
            : {}),
        });
        id = result.conversation_id;
        plan.set(result.message_id, step);
        if (step.id) refs[step.id] = result.message_id;
      } else if (step.out !== undefined) {
        const who = step.by || "admin";
        const content = {
          ...(step.content || (step.file ? { type: step.file } : {})),
          ...(step.quote ? { reply_to: refs[step.quote] } : {}),
        };
        const result = await action(who, id, {
          action: "reply",
          text: step.out,
          ...(step.file ? { attachments: [fileFor(step, false)] } : {}),
          ...(Object.keys(content).length ? { content } : {}),
        });
        plan.set("delivery:" + result.delivery_id, step);
        if (step.id) refs[step.id] = "delivery:" + result.delivery_id;
        await settle(id);
      } else if (step.note !== undefined) {
        await action(step.by || "admin", id, { action: "note", text: step.note });
        plan.set("note:" + step.note, step);
      } else if (step.bot !== undefined) {
        botSteps.push(step);
      } else if (step.act === "ticket") {
        const spec = tickets[step.ticket];
        const ticket = await sessions[step.by].call(area + "/tickets", "POST", {
          conversation_id: id,
          title: spec.title,
          category: spec.category,
        });
        ticketIds[step.ticket] = ticket.id;
        if (spec.status !== "open" || spec.text)
          await patchTicket(step.by, ticket.id, {
            status:
              spec.status === "resolved" || spec.status === "closed"
                ? spec.text
                  ? "in_progress"
                  : spec.status
                : spec.status,
            owner: ids[step.by],
            ...(spec.text ? { text: spec.text } : {}),
          });
        await settle(id);
      } else if (step.act === "ticket-resolve") {
        const spec = tickets[step.ticket];
        await patchTicket(step.by, ticketIds[step.ticket], {
          status: spec.status,
          text: spec.resolveText,
        });
        await settle(id);
      } else {
        const { act, by, ...body } = step;
        await action(by, id, { action: act, ...body });
        await settle(id);
      }
    }
    if (conversation.tags)
      await action("admin", id, { action: "tags", tags: conversation.tags });
    if (conversation.contact)
      await admin.call(`${area}/conversations/${id}/contact`, "PUT", {
        phone: conversation.phone,
        ...conversation.contact,
      });
    created[conversation.key] = { id, plan, botSteps };
    if (!presenceSet) {
      // A partir daqui a equipe está presente (Camila e Ana online, Bruno offline).
      await admin.call(area + "/presence", "PUT", { present: true });
      await op1.call(area + "/presence", "PUT", { present: true });
      await op2.call(area + "/presence", "PUT", { present: false });
      presenceSet = true;
    }
  }
  log(`${conversations.length} conversas criadas pela API`);

  // Conversa interna entre pessoas.
  const chat = await admin.call(area + "/internal-chats", "POST", { peer_id: ids.op1 });
  const internal = [
    ["admin", "Ana, você consegue assumir os boletos hoje à tarde?"],
    ["op1", "Consigo sim! Termino o do Paulo e pego os próximos."],
    ["admin", "Ótimo. O da Mariana eu sigo acompanhando, o estorno sai amanhã."],
    ["op1", "Combinado. Se o banco atrasar eu aviso por aqui. 👍"],
  ];
  for (const [who, text] of internal)
    await sessions[who].call(`${area}/internal-chats/${chat.id}/messages`, "POST", { text });
  const chat2 = await admin.call(area + "/internal-chats", "POST", { peer_id: ids.op2 });
  await op2.call(`${area}/internal-chats/${chat2.id}/messages`, "POST", {
    text: "Camila, a transportadora ainda não respondeu sobre o pedido 7730. Volto amanhã às 9h.",
  });

  // --- ajustes no D1 local ------------------------------------------------------------
  const sql = [];
  const lineId = { official, qr, sim: null };
  const seededConversations = [];
  let autoTicket = null;
  for (const conversation of conversations) {
    const entry = created[conversation.key];
    const detail = await admin.call(`${area}/conversations/${entry.id}`);
    const c = detail.conversation;
    seededConversations.push(c.id);
    // Momento planejado de cada mensagem; as geradas pelo sistema seguem a anterior.
    let last = 0,
      lastCustomer = 0,
      first = 0;
    const timed = detail.messages.map((message) => {
      const step =
        entry.plan.get(message.id) ||
        (message.direction === "note" ? entry.plan.get("note:" + message.text) : null);
      const at = step ? ago(step.t) : last + 2000;
      last = Math.max(at, last + 1);
      return { message, step, at: last };
    });
    // Respostas do bot entram direto no D1, no momento planejado.
    for (const [index, step] of entry.botSteps.entries())
      timed.push({
        bot: true,
        step,
        at: ago(step.t) + 20_000,
        message: { id: `seed-bot-${conversation.key}-${index}` },
      });
    timed.sort((a, b) => a.at - b.at);
    for (const item of timed) {
      first ||= item.at;
      if (item.bot) {
        sql.push(
          `INSERT OR IGNORE INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,external_id,created,source_key,content,delivery_status,status_at) VALUES(${sq(item.message.id)},${sq(profile)},${sq(c.id)},'outbound',${sq("bot:" + BOT_ATTENDANT)},${sq(item.step.bot)},'[]',${sq("seed." + item.message.id)},${item.at},${sq(item.message.id)},'{"type":"text"}','read',${item.at + 60_000})`,
        );
        continue;
      }
      const { message, step } = item;
      const sets = [`created=${item.at}`];
      if (message.direction === "customer") {
        lastCustomer = Math.max(lastCustomer, item.at);
        if (lineId[conversation.line])
          sets.push(
            `author=${sq(`customer:channel:${lineId[conversation.line]}:${conversation.phone}`)}`,
          );
      }
      if (message.direction === "outbound") {
        const state = step?.status || "read";
        sets.push(`delivery_status=${sq(state)}`, `status_at=${item.at + 45_000}`);
      }
      if (step?.reaction) {
        const author = step.reaction.by === "customer" ? "customer" : ids[step.reaction.by];
        sets.push(
          `content=json_set(content,'$.reactions',json(${sqJson({
            [author]: { emoji: step.reaction.emoji, timestamp: item.at + 30_000 },
          })}))`,
        );
      }
      sql.push(`UPDATE messages SET ${sets.join(",")} WHERE id=${sq(message.id)}`);
    }
    const end = timed.at(-1)?.at || NOW;
    const final = conversation.final || {};
    const line = lineId[conversation.line];
    const sets = [
      `phone=${sq(conversation.phone)}`,
      `last_customer=${lastCustomer}`,
      `created=${first - 1000}`,
      `updated=${final.updated ? ago(final.updated) : end}`,
    ];
    if (line)
      sets.push(
        `connection_id=${sq(line)}`,
        `external_namespace=${sq("channel:" + line)}`,
      );
    if (final.state) {
      sets.push(
        `state=${sq(final.state)}`,
        `owner=NULL`,
        `assigned_bot_id=${sq(final.assigned_bot_id || null)}`,
        `department_id=${sq(final.department_id || null)}`,
      );
    }
    sql.push(`UPDATE conversations SET ${sets.join(",")} WHERE id=${sq(c.id)}`);
    sql.push(
      `UPDATE outbox SET created=${end},updated=${end}${line ? `,connection_id=${sq(line)}` : ""} WHERE conversation_id=${sq(c.id)}`,
      `UPDATE inbox SET created=${first} WHERE conversation_id=${sq(c.id)}`,
    );
    // Contatos salvos pela conversa de simulação nascem no espaço do integrador;
    // conversas de linha usam a agenda da equipe.
    if (line)
      sql.push(
        `UPDATE contacts SET namespace='team' WHERE id IN (SELECT contact_id FROM conversation_contacts WHERE conversation_id=${sq(c.id)})`,
      );
    for (const [index, pending] of (conversation.outbox || []).entries())
      sql.push(
        `INSERT OR IGNORE INTO outbox(id,profile_id,conversation_id,connection_id,epoch,kind,actor,payload,status,error,dedupe,created,updated) VALUES(${sq(`seed-outbox-${conversation.key}-${index}`)},${sq(profile)},${sq(c.id)},${sq(line)},${c.epoch},'text',${sq(ids.admin)},${sqJson({ text: pending.text, attachments: [], content: { type: "text" } })},${sq(pending.status)},${sq(pending.error || null)},${sq(`seed-outbox:${conversation.key}:${index}`)},${ago(pending.t)},${ago(pending.t)})`,
      );
    if (conversation.key === "thiago") {
      const rows = (await admin.call(`${area}/tickets?limit=100`)).data || [];
      autoTicket = rows.find((ticket) => ticket.conversation_id === c.id) || null;
    }
  }

  // Protocolos: datas, prazos e andamentos internos.
  const ticketSql = (id, spec) => {
    const createdAt = ago(spec.created);
    const out = [
      `UPDATE tickets SET created=${createdAt},updated=${Math.max(createdAt, ago(spec.answered ?? spec.created) + 60_000)},response_due_at=${ago(spec.due)},first_response_at=${spec.answered === undefined ? "NULL" : ago(spec.answered)} WHERE id=${sq(id)}`,
      // Andamentos públicos gravados pela API, em ordem, logo após a abertura.
      `UPDATE ticket_updates SET created=${createdAt}+(SELECT count(*) FROM ticket_updates older WHERE older.ticket_id=ticket_updates.ticket_id AND older.rowid<=ticket_updates.rowid)*300000 WHERE ticket_id=${sq(id)}`,
    ];
    if (spec.internal)
      out.push(
        `INSERT OR IGNORE INTO ticket_updates(id,ticket_id,actor,text,internal,created) VALUES(${sq("seed-update-" + id)},${sq(id)},${sq(ids.admin)},${sq(spec.internal)},1,${createdAt + 1_200_000})`,
      );
    return out;
  };
  for (const [key, spec] of Object.entries(tickets))
    if (ticketIds[key]) sql.push(...ticketSql(ticketIds[key], spec));
  if (autoTicket)
    sql.push(
      // Aberto sozinho (equipe ausente), sem responsável, atrasado há 2 horas.
      `UPDATE tickets SET created=${ago(4299)},updated=${ago(4299)},response_due_at=${ago(120)},first_response_at=NULL,category=coalesce(category,'fagoo-erp') WHERE id=${sq(autoTicket.id)}`,
      `UPDATE ticket_updates SET created=${ago(4299)} WHERE ticket_id=${sq(autoTicket.id)}`,
    );

  // Grupo na linha QR (grupos só nascem de um canal autenticado).
  const group = "seed-group-" + profile.slice(0, 8),
    groupExternal = "120363000000000001@g.us";
  const members = [
    { id: "5511955443322", name: "Renata Barros", admin: false },
    { id: "5511966554433", name: "Gustavo Prado", admin: true },
    { id: "5511977665544", name: "Helena Vieira", admin: false },
    { id: "5511940002000", name: "Loja Centro", admin: true },
  ];
  sql.push(
    `INSERT OR IGNORE INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,state,owner,session,tags,last_customer,created,updated,chat_type,title,bot_policy) VALUES(${sq(group)},${sq(profile)},${sq(qr)},${sq("channel:" + qr)},${sq(groupExternal)},NULL,'human',${sq(ids.admin)},${sq(randomUUID())},'["Parceiros"]',0,${ago(5000)},${ago(35)},'group','Revendedores · Loja Centro','off')`,
    `INSERT OR IGNORE INTO whatsapp_groups(conversation_id,subject,description,participants,own_admin,announcement,invite_link,updated) VALUES(${sq(group)},'Revendedores · Loja Centro','Avisos de estoque e retirada para revendedores.',${sqJson(members)},1,0,NULL,${ago(35)})`,
  );
  const groupMessages = [
    [95, "5511966554433", "Gustavo Prado", "Bom dia, pessoal! Chegou a reposição dos cabos USB-C?"],
    [92, null, null, "Bom dia, Gustavo! Chegou sim, 40 unidades de 2 metros."],
    [60, "5511977665544", "Helena Vieira", "Consigo reservar 10 para retirar na sexta?"],
    [58, null, null, "Reservado, Helena. Fica separado no balcão em seu nome."],
    [35, "5511955443322", "Renata Barros", "Obrigada pelo aviso! 👏"],
  ];
  groupMessages.forEach(([t, participant, name, text], index) => {
    const id = `${group}-m${index}`;
    sql.push(
      participant
        ? `INSERT OR IGNORE INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,external_id,created,source_key,content) VALUES(${sq(id)},${sq(profile)},${sq(group)},'customer',${sq(`customer:channel:${qr}:${participant}`)},${sq(text)},'[]',${sq("seed." + id)},${ago(t)},${sq(id)},${sqJson({ type: "text", participant, participant_name: name })})`
        : `INSERT OR IGNORE INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,external_id,created,source_key,content,delivery_status,status_at) VALUES(${sq(id)},${sq(profile)},${sq(group)},'outbound',${sq(ids.admin)},${sq(text)},'[]',${sq("seed." + id)},${ago(t)},${sq(id)},${sqJson({ type: "text", receipts: { "5511966554433": { status: "read", timestamp: ago(t - 1) }, "5511977665544": { status: "delivered", timestamp: ago(t - 1) } } })},'sent',${ago(t)})`,
    );
  });

  // Histórico de ligações (somente registros; áudio não existe na linha oficial).
  const call = (index, key, direction, statusName, t, duration, actor) =>
    `INSERT OR IGNORE INTO calls(id,profile_id,connection_id,conversation_id,external_id,direction,actor,status,started,ended,duration,provider_at,created,updated) VALUES(${sq(`seed-call-${index}`)},${sq(profile)},${sq(official)},${sq(created[key].id)},${sq(`seed-call-${index}`)},${sq(direction)},${sq(actor)},${sq(statusName)},${duration ? ago(t) : "NULL"},${duration ? ago(t) + duration * 1000 : "NULL"},${duration || "NULL"},${ago(t)},${ago(t)},${ago(t) + duration * 1000})`;
  sql.push(
    call(1, "mariana", "inbound", "completed", 1520, 185, ids.admin),
    call(2, "lucas", "inbound", "missed", 1410, 0, null),
    call(3, "marcos", "outbound", "completed", 2870, 62, ids.admin),
    call(4, "paulo", "inbound", "rejected", 880, 0, ids.op1),
  );

  // Conversa interna com o bot (uma execução real chamaria um Hermes que não existe).
  const botPeer = "bot:" + BOT_ATTENDANT;
  const [memberA, memberB] = [ids.admin, botPeer].sort();
  const botChat = "seed-chat-bot-" + profile.slice(0, 8);
  sql.push(
    `INSERT OR IGNORE INTO internal_chats(id,profile_id,member_a,member_b,created,updated) VALUES(${sq(botChat)},${sq(profile)},${sq(memberA)},${sq(memberB)},${ago(400)},${ago(398)})`,
    `INSERT OR IGNORE INTO internal_messages(id,chat_id,author,text,status,run_id,source_key,created) VALUES(${sq(botChat + "-1")},${sq(botChat)},${sq(ids.admin)},'Qual é o prazo padrão para estorno de PIX em duplicidade?','sent',NULL,${sq(botChat + "-1")},${ago(400)})`,
    `INSERT OR IGNORE INTO internal_messages(id,chat_id,author,text,status,run_id,source_key,created) VALUES(${sq(botChat + "-2")},${sq(botChat)},${sq(botPeer)},'Pela base de conhecimento, o estorno é pedido ao banco no mesmo dia e o valor volta em até 3 dias úteis. Oriente o cliente a guardar o comprovante.','sent',NULL,${sq(botChat + "-2")},${ago(398)})`,
    // Mensagens entre pessoas: espalhadas pela manhã.
    `UPDATE internal_messages SET created=${ago(190)}+(SELECT count(*) FROM internal_messages older WHERE older.chat_id=internal_messages.chat_id AND older.rowid<internal_messages.rowid)*240000 WHERE chat_id=${sq(chat.id)}`,
    `UPDATE internal_chats SET updated=(SELECT max(created) FROM internal_messages WHERE chat_id=${sq(chat.id)}) WHERE id=${sq(chat.id)}`,
    `UPDATE internal_messages SET created=${ago(75)} WHERE chat_id=${sq(chat2.id)}`,
    `UPDATE internal_chats SET updated=${ago(75)} WHERE id=${sq(chat2.id)}`,
    // Avaliações pedidas ao concluir: datas coerentes com as conversas.
    `UPDATE surveys SET created=${ago(2858)} WHERE conversation_id=${sq(created.marcos.id)}`,
    `UPDATE surveys SET created=${ago(1488)} WHERE conversation_id=${sq(created.patricia.id)}`,
  );
  d1Run(sql);
  log("idades, entregas, reações, grupo, ligações e protocolos ajustados no D1 local");

  logins.seed = {
    done: true,
    seeded_at: NOW,
    six_ticket_states: sixStates,
    lines: { official, qr, hermes },
    connector: { connection_id: qr, token: connectorToken },
    conversations: [...seededConversations, group],
    tickets: [...Object.values(ticketIds), ...(autoTicket ? [autoTicket.id] : [])],
  };
  saveLogins(logins);
  await summary(admin, area, logins);
}

/** Segunda execução: adianta todas as datas para as janelas voltarem ao desenho original. */
async function refresh(logins, admin, area) {
  const delta = NOW - logins.seed.seeded_at;
  const list = logins.seed.conversations.map(sq).join(",");
  const tix = logins.seed.tickets.map(sq).join(",") || "''";
  if (delta > 60_000) {
    d1Run([
      `UPDATE messages SET created=min(created+${delta},${NOW}),status_at=CASE WHEN status_at>0 THEN min(status_at+${delta},${NOW}) ELSE 0 END WHERE conversation_id IN (${list}) AND created<=${logins.seed.seeded_at}`,
      `UPDATE conversations SET created=min(created+${delta},${NOW}),updated=min(updated+${delta},${NOW}),last_customer=CASE WHEN last_customer>0 AND last_customer<=${logins.seed.seeded_at} THEN last_customer+${delta} ELSE last_customer END WHERE id IN (${list}) AND updated<=${logins.seed.seeded_at}`,
      `UPDATE outbox SET created=min(created+${delta},${NOW}),updated=min(updated+${delta},${NOW}) WHERE conversation_id IN (${list}) AND created<=${logins.seed.seeded_at}`,
      `UPDATE tickets SET created=created+${delta},updated=min(updated+${delta},${NOW}),response_due_at=response_due_at+${delta},first_response_at=first_response_at+${delta} WHERE id IN (${tix}) AND updated<=${logins.seed.seeded_at}`,
      `UPDATE ticket_updates SET created=min(created+${delta},${NOW}) WHERE ticket_id IN (${tix}) AND created<=${logins.seed.seeded_at}`,
      `UPDATE calls SET created=created+${delta},updated=updated+${delta},started=started+${delta},ended=ended+${delta},provider_at=provider_at+${delta} WHERE id LIKE 'seed-call-%'`,
      `UPDATE internal_messages SET created=min(created+${delta},${NOW}) WHERE created<=${logins.seed.seeded_at}`,
      `UPDATE internal_chats SET updated=min(updated+${delta},${NOW}) WHERE updated<=${logins.seed.seeded_at}`,
      `UPDATE surveys SET created=min(created+${delta},${NOW}) WHERE created<=${logins.seed.seeded_at}`,
    ]);
    logins.seed.seeded_at = NOW;
    saveLogins(logins);
    log("carga já existia: datas renovadas (janelas de 24 h e prazos voltaram ao desenho original)");
  } else log("carga já existia e está recente: nada a renovar");
  const op1 = await new Session(logins.operators[0]).login(),
    op2 = await new Session(logins.operators[1]).login();
  await admin.call(area + "/presence", "PUT", { present: true });
  await op1.call(area + "/presence", "PUT", { present: true });
  await op2.call(area + "/presence", "PUT", { present: false });
  await summary(admin, area, logins);
}

async function summary(admin, area, logins) {
  const status = await admin.call(area + "/status");
  const states = Object.fromEntries(
    (status.conversations || []).map((row) => [row.state, row.count]),
  );
  const ticketRows = (await admin.call(area + "/tickets?limit=100")).data || [];
  const byStatus = {};
  for (const ticket of ticketRows)
    byStatus[ticket.status] = (byStatus[ticket.status] || 0) + 1;
  const team = (await admin.call(area + "/team")).data || [];
  console.log("");
  console.log("Resumo da carga local");
  console.log("  conversas por estado: " + JSON.stringify(states));
  console.log("  protocolos por estado: " + JSON.stringify(byStatus));
  console.log(
    `  equipe: ${team.filter((item) => item.kind === "user").length} pessoas (${team.filter((item) => item.kind === "user" && item.online).length} online), ${team.filter((item) => item.kind === "bot").length} bots`,
  );
  console.log(
    `  linhas: ${(status.connections || []).map((line) => `${line.name} [${line.kind}, ${line.status}]`).join("; ")}`,
  );
  console.log(
    "  seis estados de protocolo: " + (logins.seed.six_ticket_states ? "sim" : "não (servidor antigo)"),
  );
  console.log("");
  console.log("Logins de teste gravados em: " + loginsFile);
}

// --- conector de mentira da linha QR -----------------------------------------------------
// Faz o que o conector do WhatsApp faria: busca os comandos de envio, confirma
// ("sent") e devolve os recibos de entrega e leitura. Nada sai da máquina.
async function connector() {
  await waitForServer();
  const logins = readLogins();
  if (!logins?.seed?.connector)
    throw new Error("Rode primeiro `node scripts/seed-local.mjs` para criar a linha QR de teste.");
  const { connection_id: id, token } = logins.seed.connector;
  const call = async (path, method = "GET", body) =>
    parse(
      await fetch(`${base}/internal/v1/connectors/${id}/${path}`, {
        method,
        headers: {
          Authorization: "Bearer " + token,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  await call("status", "POST", { protocol_version: 2, state: "open", features: [] });
  log("conector de teste da linha QR em execução (Ctrl+C para parar)");
  let handled = 0;
  for (;;) {
    try {
      const { commands = [] } = await call("commands");
      for (const command of commands) {
        if (command.kind === "group") {
          await call("receipts", "POST", { id: command.id, status: "sent", result: {} });
          continue;
        }
        const external = "seed." + randomUUID();
        await call("receipts", "POST", {
          id: command.id,
          status: "sent",
          external_id: external,
        });
        handled++;
        // Reações, edições e leituras não geram recibo de entrega.
        const type = command.payload?.content?.type;
        if (!["reaction", "edit", "delete", "read"].includes(type)) {
          const status = (name, wait) =>
            setTimeout(
              () =>
                call("events", "POST", {
                  event: "status",
                  external_id: command.destination,
                  message_id: external,
                  status: name,
                  timestamp: Date.now(),
                }).catch(() => {}),
              wait,
            );
          status("delivered", 1500);
          status("read", 4500);
        }
        log(`envio confirmado (${handled})`);
      }
      // Mantém a linha "vista agora".
      if (!commands.length) await sleep(1000);
    } catch (error) {
      if (error.status === 401)
        throw new Error("Token do conector recusado. Rode o seed com --reset.");
      await sleep(3000);
    }
  }
}

(flag("--connector") ? connector() : seed()).catch((error) => {
  console.error("\nFalhou: " + (error?.message || error));
  if (error?.stderr) console.error(String(error.stderr).slice(-800));
  process.exit(1);
});
