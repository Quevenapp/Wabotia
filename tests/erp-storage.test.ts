// Arquivos do ERP no R2 (src/erp-storage.ts): o /storage/v1 do Supabase que a
// erp-api do Fagoo chama, pela costura local. Os adaptadores são os do Fagoo,
// sem alteração (anexos, CNAB, exportação), contra o R2 do teste.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localFetch } from "../src/erp/api/local-fetch";
import { erpObjectKey } from "../src/erp/engine/rpc-endpoint";
import {
  createErpUpload,
  erpStorage,
  erpStorageKey,
  publicSignedUrls,
  sweepStaleUploads,
  UPLOAD_PART_BYTES,
} from "../src/erp-storage";
import { createZipStream, crc32 } from "../src/erp-zip";
// @ts-ignore módulos JavaScript do Fagoo, sem tipos
import { createAttachmentStorage } from "../src/erp/fagoo/workers/erp-api/src/attachment-storage.mjs";
// @ts-ignore
import { createCnabStorage } from "../src/erp/fagoo/workers/erp-api/src/cnab.mjs";
// @ts-ignore
import {
  createExportStorage,
  createZip,
} from "../src/erp/fagoo/workers/erp-api/src/platform.mjs";
import { fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";

const LOCAL = "https://erp.wabotia.invalid";
const KEY = "motor-local";
const hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const bytesOf = (n: number, seed = 7) => {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) out[i] = x = (x * 1103515245 + 12345) & 0xff;
  return out;
};
const ports = (profile: string, actor: any) => {
  const fetchImpl = localFetch(env, profile, actor);
  const base = {
    baseUrl: LOCAL,
    supabaseDeployment: "self-hosted",
    key: KEY,
    fetchImpl,
  };
  return {
    fetchImpl,
    attachments: createAttachmentStorage(base),
    cnab: createCnabStorage(base),
    exports: createExportStorage(base),
  };
};
const storage = (
  profile: string,
  method: string,
  path: string,
  init: RequestInit = {},
) =>
  erpStorage(
    env,
    profile,
    new Request(LOCAL + "/storage/v1/object/" + path, { method, ...init }),
  );

afterEach(() => vi.restoreAllMocks());

describe("armazenamento do ERP no R2", () => {
  it("anexos e CNAB pelos adaptadores do Fagoo, separados por área", async () => {
    const a = await fixture();
    const b = await fixture();
    const pa = ports(a.profile, a.admin);
    const pb = ports(b.profile, b.admin);
    const bytes = bytesOf(3000);
    const key = `documents/${crypto.randomUUID()}/${crypto.randomUUID()}/${await hex(bytes)}`;
    expect(await pa.attachments.put(key, bytes, "application/pdf")).toBe(true);
    // A mesma chave não é regravada (x-upsert: false).
    expect(await pa.attachments.put(key, bytes, "application/pdf")).toBe(false);
    const got = await pa.attachments.get(key);
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("application/pdf");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    // No R2, sob a área e o bucket; o objeto erp: lê pela mesma chave.
    const stored = await env.MEDIA.head(
      erpStorageKey(a.profile, "erp-attachments", key),
    );
    expect(stored?.size).toBe(3000);
    expect(erpObjectKey(a.profile, `erp-attachments/${key}`)).toBe(
      erpStorageKey(a.profile, "erp-attachments", key),
    );
    // Outra área não enxerga.
    expect((await pb.attachments.get(key)).status).toBe(404);

    // CNAB: caminho da RPC sem mudança, prefixo da área posto pela camada,
    // e só com o bloco erp-cobranca ligado.
    const rem = new TextEncoder().encode("0".repeat(240) + "\r\n");
    const path = `profiles/${a.profile}/remittances/${await hex(rem)}.rem`;
    await expect(
      pa.cnab.storeFile({
        bucket: "brufap-cnab",
        path,
        bytes: rem,
        upsert: false,
      }),
    ).rejects.toThrow();
    expect(
      await env.MEDIA.head(erpStorageKey(a.profile, "brufap-cnab", path)),
    ).toBeNull();
    await setModule(a.profile, "erp", true, a.admin.id);
    await setModule(a.profile, "erp-cobranca", true, a.admin.id);
    await pa.cnab.storeFile({
      bucket: "brufap-cnab",
      path,
      bytes: rem,
      upsert: false,
    });
    // Repetir o envio (resposta perdida) não falha: a chave tem o hash.
    await pa.cnab.storeFile({
      bucket: "brufap-cnab",
      path,
      bytes: rem,
      upsert: false,
    });
    expect(await pa.cnab.getFile({ bucket: "brufap-cnab", path })).toEqual(rem);
    expect(
      await env.MEDIA.head(erpStorageKey(a.profile, "brufap-cnab", path)),
    ).not.toBeNull();
    // Nunca por link: assinar é recusado, e um link forjado também.
    const signCnab = await storage(
      a.profile,
      "POST",
      `sign/brufap-cnab/${path}`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: 120 }),
      },
    );
    expect(signCnab.status).toBe(403);
    await setModule(a.profile, "erp", true, a.admin.id);
    expect(
      (
        await SELF.fetch(
          `https://test/api/public/erp-storage/${a.profile}/brufap-cnab/${path}?token=9999999999.00`,
        )
      ).status,
    ).toBe(403);
    // Bloco desligado: a leitura para também.
    await setModule(a.profile, "erp-cobranca", false, a.admin.id);
    await expect(
      pa.cnab.getFile({ bucket: "brufap-cnab", path }),
    ).rejects.toThrow();
    expect(
      (await storage(a.profile, "GET", `authenticated/brufap-cnab/${path}`))
        .status,
    ).toBe(403);
  });

  it("exportação: grava, assina, baixa pelo link público e apaga", async () => {
    const f = await fixture();
    await setModule(f.profile, "erp", true, f.admin.id);
    const p = ports(f.profile, f.admin);
    const zip = bytesOf(5000, 3);
    const id = crypto.randomUUID();
    const objectKey = `exports/${id}/${await hex(zip)}.zip`;
    await p.exports.put(objectKey, zip);
    await p.exports.put(objectKey, zip); // repetição: já existe, sem erro
    const signed: string = await p.exports.sign(
      objectKey,
      120,
      "brufap-exportacao-2026-11-16.zip",
    );
    expect(
      signed.startsWith(
        `${LOCAL}/storage/v1/object/sign/brufap-exports/${objectKey}?token=`,
      ),
    ).toBe(true);

    // A costura troca o endereço local pela rota pública, na origem da pessoa.
    const body = JSON.stringify({ url: signed });
    const url = JSON.parse(
      publicSignedUrls(body, LOCAL, "https://test", f.profile),
    ).url as string;
    expect(
      url.startsWith(
        `https://test/api/public/erp-storage/${f.profile}/brufap-exports/${objectKey}?token=`,
      ),
    ).toBe(true);

    const download = await SELF.fetch(url);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toBe(
      'attachment; filename="brufap-exportacao-2026-11-16.zip"',
    );
    expect(download.headers.get("Cache-Control")).toContain("no-store");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(zip);

    // Token mexido, outra área no caminho, outro objeto ou vencido: 403.
    const other = await fixture();
    const tampered = [
      url.replace(
        /token=(\d+)\.([0-9a-f])/,
        (_m, e, c) => `token=${e}.${c === "0" ? "1" : "0"}`,
      ),
      url.replace(
        `/erp-storage/${f.profile}/`,
        `/erp-storage/${other.profile}/`,
      ),
      url.replace(`/exports/${id}/`, `/exports/${crypto.randomUUID()}/`),
      url.replace(/token=\d+\./, "token=99999999999."),
    ];
    for (const bad of tampered)
      expect((await SELF.fetch(bad)).status).toBe(403);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 121_000);
    expect((await SELF.fetch(url)).status).toBe(403);
    vi.restoreAllMocks();

    // Com o ERP desligado na área, o link para de valer.
    await setModule(f.profile, "erp", false, f.admin.id);
    expect((await SELF.fetch(url)).status).toBe(409);
    await setModule(f.profile, "erp", true, f.admin.id);

    // Limpeza da retenção: apaga; apagar de novo não falha (404 aceito).
    await p.exports.remove(objectKey);
    await p.exports.remove(objectKey);
    expect(
      await env.MEDIA.head(
        erpStorageKey(f.profile, "brufap-exports", objectKey),
      ),
    ).toBeNull();
    expect((await SELF.fetch(url)).status).toBe(404);
  });

  it("recusa bucket desconhecido, caminho inválido, tipo, tamanho, bloco desligado e link fora da exportação", async () => {
    const f = await fixture();
    const xml = {
      headers: { "Content-Type": "application/xml" },
      body: "<a/>",
    };
    // Bucket fora da tabela, inclusive os do Origin (bloco externo).
    for (const bucket of [
      "outro-bucket",
      "origin-backups",
      "origin-fiscal-xml",
    ])
      expect(
        (await storage(f.profile, "POST", `${bucket}/a.xml`, xml)).status,
        bucket,
      ).toBe(404);
    for (const path of [
      "erp-attachments/.upload/x/0",
      "erp-attachments/a//b",
      "erp-attachments/a%2Fb",
    ])
      expect((await storage(f.profile, "POST", path, xml)).status, path).toBe(
        400,
      );
    // "../" e "./" somem na normalização da URL ("../" cai fora de qualquer bucket).
    expect(
      (await storage(f.profile, "POST", "erp-attachments/../a", xml)).status,
    ).toBe(404);
    expect(
      (
        await storage(f.profile, "POST", "erp-attachments/a.html", {
          headers: { "Content-Type": "text/html" },
          body: "<p>",
        })
      ).status,
    ).toBe(415);
    await setModule(f.profile, "erp", true, f.admin.id);
    await setModule(f.profile, "erp-cobranca", true, f.admin.id);
    expect(
      (
        await storage(f.profile, "POST", "brufap-cnab/x.rem", {
          headers: { "Content-Type": "application/octet-stream" },
          body: bytesOf(4_020_001),
        })
      ).status,
    ).toBe(413);
    // Fiscal (notas recebidas, artefatos, certificado A1) com erp-fiscal
    // desligado: nada entra nem sai.
    const octet = {
      headers: { "Content-Type": "application/octet-stream" },
      body: "x",
    };
    for (const bucket of [
      "brufap-received-dfe",
      "brufap-fiscal-artifacts",
      "brufap-a1-vault",
    ]) {
      expect(
        (await storage(f.profile, "POST", `${bucket}/objects/a`, octet)).status,
        bucket,
      ).toBe(403);
      expect(
        (await storage(f.profile, "GET", `authenticated/${bucket}/objects/a`))
          .status,
        bucket,
      ).toBe(403);
      expect(
        (await storage(f.profile, "DELETE", `${bucket}/objects/a`)).status,
        bucket,
      ).toBe(403);
    }
    await setModule(f.profile, "erp-fiscal", true, f.admin.id);
    expect(
      (await storage(f.profile, "POST", "brufap-received-dfe/objects/a", octet))
        .status,
    ).toBe(200);
    expect(
      (
        await storage(
          f.profile,
          "GET",
          "authenticated/brufap-received-dfe/objects/a",
        )
      ).status,
    ).toBe(200);
    // Link só na exportação; nela, objeto existente e prazo de 1 s a 1 h.
    const sign = (path: string, expiresIn: unknown) =>
      storage(f.profile, "POST", `sign/${path}`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn }),
      });
    expect((await sign("brufap-received-dfe/objects/a", 120)).status).toBe(403);
    expect((await sign("erp-attachments/nada.pdf", 120)).status).toBe(403);
    expect((await sign("brufap-exports/nada.zip", 120)).status).toBe(404);
    expect((await sign("brufap-exports/nada.zip", 0)).status).toBe(400);
    expect((await sign("brufap-exports/nada.zip", 3601)).status).toBe(400);
  });
});

describe("gravação em partes com o nome no fim (exportação)", () => {
  it("12 MiB em fatias: partes de 5 MiB, SHA-256 no nome, temporárias apagadas", async () => {
    const f = await fixture();
    const data = bytesOf(12 * 1024 * 1024 + 123, 11);
    const upload = await createErpUpload(
      env,
      f.profile,
      "brufap-exports",
      "application/zip",
    );
    for (let at = 0; at < data.length;) {
      const n = Math.min(data.length - at, 700_000 + (at % 3) * 333_333);
      await upload.write(data.subarray(at, at + n));
      at += n;
    }
    // Durante o envio, as partes cheias ficam como temporárias.
    const prefix = erpStorageKey(f.profile, "brufap-exports", ".upload/");
    expect(
      (await env.MEDIA.list({ prefix })).objects.map((o) => o.size),
    ).toEqual([UPLOAD_PART_BYTES, UPLOAD_PART_BYTES]);
    const id = crypto.randomUUID();
    const done = await upload.finish((sha) => `exports/${id}/${sha}.zip`);
    expect(done.sha256).toBe(await hex(data));
    expect(done.size).toBe(data.length);
    expect(done.path).toBe(`exports/${id}/${done.sha256}.zip`);
    const stored = await env.MEDIA.get(
      erpStorageKey(f.profile, "brufap-exports", done.path),
    );
    expect(stored?.httpMetadata?.contentType).toBe("application/zip");
    expect(await hex(new Uint8Array(await stored!.arrayBuffer()))).toBe(
      done.sha256,
    );
    expect((await env.MEDIA.list({ prefix })).objects).toEqual([]);

    // Até uma parte: direto. Objeto já existente: não regrava.
    const small = await createErpUpload(
      env,
      f.profile,
      "brufap-exports",
      "application/zip",
    );
    await small.write(bytesOf(1000));
    const first = await small.finish((sha) => `exports/${id}/${sha}.zip`);
    const again = await createErpUpload(
      env,
      f.profile,
      "brufap-exports",
      "application/zip",
    );
    await again.write(bytesOf(1000));
    const smallKey = erpStorageKey(f.profile, "brufap-exports", first.path);
    const before = (await env.MEDIA.head(smallKey))!.uploaded.getTime();
    await new Promise((r) => setTimeout(r, 5));
    expect(await again.finish((sha) => `exports/${id}/${sha}.zip`)).toEqual(
      first,
    );
    expect((await env.MEDIA.head(smallKey))!.uploaded.getTime()).toBe(before);

    // Acima do teto do bucket (50 MiB): recusa ao escrever.
    const big = await createErpUpload(
      env,
      f.profile,
      "brufap-exports",
      "application/zip",
    );
    await expect(
      big.write(new Uint8Array(50 * 1024 * 1024 + 1)),
    ).rejects.toThrow();
    await big.abort();
  });

  it("envio interrompido: as temporárias saem depois de um dia", async () => {
    const f = await fixture();
    const upload = await createErpUpload(
      env,
      f.profile,
      "brufap-exports",
      "application/zip",
    );
    await upload.write(bytesOf(UPLOAD_PART_BYTES + 10));
    const prefix = erpStorageKey(f.profile, "brufap-exports", ".upload/");
    expect((await env.MEDIA.list({ prefix })).objects).toHaveLength(1);
    // Nada sai antes de um dia.
    expect(await sweepStaleUploads(env, f.profile, "brufap-exports")).toBe(0);
    expect(
      await sweepStaleUploads(
        env,
        f.profile,
        "brufap-exports",
        Date.now() + 25 * 3600_000,
      ),
    ).toBe(1);
    expect((await env.MEDIA.list({ prefix })).objects).toEqual([]);
  });
});

/** Entradas de um ZIP lidas pelo diretório central (só para o teste). */
async function unzip(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      zip.subarray(at + 46, at + 46 + nameLength),
    );
    const start =
      offset +
      30 +
      view.getUint16(offset + 26, true) +
      view.getUint16(offset + 28, true);
    const data = new Uint8Array(
      await new Response(
        new Blob([zip.subarray(start, start + compressed)])
          .stream()
          .pipeThrough(new DecompressionStream("deflate-raw")),
      ).arrayBuffer(),
    );
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    at += 46 + nameLength;
  }
  return out;
}

describe("ZIP em fatias (src/erp-zip.ts)", () => {
  it("entradas inteiras saem iguais ao createZip do Fagoo, byte a byte", async () => {
    const date = new Date("2026-11-16T12:34:56Z");
    const files: [string, Uint8Array][] = [
      [
        "dados/erp_catalog.record.json",
        new TextEncoder().encode('[\n{"id":1}\n]\n'),
      ],
      ["arquivos/ação.pdf", bytesOf(40_000)],
    ];
    const fagoo = createZip(date);
    for (const [name, bytes] of files) await fagoo.add(name, bytes);
    const expected: Uint8Array = fagoo.finish();
    const parts: Uint8Array[] = [];
    const ours = createZipStream(async (b) => void parts.push(b.slice()), date);
    for (const [name, bytes] of files) await ours.add(name, bytes);
    await ours.finish();
    const got = new Uint8Array(await new Blob(parts).arrayBuffer());
    expect(got).toEqual(expected);
    expect(ours.size).toBe(expected.length);
  });

  it("conjunto de dados página por página direto para o R2, e o ZIP abre", async () => {
    const f = await fixture();
    const upload = await createErpUpload(
      env,
      f.profile,
      "brufap-exports",
      "application/zip",
    );
    const zip = createZipStream((b) => upload.write(b));
    // Como o runExport: 30 páginas de 500 linhas, sem juntar o conjunto.
    const encoder = new TextEncoder();
    const rows = await zip.entry("dados/erp_finance.title.json");
    const all: string[] = [];
    await rows.write(encoder.encode("[\n"));
    for (let page = 0; page < 30; page++) {
      const text = Array.from({ length: 500 }, (_, i) => {
        const row = JSON.stringify({
          id: page * 500 + i,
          nota: `título ${page}-${i}`,
          valor: (i * 37) % 9999,
        });
        all.push(row);
        return row;
      }).join(",\n");
      await rows.write(encoder.encode((page ? ",\n" : "") + text));
    }
    await rows.write(encoder.encode("\n]\n"));
    await rows.close();
    await zip.add(
      "manifesto.json",
      encoder.encode('{"formato":"brufap-exportacao-v1"}'),
    );
    await zip.finish();
    const id = crypto.randomUUID();
    const done = await upload.finish((sha) => `exports/${id}/${sha}.zip`);
    const stored = await env.MEDIA.get(
      erpStorageKey(f.profile, "brufap-exports", done.path),
    );
    const entries = await unzip(new Uint8Array(await stored!.arrayBuffer()));
    expect([...entries.keys()]).toEqual([
      "dados/erp_finance.title.json",
      "manifesto.json",
    ]);
    const parsed = JSON.parse(
      new TextDecoder().decode(entries.get("dados/erp_finance.title.json")),
    );
    expect(parsed).toHaveLength(15_000);
    expect(parsed[14_999]).toEqual(JSON.parse(all[14_999]));
  });
});
