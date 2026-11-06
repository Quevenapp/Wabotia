// Node.js 22+. Run only against an authorized conversation; this sends a message.
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
const {
  WABOTIA_URL,
  WABOTIA_KEY,
  WABOTIA_PROFILE,
  WABOTIA_CONVERSATION,
  WABOTIA_REQUEST_ID,
} = process.env;
const [file, mime = "application/pdf", type = "document", text = ""] =
  process.argv.slice(2);
if (
  ![
    WABOTIA_URL,
    WABOTIA_KEY,
    WABOTIA_PROFILE,
    WABOTIA_CONVERSATION,
    WABOTIA_REQUEST_ID,
    file,
  ].every(Boolean)
)
  throw Error(
    "Defina URL, KEY, PROFILE, CONVERSATION, REQUEST_ID e informe arquivo, MIME, tipo e legenda.",
  );
const root = `${WABOTIA_URL.replace(/\/$/, "")}/api/v1/profiles/${WABOTIA_PROFILE}`;
async function request(path, data, step, binary = false, method = "POST") {
  const r = await fetch(root + path, {
    method,
    headers: {
      Authorization: `Bearer ${WABOTIA_KEY}`,
      "Content-Type": binary ? "application/octet-stream" : "application/json",
      "Idempotency-Key": `${WABOTIA_REQUEST_ID}:${step}`,
    },
    body: binary ? data : JSON.stringify(data),
  });
  const result = await r.json();
  if (!r.ok)
    throw Error(
      `${r.status}: ${result.error?.message}. Preserve REQUEST_ID e os mesmos dados antes de repetir.`,
    );
  return result;
}
const upload = await request(
  "/media/uploads",
  { name: basename(file), type: mime, size: (await stat(file)).size },
  "upload",
);
const handle = await open(file, "r");
try {
  for (let n = 1; n <= upload.parts; n++) {
    const chunk = Buffer.alloc(upload.part_size),
      { bytesRead } = await handle.read(
        chunk,
        0,
        chunk.length,
        (n - 1) * chunk.length,
      );
    await request(
      `/media/uploads/${upload.id}/parts/${n}`,
      chunk.subarray(0, bytesRead),
      `part-${n}`,
      true,
      "PUT",
    );
  }
} finally {
  await handle.close();
}
await request(`/media/uploads/${upload.id}/complete`, {}, "complete");
await request(
  `/conversations/${WABOTIA_CONVERSATION}/actions`,
  { action: "claim" },
  "claim",
);
const result = await request(
  `/conversations/${WABOTIA_CONVERSATION}/actions`,
  { action: "reply", text, attachments: [upload.id], content: { type } },
  "reply",
);
console.log(JSON.stringify(result)); // pending is queued, not proof of delivery.
