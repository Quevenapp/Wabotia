// Gestão → Estabelecimento: o endereço em texto livre tem várias linhas e as
// quebras vão e voltam pelo formulário (achado da K na instalação de teste:
// num campo de uma linha, "…Centro\nCidade Exemplo/SP" virava
// "…CentroCidade Exemplo/SP" e era gravado assim ao salvar).
import { describe, expect, it } from "vitest";
import { establishmentForm, establishmentPayload } from "../web/admin/establishment-form";
import { api, bearer, fixture } from "./service-center-fixture";

const ADDRESS = "Rua das Flores, 120\nCentro\nCidade Exemplo/SP";

describe("formulário do estabelecimento", () => {
  it("leitura → formulário → corpo do PUT: as quebras de linha ficam", () => {
    const form = establishmentForm({
      name: "Loja Exemplo",
      address: "Montado, 1 - Centro, Cidade/SP",
      address_free: ADDRESS,
      latitude: null,
      longitude: null,
    });
    // O que se edita é o texto gravado, não o montado dos campos.
    expect(form.address).toBe(ADDRESS);
    expect(establishmentPayload(form).address).toBe(ADDRESS);
    // Colado do Windows: \r\n vira \n.
    expect(establishmentPayload({ ...form, address: "A\r\nB" }).address).toBe("A\nB");
    expect(establishmentPayload({ ...form, latitude: "-22,9", longitude: "-47.06" })).toMatchObject({
      latitude: -22.9,
      longitude: -47.06,
    });
    expect(() => establishmentPayload({ ...form, latitude: "abc", longitude: "1" })).toThrow(/Posição da loja/);
  });

  it("ida e volta pela API: salvar o formulário duas vezes não perde as quebras", async () => {
    const f = await fixture();
    const admin = await bearer(f.admin);
    const path = `/profiles/${f.profile}`;
    const read = async () => (await api(admin, `${path}/establishment`)).json<any>();
    const save = async (form: Record<string, any>) =>
      expect(
        (await api(admin, `${path}/settings`, "PUT", { establishment: establishmentPayload(form) })).status,
      ).toBe(200);
    await save({ ...establishmentForm(await read()), name: "Loja Exemplo", address: ADDRESS });
    const first = await read();
    expect([first.address, first.address_free]).toEqual([ADDRESS, ADDRESS]);
    // Salvar de novo o que a tela leu (sem mexer no endereço) mantém as linhas.
    await save(establishmentForm(first));
    expect((await read()).address_free).toBe(ADDRESS);
  });
});
