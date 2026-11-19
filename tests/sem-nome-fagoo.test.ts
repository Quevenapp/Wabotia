import { describe, expect, it } from "vitest";
import numberRouter from "../web/NumberRouter.tsx?raw";
import pairingPanel from "../web/PairingPanel.tsx?raw";
import pairing from "../src/pairing.ts?raw";
import service from "../src/service.ts?raw";
import openapi from "../src/integration-openapi.ts?raw";
import templates from "../src/service-templates.ts?raw";
import demo from "../web/lib/demo.ts?raw";
import seed from "../scripts/seed-local.mjs?raw";
import guide from "../scripts/build-guide.py?raw";

const files: Record<string, string> = {
  "web/NumberRouter.tsx": numberRouter,
  "web/PairingPanel.tsx": pairingPanel,
  "src/pairing.ts": pairing,
  "src/service.ts": service,
  "src/integration-openapi.ts": openapi,
  "src/service-templates.ts": templates,
  "web/lib/demo.ts": demo,
  "scripts/seed-local.mjs": seed,
  "scripts/build-guide.py": guide,
};

// Mantém posições e linhas para que o diagnóstico aponte o arquivo original.
const blank = (text: string) => text.replace(/[^\n]/g, " ");

function withoutComments(source: string, python: boolean) {
  // Consome strings antes dos comentários: URLs, # e /* dentro delas são texto.
  const tokens = python
    ? /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')|#[^\n]*/g
    : /("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  return source.replace(tokens, (token, string) => string ?? blank(token));
}

// Somente os formatos técnicos existentes; não libera um rótulo "fagoo".
const allowed = [
  /\bclient\s*===\s*"fagoo"/g,
  /\benum:\s*\["vinki",\s*"fagoo"\]/g,
  /\bclient IN \('vinki','fagoo'\)/g,
  /(["'])fagoo-erp\1/g,
  /(?:^|[,{])\s*fagoo(?=\s*:)/gm,
];

function violations(file: string, source: string) {
  let text = withoutComments(source, file.endsWith(".py"));
  for (const pattern of allowed) text = text.replace(pattern, blank);
  return [...text.matchAll(/fagoo/gi)].map((match) => {
    const line = text.slice(0, match.index).split("\n").length;
    return `${file}:${line}: nome antigo em texto não permitido`;
  });
}

describe("textos fora do ERP sem o nome antigo", () => {
  for (const [file, source] of Object.entries(files)) {
    it(file, () => {
      const found = violations(file, source);
      expect(found, found.join("\n")).toEqual([]);
    });
  }

  it("ignora comentários e valores técnicos, preservando a linha do texto visível", () => {
    expect(
      violations("painel.tsx", [
        "// Fagoo",
        "/* Fagoo\nFagoo */",
        'const clients = { fagoo: "ERP (pareamento antigo)" };',
        'if (body.client === "fagoo") {}',
        'const schema = { enum: ["vinki", "fagoo"] };',
        'const sql = "client IN (\'vinki\',\'fagoo\')";',
        'const id = "fagoo-erp";',
        '<p>FaGoO</p>',
      ].join("\n")),
    ).toEqual(["painel.tsx:9: nome antigo em texto não permitido"]);
  });

  it.each([
    ['painel.tsx', 'const label = "fagoo";'],
    ['painel.tsx', 'const label = "fagoo: sistema antigo";'],
    ['painel.tsx', 'const label = "https://example.test/Fagoo";'],
    ['painel.tsx', 'const label = "/* Fagoo */";'],
    ['painel.tsx', 'const label = `Fagoo ERP`;'],
    ['painel.tsx', '<p>fagoo-erp</p>'],
    ['guia.py', '# Fagoo\nlabel = "# Fagoo"'],
  ])("recusa texto visível em %s: %s", (file, source) => {
    expect(violations(file, source)).toHaveLength(1);
  });
});
