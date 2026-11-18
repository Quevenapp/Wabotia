import { type Actor, type Env, ApiError } from "./types";
import {
  configureUpdates,
  configureAutomaticUpdates,
  resetUpdate,
  startUpdate,
} from "./updates";
import { configurePush } from "./push";
import { savePublicOrigin } from "./web-steps";
import { configureEmail } from "./email";
export async function maintenanceCommand(
  env: Env,
  actor: Actor,
  operation: string,
  data: any,
) {
  switch (operation) {
    case "system.updates.configure":
      return configureUpdates(env, actor, data);
    case "system.updates.automatic":
      return configureAutomaticUpdates(env, actor, data);
    case "system.updates.start":
      return startUpdate(env, actor, data);
    case "system.updates.reset":
      return resetUpdate(env, actor, data);
    case "system.push.configure":
      return configurePush(env, actor, data);
    case "system.origin.save":
      return savePublicOrigin(env, data);
    case "system.email.configure":
      return configureEmail(env, actor, data);
    default:
      throw new ApiError(
        400,
        "unknown_operation",
        "Operação de manutenção desconhecida.",
      );
  }
}
