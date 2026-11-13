// Tema aplicado antes da primeira pintura (Sistema / Claro / Escuro).
// Arquivo externo porque a política de conteúdo não permite script embutido.
(function () {
  var mode = "system";
  try {
    mode = localStorage.getItem("wabotia:theme") || "system";
  } catch (e) {}
  var dark =
    mode === "dark" ||
    (mode !== "light" &&
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
})();
