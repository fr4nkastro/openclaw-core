import type { OpenClawConfig } from "../config/types.js";
import type { PluginDoctorCompatibilityOptions } from "./doctor-compatibility-migration.js";
import type { PluginManifestRegistry } from "./manifest-registry.types.js";

export type PluginDoctorRegistryParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
  /** Candidate generation prepared by the install owner before publication. */
  manifestRegistry?: PluginManifestRegistry;
  historicalWebhookListeners?: PluginDoctorCompatibilityOptions["historicalWebhookListeners"];
  /** Port preflight inspects retained data even when its selected owner is disabled. */
  includeDisabled?: boolean;
};
