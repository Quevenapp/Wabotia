// Hash volátil (volatile-hashes.mjs): só na chave declarada do RPC declarado,
// e só quando as duas pontas são sha256.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerVolatileHash, volatileHash } from "./volatile-hashes.mjs";

const a = "a".repeat(64),
  b = "b".repeat(64);

test("vale só na chave declarada, no RPC declarado, com duas pontas sha256", () => {
  assert.equal(volatileHash("erp_purchase_receipts_receive", "chain_hash", a, b), true);
  assert.equal(volatileHash("erp_purchase_receipts_preview", "chain_hash", a, b), false, "outro RPC compara o texto");
  assert.equal(volatileHash("erp_purchase_receipts_receive", "preview_hash", a, b), false, "outra chave compara o texto");
  assert.equal(volatileHash("erp_purchase_receipts_receive", "chain_hash", a, "x"), false, "a outra ponta não é hash");
});

test("declaração sem motivo ou repetida é erro", () => {
  assert.throws(() => registerVolatileHash({ rpc: "x", key: "y" }));
  assert.throws(() => registerVolatileHash({ rpc: "erp_purchase_receipts_receive", key: "chain_hash", reason: "de novo" }));
});
