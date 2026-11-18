// PDFs pequenos montados no teste; nenhuma biblioteca, arquivo externo ou rede.
import assert from "node:assert/strict";

const latin = (bytes) =>
  Array.from(bytes, (b) => String.fromCharCode(b)).join("");
const bytes = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const hex = (text) =>
  Array.from(text, (c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join(
    "",
  );
async function stream(text, compressed = true, extra = "", indirect = false) {
  const data = compressed
    ? latin(
        new Uint8Array(
          await new Response(
            new Blob([bytes(text)])
              .stream()
              .pipeThrough(new CompressionStream("deflate")),
          ).arrayBuffer(),
        ),
      )
    : text;
  return {
    object: `<< /Length ${indirect ? "8 0 R" : data.length}${compressed ? " /Filter /FlateDecode" : ""} ${extra} >>\nstream\n${data}\nendstream`,
    length: data.length,
  };
}

export async function fixturePdf(options = {}) {
  const {
    text = "João, ação e CPF 123.456.789-09",
    unicode = false,
    objstm = false,
    xrefPredictor = false,
    image = false,
    imageOnly = false,
    pages = 1,
    compressed = true,
    indirectLength = false,
    font,
    cmap,
    content,
    extraObjects = [],
    streamExtra = "",
    contents,
    pageExtra = "",
    mutate = (raw) => raw,
  } = options;
  const textContent = unicode
    ? `<${hex(text)}>`
    : `(${text.replace(/[\\()]/g, "\\$&")})`;
  const data = await stream(
    content ??
      `${image || imageOnly ? "q /Logo Do Q " : ""}${imageOnly ? "" : `BT /F1 12 Tf ${textContent} Tj ET`}`,
    compressed,
    streamExtra,
    indirectLength,
  );
  const entries = new Map([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [
      2,
      `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i === 0 ? 3 : 20 + i} 0 R`).join(" ")}] /Count ${pages} /Resources << /Font << /F1 4 0 R >> /XObject << /Logo 7 0 R >> >> >>`,
    ],
    [
      4,
      font ??
        (unicode || cmap
          ? "<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Arial /Encoding /Identity-H /ToUnicode 6 0 R >>"
          : "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
    ],
    [5, data.object],
  ]);
  for (let i = 0; i < pages; i++)
    entries.set(
      i === 0 ? 3 : 20 + i,
      `<< /Type /Page /Parent 2 0 R /Contents ${contents ?? "5 0 R"} ${pageExtra} >>`,
    );
  if (indirectLength) entries.set(8, String(data.length));
  if (unicode || cmap) {
    const chars = [...new Set(Array.from(text))];
    const mapping =
      cmap ??
      `1 begincodespacerange <0000> <ffff> endcodespacerange\n${chars.length} beginbfchar\n${chars.map((c) => `<${hex(c)}> <${hex(c)}>`).join("\n")}\nendbfchar`;
    entries.set(
      6,
      (
        await stream(
          `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n${mapping}\nendcmap end end`,
        )
      ).object,
    );
  }
  if (image || imageOnly)
    entries.set(
      7,
      (
        await stream(
          "\xff\xd8\xff\xd9",
          false,
          "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
        )
      ).object,
    );
  for (const [id, value] of extraObjects) entries.set(id, value);
  const packedIds = new Map();
  if (objstm) {
    const packed = [...entries].filter(
      ([, value]) => !value.includes("\nstream\n"),
    );
    let header = "",
      body = "";
    for (const [index, [id, value]] of packed.entries()) {
      header += `${id} ${body.length} `;
      body += value + "\n";
      entries.delete(id);
      packedIds.set(id, index);
    }
    entries.set(
      10,
      (
        await stream(
          header + body,
          true,
          `/Type /ObjStm /N ${packed.length} /First ${header.length}`,
        )
      ).object,
    );
  }
  let raw = "%PDF-1.7\n";
  const offsets = new Map();
  for (const [id, value] of entries) {
    offsets.set(id, raw.length);
    raw += `${id} 0 obj\n${value}\nendobj\n`;
  }
  if (objstm) {
    // Xref stream real: entradas soltas, comprimidas e livres, com os offsets certos.
    const xrefId = Math.max(...entries.keys(), ...packedIds.keys()) + 1;
    const size = xrefId + 1,
      start = raw.length;
    offsets.set(xrefId, start);
    let table = "";
    for (let id = 0; id < size; id++) {
      const type = packedIds.has(id) ? 2 : offsets.has(id) ? 1 : 0;
      const a = type === 2 ? 10 : (offsets.get(id) ?? 0);
      const b = type === 2 ? packedIds.get(id) : id === 0 ? 65535 : 0;
      table += String.fromCharCode(
        type,
        (a >>> 24) & 255,
        (a >>> 16) & 255,
        (a >>> 8) & 255,
        a & 255,
        b >> 8,
        b & 255,
      );
    }
    if (xrefPredictor) {
      let predicted = "";
      for (let row = 0; row < size; row++) {
        predicted += "\x02"; // PNG Up: Predictor 12, sete colunas por entrada.
        for (let column = 0; column < 7; column++)
          predicted += String.fromCharCode(
            (table.charCodeAt(row * 7 + column) -
              (row ? table.charCodeAt((row - 1) * 7 + column) : 0)) & 255,
          );
      }
      table = predicted;
    }
    raw += `${xrefId} 0 obj\n${(await stream(table, true, `/Type /XRef /Size ${size} /W [1 4 2] /Root 1 0 R${xrefPredictor ? " /DecodeParms << /Predictor 12 /Columns 7 >>" : ""}`)).object}\nendobj\nstartxref\n${start}\n`;
  }
  return bytes(mutate(raw + "%%EOF"));
}

export function pdfCases({
  extractPersonalPdf,
  extractMaskedPersonalPdf,
  createPiiMask,
  PDF_INFLATE_LIMITS = { bytes: 8 * 1024 * 1024, streams: 64 },
}) {
  const extract = async (opts) => extractPersonalPdf(await fixturePdf(opts));
  const masked = async (opts) =>
    extractMaskedPersonalPdf(await fixturePdf(opts), createPiiMask());
  return [
    [
      "TJ separa palavras a partir de -200, preservando kerning pequeno",
      async () => {
        for (const gap of [-200, -333]) {
          const content = `BT /F1 12 Tf [(CPF)${gap}(529.982.)-30(247-25)${gap}(Nome)]TJ ET`;
          assert.equal(await extract({ content }), "CPF 529.982.247-25 Nome");
          assert.equal(await masked({ content }), "CPF [CPF_1] Nome");
        }
        assert.equal(await masked({ content: "BT /F1 12 Tf [(CPF)-333(123.456.789-09)-333(Nome)]TJ ET" }), "CPF [CPF_1] Nome");
        assert.equal(await extract({ content: "BT /F1 12 Tf [(a)-199(b)20(c)]TJ ET" }), "abc");
      },
    ],
    [
      "Tm, Td e TD distinguem deslocamento horizontal de mudança de linha",
      async () => {
        assert.equal(await extract({ content: "BT /F1 12 Tf 1 0 0 1 10 100 Tm (a) Tj 1 0 0 1 30 100 Tm (b) Tj 20 0 Td (c) Tj 20 0 TD (d) Tj 1 0 0 1 10 90 Tm (e) Tj 0 -10 Td (f) Tj 0 -10 TD (g) Tj T* (h) Tj (i) ' 0 0 (j) \" ET" }), "a b c d\ne\nf\ng\nh\ni\nj");
        assert.equal(await extract({ content: "BT /F1 12 Tf 10 TL 1 0 0 1 10 100 Tm (a) Tj T* (b) Tj 1 0 0 1 30 90 Tm (c) Tj ET" }), "a\nb c");
        assert.equal(await extract({ content: "BT /F1 12 Tf 10 TL 1 0 0 1 10 100 Tm (a) Tj q 20 TL Q T* (b) Tj 1 0 0 1 30 90 Tm (c) Tj ET" }), "a\nb c");
      },
    ],
    [
      "rede de segurança recusa CPF/CNPJ residuais colados ou fragmentados após a máscara",
      async () => {
        assert.equal(await masked({ content: "BT /F1 12 Tf 1 0 0 1 10 100 Tm (529.982.) Tj 1 0 0 1 10 90 Tm (247-25) Tj ET" }), null);
        for (const text of [
          "abc52998224725xyz",
          "abc11.222.333/0001-81xyz",
          "abc11222333000181xyz",
          "CPF 529 . 982 . 247 - 25",
          "CNPJ 11 . 222 . 333 / 0001 - 81",
          "1 529 . 982 . 247 - 25",
          "CPF 529 . 982 . 247 - 25 1",
        ]) assert.equal(await masked({ text }), null, text);
        assert.equal(await masked({ text: "CPF 529.982.247-25 e CNPJ 11.222.333/0001-81" }), "CPF [CPF_1] e CNPJ [CNPJ_1]");
        // Inválido e número maior não são documentos só por conterem dígitos.
        for (const text of ["abc52998224724xyz", "abc11222333000182xyz", "1529982247251"])
          assert.equal(await masked({ text }), text);
      },
    ],
    [
      "rede de segurança preserva pedidos, valores em R$ e datas",
      async () => {
        for (const text of [
          "pedido 12345", "pedido 11988887777", "pedido 1234567890",
          "protocolo: 52998224725", "ordem nº 11222333000181",
          "R$ 11988887777", "R$ 1.234,56", "R$ 52998224725,00",
          "18/11/2026 às 12:34:56", "2026-11-18 09:30", "18.11.2026",
        ]) assert.equal(await masked({ text }), text, text);
      },
    ],
    [
      "ObjStm, XRef, Contents Flate e ToUnicode de dois bytes preservam acentos",
      async () => {
        assert.equal(
          await extract({ objstm: true, unicode: true }),
          "João, ação e CPF 123.456.789-09",
        );
      },
    ],
    [
      "ToUnicode bfchar e bfrange sequencial/lista, de um e dois bytes",
      async () => {
        for (const width of [2, 4]) {
          const key = (n) => n.toString(16).padStart(width, "0");
          const cmap = `1 begincodespacerange <${key(0)}> <${key(255)}> endcodespacerange
          1 beginbfchar <${key(1)}> <00e3> endbfchar
          2 beginbfrange <${key(2)}> <${key(3)}> <0041> <${key(4)}> <${key(5)}> [<00e7> <00e1>] endbfrange`;
          assert.equal(
            await extract({
              cmap,
              content: `BT /F1 12 Tf <${[1, 2, 3, 4, 5].map(key).join("")}> Tj ET`,
            }),
            "ãABçá",
          );
        }
      },
    ],
    [
      "Differences WinAnsi/Standard e FontFile preservam glifos latinos",
      async () => {
        for (const base of ["WinAnsiEncoding", "StandardEncoding"]) {
          const font = `<< /Type /Font /Subtype /TrueType /BaseFont /Arial /FontDescriptor 9 0 R /Encoding << /BaseEncoding /${base} /Differences [65 /aacute /ccedilla /atilde /Aacute /Ccedilla /Atilde] >> >>`;
          assert.equal(
            await extract({
              text: "ABCDEF",
              font,
              extraObjects: [
                [9, "<< /Type /FontDescriptor /FontFile2 11 0 R >>"],
                [11, (await stream("fonte embutida")).object],
              ],
            }),
            "áçãÁÇÃ",
          );
        }
        assert.equal(await extract({ text: "\x80 \x93ação\x94" }), "€ “ação”");
        assert.equal(await extract({ text: "123.456.789\xad09" }), "123.456.789-09");
      },
    ],
    [
      "texto com imagem ignora o logo; página só com imagem é recusada",
      async () => {
        assert.equal(
          await extract({ text: "CPF 123.456.789-09", image: true }),
          "CPF 123.456.789-09",
        );
        assert.equal(await extract({ imageOnly: true }), null);
        const packedImage = /stream\n([\s\S]*)\nendstream/.exec((await stream("\x01\x02\x03")).object)[1];
        assert.equal(await extract({ content: `q BI /W 1 /H 1 /CS /RGB /BPC 8 /F /Fl ID ${packedImage} EI Q BT /F1 12 Tf (ok) Tj ET` }), "ok");
        assert.equal(await extract({ content: `q BI /W 1 /H 1 /F /Fl ID ${packedImage}` }), null);
        assert.equal(
          await extract({
            content:
              "q BI /W 1 /H 1 /CS /RGB /BPC 8 ID \x01\x02\x03 EI Q BT /F1 12 Tf (ok) Tj ET",
          }),
          "ok",
        );
        assert.equal(
          await extract({
            content: "q BI /W 1 /H 1 /CS /RGB /BPC 8 ID \x01\x02\x03 EI Q",
          }),
          null,
        );
        assert.equal(
          await extract({
            content:
              "q BI /W 1 /H 1 /F /DCT ID \xff\xd8\xff\xd9 EI Q BT /F1 12 Tf (ok) Tj ET",
          }),
          "ok",
        );
        assert.equal(
          await extract({
            pages: 2,
            image: true,
            extraObjects: [
              [9, (await stream("/Logo Do")).object],
              [21, "<< /Type /Page /Parent 2 0 R /Contents 9 0 R >>"],
            ],
          }),
          null,
        );
      },
    ],
    [
      "Contents em lista e Length indireto; Tj, TJ, aspas e quebras de linha",
      async () => {
        const second = await stream(
          "[(456.) -30 (789-09)] TJ (linha 2) ' 0 0 (linha 3) \" 0 -10 Td (linha 4) Tj 0 -10 TD (linha 5) Tj T* (fim) Tj ET",
        );
        assert.equal(
          await extract({
            indirectLength: true,
            content: "BT /F1 12 Tf (123.) Tj",
            contents: "[5 0 R 9 0 R]",
            extraObjects: [[9, second.object]],
          }),
          "123.456.789-09\nlinha 2\nlinha 3\nlinha 4\nlinha 5\nfim",
        );
        assert.equal(
          await extract({ indirectLength: true, objstm: true, text: "ok" }),
          "ok",
        );
      },
    ],
    [
      "fontes de mesmo nome são locais a cada página",
      async () => {
        const font =
          "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /BaseEncoding /WinAnsiEncoding /Differences [65 /ccedilla] >> >>";
        assert.equal(
          await extract({
            text: "A",
            pages: 2,
            extraObjects: [
              [9, font],
              [
                21,
                "<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << /Font << /F1 9 0 R >> >> >>",
              ],
            ],
          }),
          "A\nç",
        );
      },
    ],
    [
      "recusa Identity-H sem ToUnicode e códigos ausentes no CMap",
      async () => {
        assert.equal(
          await extract({
            font: "<< /Type /Font /Subtype /Type0 /Encoding /Identity-H >>",
          }),
          null,
        );
        assert.equal(
          await extract({
            cmap: "1 beginbfchar <01> <0041> endbfchar",
            content: "BT /F1 12 Tf <02> Tj ET",
          }),
          null,
        );
      },
    ],
    [
      "recusa Type3 inclusive com ToUnicode",
      async () => {
        for (const unicode of [false, true])
          assert.equal(await extract({ unicode, mutate: (raw) => raw.replace(unicode ? "/Subtype /Type0" : "/Subtype /Type1", "/Subtype /Type3") }), null);
      },
    ],
    [
      "recusa referências cíclicas em Contents, recursos e árvore de páginas",
      async () => {
        for (const opts of [
          { contents: "9 0 R", extraObjects: [[9, "[9 0 R]"]] },
          {
            contents: "9 0 R",
            extraObjects: [
              [9, "11 0 R"],
              [11, "9 0 R"],
            ],
          },
          {
            pageExtra: "/Resources 9 0 R",
            extraObjects: [
              [9, "11 0 R"],
              [11, "9 0 R"],
            ],
          },
          { extraObjects: [[2, "<< /Type /Pages /Kids [2 0 R] /Count 1 >>"]] },
        ])
          assert.equal(await extract(opts), null);
      },
    ],
    [
      "profundidade máxima de 32 na árvore de páginas",
      async () => {
        for (const depth of [32, 33]) {
          const extraObjects = [
            [
              2,
              "<< /Type /Pages /Kids [100 0 R] /Count 1 /Resources << /Font << /F1 4 0 R >> >> >>",
            ],
          ];
          for (let i = 1; i < depth; i++)
            extraObjects.push([
              99 + i,
              `<< /Type /Pages /Kids [${i === depth - 1 ? 3 : 100 + i} 0 R] /Count 1 >>`,
            ]);
          assert.equal(
            await extract({ text: "ok", extraObjects }),
            depth === 32 ? "ok" : null,
          );
        }
      },
    ],
    [
      "recusa bombas, excesso de streams, filtros, Encrypt e mais de dez páginas",
      async () => {
        assert.equal(
          await extract({ content: " ".repeat(PDF_INFLATE_LIMITS.bytes + 1) }),
          null,
        );
        assert.equal(await extract({ pages: 11 }), null);
        assert.equal(
          await extract({ pages: 10, text: "ok" }),
          Array(10).fill("ok").join("\n"),
        );
        assert.equal(await extract({ pageExtra: "/Encrypt 99 0 R" }), null);
        assert.equal(
          await extract({ streamExtra: "/DecodeParms << /Predictor 12 >>" }),
          null,
        );
        assert.equal(
          await extract({
            mutate: (raw) =>
              raw.replace(
                "/Filter /FlateDecode",
                "/Filter [/FlateDecode /ASCII85Decode]",
              ),
          }),
          null,
        );
        assert.equal(
          await extract({
            mutate: (raw) => raw.replace("stream\n", "stream\ncorrompido"),
          }),
          null,
        );
        assert.equal(await extract({ objstm: true, mutate: (raw) => raw.replace("/Type /ObjStm", "/DecodeParms << /Predictor 12 /Columns 7 >> /Type /ObjStm") }), null);
        const empty = (await stream(" ")).object;
        const extraObjects = Array.from(
          { length: PDF_INFLATE_LIMITS.streams },
          (_, i) => [100 + i, empty],
        );
        const contents = `[5 0 R ${extraObjects.map(([id]) => `${id} 0 R`).join(" ")}]`;
        assert.equal(await extract({ extraObjects, contents }), null);
        assert.equal(
          await extract({
            text: "ok",
            extraObjects,
            contents: `[5 0 R ${extraObjects
              .slice(1)
              .map(([id]) => `${id} 0 R`)
              .join(" ")}]`,
          }),
          "ok",
        );
        const large = await stream(" ".repeat(PDF_INFLATE_LIMITS.bytes / 2));
        assert.equal(
          await extract({
            extraObjects: [
              [9, large.object],
              [11, large.object],
            ],
            contents: "[5 0 R 9 0 R 11 0 R]",
          }),
          null,
        );
      },
    ],
    [
      "ignora XRef com DecodeParms Predictor 12 sem decodificar seus bytes",
      async () => {
        assert.equal(await extract({
          objstm: true,
          xrefPredictor: true,
          text: "ok",
        }), "ok");
        // Um XRef fora dos Contents não deve entrar no orçamento de descompressão.
        assert.equal(await extract({ text: "ok", extraObjects: [[9, (await stream(" ".repeat(PDF_INFLATE_LIMITS.bytes + 1), true, "/Type /XRef /DecodeParms << /Predictor 12 /Columns 7 >>")).object]] }), "ok");
        assert.equal(await extract({ streamExtra: "/Type /XRef /DecodeParms << /Predictor 12 /Columns 7 >>" }), null);
      },
    ],
    [
      "teto de 200 mil caracteres, inclusive soma de páginas",
      async () => {
        assert.equal(
          (await extract({ text: "a".repeat(200_000) }))?.length,
          200_000,
        );
        assert.equal(await extract({ text: "a".repeat(200_001) }), null);
        assert.equal(
          await extract({ text: "a".repeat(100_000), pages: 2 }),
          null,
        );
      },
    ],
  ];
}
