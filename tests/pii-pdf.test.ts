import { it } from "vitest";
import { extractPersonalPdf } from "../src/pii-pdf";
import { PDF_INFLATE_LIMITS } from "../src/pdf-reader";
import { pdfCases } from "./pdf-cases.mjs";

for (const [name, check] of pdfCases({
  extractPersonalPdf,
  PDF_INFLATE_LIMITS,
}))
  it(name, check);
