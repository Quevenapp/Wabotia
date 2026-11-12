// Envio de arquivos em partes (até 100 MB): cria o upload, manda cada parte
// com Idempotency-Key "{upload}:{parte}" e conclui. Em falha, cancela.
import type { Api } from "../lib/api";

export async function uploadFile(
  api: Api,
  root: string,
  file: File,
  progress: (n: number) => void,
) {
  if (file.size > 100 * 1024 * 1024)
    throw Error(
      "Cada arquivo pode ter até 100 MB. O canal pode ter limites menores.",
    );
  const upload = await api(root + "/media/uploads", "POST", {
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
  });
  try {
    for (let i = 0; i < upload.parts; i++) {
      const response = await fetch(
        `/api/${root}/media/uploads/${upload.id}/parts/${i + 1}`,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/octet-stream",
            "Idempotency-Key": `${upload.id}:${i + 1}`,
          },
          body: file.slice(i * upload.part_size, (i + 1) * upload.part_size),
        },
      );
      if (!response.ok)
        throw Error(
          ((await response.json().catch(() => null)) as any)?.error?.message ||
            "Não foi possível enviar esta parte.",
        );
      progress(Math.round(((i + 1) / upload.parts) * 100));
    }
    return (
      await api(root + `/media/uploads/${upload.id}/complete`, "POST", {})
    ).id as string;
  } catch (e) {
    await api(root + `/media/uploads/${upload.id}/abort`, "POST", {}).catch(
      () => {},
    );
    throw e;
  }
}
