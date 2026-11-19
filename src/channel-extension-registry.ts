import type { ChannelContext, ChannelId } from "./channel-contracts";
import type { ChannelConnectionDriver, ChannelExtension, ChannelMaintenance, ChannelRoute, ExtensionKey } from "./channel-c2-contracts";
import { CHANNEL_EXTENSION_STUBS, EXTENSION_KEYS } from "./channel-extension-stubs";

export function extensionKey(channel: unknown, context: ChannelContext = "direct"): ExtensionKey | null {
  const key = `${String(channel)}/${context}`;
  return EXTENSION_KEYS.includes(key as ExtensionKey) ? key as ExtensionKey : null;
}
export function createChannelExtensionRegistry() {
  const extensions = new Map<ExtensionKey, ChannelExtension>();
  const drivers = new Map<ChannelId, ChannelConnectionDriver>();
  const maintenance = new Map<string, ChannelMaintenance>();
  function registerChannelExtension(extension: ChannelExtension): void {
    if (!EXTENSION_KEYS.includes(extension.key) || extensionKey(extension.spec.id, extension.key.split("/")[1] as ChannelContext) !== extension.key)
      throw new Error("Chave de extensão de canal inválida.");
    const previous = extensions.get(extension.key);
    if (previous === extension) return;
    if (previous) throw new Error(`Extensão já registrada: ${extension.key}.`);
    const driver = extension.connectionDriver;
    if (driver && (driver.channel !== extension.spec.id || (drivers.has(driver.channel) && drivers.get(driver.channel) !== driver)))
      throw new Error("Driver de conexão já registrado ou incompatível.");
    const nextMaintenance = new Map(maintenance);
    for (const entry of extension.maintenance ?? []) {
      if (!entry.key || (nextMaintenance.has(entry.key) && nextMaintenance.get(entry.key) !== entry))
        throw new Error("Manutenção de canal já registrada.");
      nextMaintenance.set(entry.key, entry);
    }
    const routeKeys = new Set([...extensions.values()].filter(ext => ext.spec.id === extension.spec.id).flatMap(ext => ext.routes.map(route => `${route.method} ${route.path.replace(/:[^/]+/g, ":param")}`)));
    for (const route of extension.routes) {
      const key = `${route.method} ${route.path.replace(/:[^/]+/g, ":param")}`;
      if (!route.path.startsWith("/") || route.path.startsWith("/c2/") || route.path.includes("..") || routeKeys.has(key))
        throw new Error("Rota de canal inválida ou duplicada.");
      routeKeys.add(key);
    }
    // Validação completa antes de alterar qualquer mapa; nenhuma leitura de ambiente.
    extensions.set(extension.key, extension);
    if (driver) drivers.set(driver.channel, driver);
    for (const [key, entry] of nextMaintenance) maintenance.set(key, entry);
  }
  function findChannelRoute(method: string, path: string, channel?: ChannelId) {
    const parts = path.replace(/^\/c2(?=\/|$)/, "").split("/");
    for (const extension of extensions.values()) {
      if (channel && extension.spec.id !== channel) continue;
      const setupRoutes: readonly ChannelRoute[] = extension.connectionDriver ? ["GET", "POST"].map(method => ({
        method: method as "GET" | "POST", path: "/connections/:id/setup", authorization: "admin",
        async handler(ctx) { const { performConnectionSetup } = await import("./channel-extension-kernel"); return performConnectionSetup(ctx, method); },
      })) : [];
      for (const route of [...extension.routes, ...setupRoutes]) {
      if (route.method !== method.toUpperCase()) continue;
      const pattern = route.path.split("/");
      if (parts.length !== pattern.length) continue;
      const params: Record<string, string> = {};
      if (pattern.every((part, index) => {
        if (!part.startsWith(":")) return part === parts[index];
        if (!parts[index]) return false;
        try { params[part.slice(1)] = decodeURIComponent(parts[index]); return !params[part.slice(1)].includes("/"); }
        catch { return false; }
      })) return { extension, route, params };
      }
    }
    return null;
  }
  return {
    registerChannelExtension, findChannelRoute,
    channelExtension: (key: ExtensionKey): ChannelExtension => extensions.get(key) ?? CHANNEL_EXTENSION_STUBS[key],
    channelExtensionReady: (key: ExtensionKey) => extensions.has(key),
    channelConnectionDriver: (channel: ChannelId) => drivers.get(channel) ?? null,
    channelMaintenance: (key: string) => maintenance.get(key) ?? null,
    registeredChannelExtensions: () => [...extensions.values()],
    registeredChannelMaintenance: () => [...maintenance.values()],
  };
}
export const {
  registerChannelExtension, findChannelRoute, channelExtension, channelExtensionReady,
  channelConnectionDriver, channelMaintenance, registeredChannelExtensions, registeredChannelMaintenance,
} = createChannelExtensionRegistry();
export function installChannelExtensions(extensions: readonly ChannelExtension[]): void {
  for (const extension of extensions) registerChannelExtension(extension);
}
