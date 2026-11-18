// Formulário de Gestão → Estabelecimento: a leitura (GET /establishment) vira
// o formulário, e o formulário vira o corpo do PUT /settings {establishment}.
// Sem React, para o teste (tests/establishment-form.test.ts). O endereço em
// texto livre tem várias linhas: as quebras vão e voltam como estão.

export const ADDRESS_KEYS = [
  "street",
  "number",
  "complement",
  "district",
  "city",
  "state",
  "postal_code",
  "municipality_code",
] as const;

export type EstablishmentForm = Record<string, string | number>;

/** "-22.9056" ou "-22,9056" → número; vazio → null; inválido → NaN. */
export const coordinate = (text: unknown) => {
  const t = String(text ?? "").trim().replace(",", ".");
  return t ? Number(t) : null;
};

/** O formulário a partir da leitura: o texto livre gravado (address_free), com as quebras. */
export function establishmentForm(data: Record<string, any>): EstablishmentForm {
  return {
    name: data.name || "",
    document: data.document_display || "",
    // O `address` da leitura pode vir montado dos campos; o que se edita é o gravado.
    address: data.address_free ?? data.address ?? "",
    phone: data.phone || "",
    footer: data.footer || "",
    ...Object.fromEntries(ADDRESS_KEYS.map((k) => [k, data[k] || ""])),
    latitude: data.latitude ?? "",
    longitude: data.longitude ?? "",
  };
}

/**
 * O corpo do PUT /settings {establishment}. O texto livre só troca \r\n por
 * \n (o servidor faz o mesmo e corta as pontas). Posição inválida: erro.
 */
export function establishmentPayload(form: EstablishmentForm) {
  const latitude = coordinate(form.latitude),
    longitude = coordinate(form.longitude);
  if (Number.isNaN(latitude) || Number.isNaN(longitude))
    throw new Error("Posição da loja: use números, como -22.9056 e -47.0608.");
  return {
    ...form,
    address: String(form.address ?? "").replace(/\r\n/g, "\n"),
    latitude,
    longitude,
  };
}
