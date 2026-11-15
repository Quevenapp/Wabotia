// Pedido (módulo "pedido"): registra rotas, comandos e ganchos no núcleo
// (src/modules/api.ts). Cardápio em ./menu.ts. Uso: docs/PEDIDO.md.
import { onCommand, onRead, onRoute } from "../api";
import {
  deleteCategory,
  deleteGroup,
  deleteItem,
  getItem,
  loadMenu,
  saveCategory,
  saveGroup,
  saveItem,
  saveMenuImages,
  setItemAvailability,
  setOptionAvailability,
} from "./menu";

const MODULE = "pedido";

// ---------------------------------------------------------------------------
// Cardápio: leitura para a equipe e as integrações; cadastro pelo
// administrador; esgotado/disponível por qualquer pessoa da equipe.

onRead(MODULE, "pedido/menu", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  return loadMenu(ctx);
});
onRead(MODULE, "pedido/items/:id", async (ctx, actor, { params }) => {
  ctx.access(actor, "conversations:read");
  return getItem(ctx, params.id);
});

onRoute(MODULE, {
  method: "POST",
  path: "pedido/categories",
  op: "pedido.category.save",
});
onRoute(MODULE, {
  method: "PUT",
  path: "pedido/categories/:id",
  op: "pedido.category.save",
});
onRoute(MODULE, {
  method: "DELETE",
  path: "pedido/categories/:id",
  op: "pedido.category.delete",
});
onCommand(MODULE, "pedido.category.save", (ctx, actor, data) =>
  saveCategory(ctx, actor, data),
);
onCommand(MODULE, "pedido.category.delete", (ctx, actor, data) =>
  deleteCategory(ctx, actor, data.id),
);

onRoute(MODULE, {
  method: "POST",
  path: "pedido/items",
  op: "pedido.item.save",
});
onRoute(MODULE, {
  method: "PUT",
  path: "pedido/items/:id",
  op: "pedido.item.save",
});
onRoute(MODULE, {
  method: "DELETE",
  path: "pedido/items/:id",
  op: "pedido.item.delete",
});
onRoute(MODULE, {
  method: "POST",
  path: "pedido/items/:id/availability",
  op: "pedido.item.availability",
});
onCommand(MODULE, "pedido.item.save", (ctx, actor, data) =>
  saveItem(ctx, actor, data),
);
onCommand(MODULE, "pedido.item.delete", (ctx, actor, data) =>
  deleteItem(ctx, actor, data.id),
);
onCommand(MODULE, "pedido.item.availability", (ctx, actor, data) =>
  setItemAvailability(ctx, actor, data),
);

onRoute(MODULE, {
  method: "POST",
  path: "pedido/groups",
  op: "pedido.group.save",
});
onRoute(MODULE, {
  method: "PUT",
  path: "pedido/groups/:id",
  op: "pedido.group.save",
});
onRoute(MODULE, {
  method: "DELETE",
  path: "pedido/groups/:id",
  op: "pedido.group.delete",
});
onRoute(MODULE, {
  method: "POST",
  path: "pedido/groups/:id/availability",
  op: "pedido.group.availability",
});
onCommand(MODULE, "pedido.group.save", (ctx, actor, data) =>
  saveGroup(ctx, actor, data),
);
onCommand(MODULE, "pedido.group.delete", (ctx, actor, data) =>
  deleteGroup(ctx, actor, data.id),
);
onCommand(MODULE, "pedido.group.availability", (ctx, actor, data) =>
  setOptionAvailability(ctx, actor, data),
);

onRoute(MODULE, {
  method: "PUT",
  path: "pedido/menu-images",
  op: "pedido.images.save",
});
onCommand(MODULE, "pedido.images.save", (ctx, actor, data) =>
  saveMenuImages(ctx, actor, data),
);
