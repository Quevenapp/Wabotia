// Selo do emissor de notas (web/erp/emissor.ts): sem cofre não se fala de
// certificado; com cofre, o estado do certificado do último teste, pela data.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOT_CONFIGURED,
  createDemoEmissorPort,
  emissorBadge,
} from "./emissor.ts";

const DAY = 86_400_000;
const at = Date.parse("2026-11-17T15:00:00.000Z");
const withCertificate = (validUntil) => ({
  ...NOT_CONFIGURED,
  configured: true,
  url: "https://cofre.example",
  api_key_set: true,
  checked: {
    at: at - DAY,
    ok: true,
    error: null,
    state: {
      provider: "nfapi",
      version: "0.3.2",
      update: { published: null, pending: false },
      certificate:
        validUntil === null
          ? null
          : {
              holder: "EMPRESA LTDA",
              document: null,
              valid_until: validUntil,
              days_left: 999, // envelhece: o selo conta pela data
            },
      production_released: false,
    },
  },
});

test("sem cofre: 'Emissão não configurada', com atalho, e nunca 'Certificado inválido'", () => {
  const badge = emissorBadge(NOT_CONFIGURED, at);
  assert.equal(badge.text, "Emissão não configurada");
  assert.equal(badge.tone, "warning");
  assert.deepEqual(badge.action, { label: "Configurar", to: "/certificado-a1" });
  assert.doesNotMatch(badge.text + badge.title, /inválido/);
});

test("cofre sem teste de conexão pede o teste", () => {
  const badge = emissorBadge({ ...NOT_CONFIGURED, configured: true, api_key_set: true }, at);
  assert.equal(badge.text, "Emissor sem teste de conexão");
  assert.equal(badge.action.label, "Testar");
});

test("certificado do cofre: válido, a vencer, vence hoje, vencido e ausente", () => {
  assert.equal(emissorBadge(withCertificate(new Date(at + 200 * DAY).toISOString()), at).tone, "ok");
  assert.equal(emissorBadge(withCertificate(new Date(at + 200 * DAY).toISOString()), at).action, null);
  const soon = emissorBadge(withCertificate(new Date(at + 12 * DAY + 3600_000).toISOString()), at);
  assert.equal(soon.text, "Certificado vence em 12 dias");
  assert.equal(soon.tone, "warning");
  assert.equal(emissorBadge(withCertificate(new Date(at + 3600_000).toISOString()), at).text, "Certificado vence hoje");
  const expired = emissorBadge(withCertificate(new Date(at - 2 * DAY).toISOString()), at);
  assert.equal(expired.text, "Certificado vencido");
  assert.equal(expired.tone, "error");
  assert.equal(emissorBadge(withCertificate(null), at).text, "Cofre sem certificado A1");
});

test("sem leitura (sem papel, Fiscal desligado) não há selo; a demonstração não grava", async () => {
  assert.equal(emissorBadge(null, at), null);
  const demo = createDemoEmissorPort();
  assert.equal((await demo.read()).configured, false);
  await assert.rejects(demo.save({ url: "https://x.example" }), /nada é gravado/);
});
