// Casos compartilhados pelo vitest e pela verificação local sem Worker/rede.
import assert from "node:assert/strict";

export async function textPdf(text = "CPF 123.456.789-09", compressed = false) {
  const stream = `BT /F1 12 Tf 10 20 Td (${text.replace(/[\\()]/g, "\\$&")}) Tj ET`;
  let bytes = new TextEncoder().encode(stream);
  if (compressed)
    bytes = new Uint8Array(
      await new Response(
        new Blob([bytes])
          .stream()
          .pipeThrough(new CompressionStream("deflate")),
      ).arrayBuffer(),
    );
  const data = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  const raw = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n5 0 obj\n<< /Length ${bytes.length}${compressed ? " /Filter /FlateDecode" : ""} >>\nstream\n${data}\nendstream\nendobj\n%%EOF`;
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function piiCases({
  createPiiMask,
  detectPii,
  maskPersonalEnabled,
  extractPersonalPdf,
  toolLoop,
  MAX_ROUNDS,
}) {
  return [
    [
      "detecta documentos, e-mail, CEP e telefones brasileiros",
      () => {
        for (const [kind, text] of [
          ["CPF", "123.456.789-09"],
          ["CPF", "52998224725"],
          ["CPF", "CPF 12345678900"],
          ["CNPJ", "12.345.678/0001-90"],
          ["CNPJ", "11222333000181"],
          ["TEL", "+55 (11) 98888-7777"],
          ["TEL", "5511988887777"],
          ["TEL", "11988887777"],
          ["TEL", "(11) 3333-4444"],
          ["TEL", "1133334444"],
          ["TEL", "telefone 98888-7777"],
          ["EMAIL", "ana.silva+teste@exemplo.com.br"],
          ["CEP", "01310-100"],
          ["CEP", "CEP 01310100"],
        ])
          assert.equal(detectPii(text)[0]?.kind, kind, text);
      },
    ],
    [
      "não confunde pedidos, dinheiro, datas, horários e identificadores",
      () => {
        for (const text of [
          "pedido 12345",
          "pedido 11988887777",
          "protocolo: 52998224725",
          "ordem nº 11222333000181",
          "R$ 11988887777",
          "R$ 1.234,56",
          "R$ 52998224725,00",
          "18/11/2026 às 12:34:56",
          "2026-11-18 09:30",
          "18.11.2026",
          "12345678",
          "id_11988887777",
          "abc52998224725xyz",
          "rua das Flores, 123",
          "pedido 1234567890",
          "(00) 98888-7777",
        ])
          assert.deepEqual(detectPii(text), [], text);
      },
    ],
    [
      "marcadores estáveis entre formatos, histórico e ferramentas; restauração recursiva",
      () => {
        const pii = createPiiMask();
        assert.equal(
          pii.mask("123.456.789-09 +55 (11) 98888-7777"),
          "[CPF_1] [TEL_1]",
        );
        assert.equal(pii.mask("12345678909 11988887777"), "[CPF_1] [TEL_1]");
        assert.deepEqual(
          pii.restoreValue({
            a: ["[CPF_1]", { tel: "[TEL_1]" }],
            b: "[CPF_999]",
          }),
          {
            a: ["123.456.789-09", { tel: "+55 (11) 98888-7777" }],
            b: "[CPF_999]",
          },
        );
        assert.equal(
          pii.maskValue({ telefone: 11988887777 }).telefone,
          "[TEL_1]",
        );
        assert.deepEqual(
          pii.maskValue({
            cep: "01310100",
            pedido: 11988887777,
            valor: 11988887777,
          }),
          { cep: "[CEP_1]", pedido: 11988887777, valor: 11988887777 },
        );
        assert.equal(
          JSON.parse(pii.maskValue('{"cep":"01310100"}')).cep,
          "[CEP_1]",
        );
        assert.equal(JSON.stringify(pii).includes("123.456"), false);
        assert.equal(createPiiMask().restore("[CPF_1]"), "[CPF_1]");
      },
    ],
    [
      "campo ausente liga; só false desliga; fontes do Conhecimento ficam intactas",
      () => {
        assert.equal(maskPersonalEnabled({}, "default"), true);
        assert.equal(
          maskPersonalEnabled(
            { bot_options: { default: { mask_personal: false } } },
            "default",
          ),
          false,
        );
        assert.equal(
          maskPersonalEnabled(
            { bot_options: { default: { mask_personal: false } } },
            "outro",
          ),
          true,
        );
        const input = JSON.stringify({
          request: "123.456.789-09",
          history: [{ text: "12345678909" }],
          sources: [
            { document_id: "conhecimento", text: "123.456.789-09" },
            { document_id: "specialist", text: "123.456.789-09" },
          ],
        });
        assert.equal(createPiiMask(false).maskInput(input), input);
        const masked = JSON.parse(createPiiMask().maskInput(input));
        assert.equal(masked.request, "[CPF_1]");
        assert.equal(masked.history[0].text, "[CPF_1]");
        assert.equal(masked.sources[0].text, "123.456.789-09");
        assert.equal(masked.sources[1].text, "[CPF_1]");
      },
    ],
    [
      "marcadores escritos pelo cliente são reservados e desconhecidos ficam literais",
      () => {
        const pii = createPiiMask();
        assert.equal(pii.mask("[CPF_1] 123.456.789-09"), "[CPF_1] [CPF_2]");
        assert.equal(pii.restore("[CPF_1] [CPF_2]"), "[CPF_1] 123.456.789-09");
      },
    ],
    [
      "extrai PDF textual simples e FlateDecode; junta strings de kerning",
      async () => {
        for (const compressed of [false, true])
          assert.equal(
            await extractPersonalPdf(
              await textPdf("CPF 123.456.789-09", compressed),
            ),
            "CPF 123.456.789-09",
          );
        const bytes = await textPdf();
        const raw = new TextDecoder().decode(bytes);
        const oldStream = /stream\n([\s\S]*?)\nendstream/.exec(raw)[1];
        const stream = "BT /F1 12 Tf [(123.) -10 (456.789-09)] TJ ET";
        const split = raw
          .replace(oldStream, stream)
          .replace(`/Length ${oldStream.length}`, `/Length ${stream.length}`);
        assert.equal(
          await extractPersonalPdf(new TextEncoder().encode(split)),
          "123.456.789-09",
        );
        const hexStream = "BT /F1 12 Tf <3132332e3435362e3738392d3039> Tj ET";
        const hex = raw
          .replace(oldStream, hexStream)
          .replace(
            `/Length ${oldStream.length}`,
            `/Length ${hexStream.length}`,
          );
        assert.equal(
          await extractPersonalPdf(new TextEncoder().encode(hex)),
          "123.456.789-09",
        );
      },
    ],
    [
      "recusa PDF sem texto, criptografado, fonte sem mapa e filtro desconhecido",
      async () => {
        assert.equal(
          await extractPersonalPdf(
            new TextEncoder().encode("%PDF-1.4\n/Type /Page\n%%EOF"),
          ),
          null,
        );
        const raw = new TextDecoder().decode(await textPdf());
        for (const pdf of [
          raw + "\n/Encrypt 6 0 R",
          raw.replace("/Helvetica", "/FonteSemMapa"),
          raw.replace("/Type1", "/Type0"),
          raw.replace("/Length", "/Filter /LZWDecode /Length"),
          raw + "\n/Subtype /Image",
          raw.replace("/WinAnsiEncoding", "/EncodingInexistente"),
        ])
          assert.equal(
            await extractPersonalPdf(new TextEncoder().encode(pdf)),
            null,
          );
      },
    ],
    ...["anthropic", "openai", "responses"].map((family) => [
      `todas as rodadas e teto sem vazamento (${family})`,
      async () => {
        const pii = createPiiMask();
        const raw = "CPF 123.456.789-09, telefone +55 (11) 98888-7777";
        // O modelo só viu marcadores, então só os repete. Os itens dele voltam
        // intactos ao provedor (assinaturas e cifrado não podem mudar); a
        // máscara vale para o que o servidor acrescenta: os resultados.
        const echoed = pii.mask(raw);
        let calls = 0,
          executions = 0;
        const result = await toolLoop({
          family,
          pii,
          tools: [],
          messages: [{ role: "user", content: pii.mask(raw) }],
          complete: async (messages, tools, final) => {
            const body = JSON.stringify({ messages, tools });
            calls++;
            for (const value of [
              "123.456.789-09",
              "98888-7777",
              "ana@exemplo.com",
            ])
              assert.equal(body.includes(value), false, body);
            assert.ok(body.includes("[CPF_1]"));
            const text = "Seu CPF [CPF_1] foi registrado";
            if (family === "anthropic")
              return {
                content: final
                  ? [{ type: "text", text }]
                  : [
                      {
                        type: "tool_use",
                        id: `t${calls}`,
                        name: "registrar",
                        input: { cpf: "[CPF_1]" },
                      },
                      { type: "text", text: echoed },
                    ],
              };
            if (family === "responses")
              return {
                output: final
                  ? [
                      {
                        type: "message",
                        content: [{ type: "output_text", text }],
                      },
                    ]
                  : [
                      {
                        type: "function_call",
                        call_id: `t${calls}`,
                        name: "registrar",
                        arguments: '{"cpf":"[CPF_1]"}',
                      },
                      {
                        type: "message",
                        content: [{ type: "output_text", text: echoed }],
                      },
                    ],
              };
            return {
              choices: [
                {
                  message: final
                    ? { content: text }
                    : {
                        content: echoed,
                        reasoning_content: echoed,
                        tool_calls: [
                          {
                            id: `t${calls}`,
                            type: "function",
                            function: {
                              name: "registrar",
                              arguments: '{"cpf":"[CPF_1]"}',
                            },
                          },
                        ],
                      },
                },
              ],
            };
          },
          run: async (call) => {
            executions++;
            assert.equal(call.args.cpf, "123.456.789-09");
            return raw + " ana@exemplo.com";
          },
        });
        assert.equal(calls, MAX_ROUNDS + 1);
        assert.equal(executions, MAX_ROUNDS);
        assert.equal(
          pii.restoreText(result.text),
          "Seu CPF 123.456.789-09 foi registrado",
        );
      },
    ]),
  ];
}
