import { it } from "vitest";
import { extractPersonalPdf, extractMaskedPersonalPdf } from "../src/pii-pdf";
import { createPiiMask } from "../src/pii-mask";
import { PDF_INFLATE_LIMITS } from "../src/pdf-reader";
import { pdfCases } from "./pdf-cases.mjs";

for (const [name, check] of pdfCases({
  extractPersonalPdf,
  extractMaskedPersonalPdf,
  createPiiMask,
  PDF_INFLATE_LIMITS,
}))
  it(name, check);
