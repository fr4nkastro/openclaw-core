import { formatErrorMessage } from "../infra/errors.js";
import { PluginDependencyLinkError } from "./plugin-instance-error.js";

export class PluginDoctorContractUnavailableError extends Error {
  override name = "PluginDoctorContractUnavailableError";
}

/** Failed inspection never authorizes an empty state-migration declaration. */
export function handlePluginDoctorContractLoadError(
  error: unknown,
  surface: string,
  pluginId: string,
  modulePath: string,
): PluginDependencyLinkError | null {
  if (error instanceof PluginDependencyLinkError) {
    return error;
  }
  if (surface === "stateMigrations") {
    throw new PluginDoctorContractUnavailableError(
      `Doctor contract for ${pluginId} is unavailable from ${modulePath}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
  return null;
}
