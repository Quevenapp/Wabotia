import { test } from "node:test";
import assert from "node:assert/strict";
import { erpCommercialOperations } from "../../src/modules/erp/commercial-operations.ts";
import { erpOperations, describeErpOperation } from "../../src/modules/erp/openapi.ts";
import { erpRouteExists } from "../../src/erp/blocks.ts";

test("contratos das operações habilitadas têm rota, entrada, efeito e OpenAPI", () => {
  const ids = new Set(), paths = new Set();
  assert.ok(erpCommercialOperations.length > 20);
  for (const op of erpCommercialOperations) {
    assert.ok(!ids.has(op.id), op.id); ids.add(op.id);
    const key = op.method + " " + op.path;
    assert.ok(!paths.has(key), key); paths.add(key);
    assert.ok(erpRouteExists(op.method, op.path.replace(/:\w+/g, "00000000-0000-4000-8000-000000000001")), key);
    assert.ok(op.summary.length > 10 && op.description.length > 10 && op.result.length > 10, op.id);
    assert.equal(typeof op.sensitive, "boolean");
    assert.equal(op.params.type, "object");
    for (const required of op.params.required) assert.ok(Object.hasOwn(op.params.properties, required), `${op.id}:${required}`);
    const path = "/profiles/{profile}/erp" + op.path.replace(/:(\w+)/g, "{$1}");
    assert.ok(erpOperations.some(([method, url]) => method === op.method.toLowerCase() && url === path));
    const entry = { description: "", parameters: [...path.matchAll(/\{(\w+)\}/g)].map(m => ({ in: "path", name: m[1] })) };
    const success = {};
    describeErpOperation(path, op.method.toLowerCase(), entry, success);
    assert.equal(entry.operationId, op.id);
    assert.equal(entry["x-bot-sensitive"], op.sensitive);
    assert.equal(success.description, op.result);
    for (const parameter of entry.parameters.filter(p => p.in === "path" && p.name !== "profile")) assert.ok(parameter.schema, op.id);
    if (op.method === "POST") assert.ok(entry.requestBody.content["application/json"].schema, op.id);
  }
});
