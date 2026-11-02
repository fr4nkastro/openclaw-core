import fs from "node:fs";
import { hasErrnoCode } from "../infra/errno.js";

/** A dangling retained host peer must fork, never silently retarget old consumers. */
export function resolveRetainedPluginHost(link: string, present: fs.Stats): string | undefined {
  try {
    return fs.realpathSync(link);
  } catch (error) {
    if (!present.isSymbolicLink() || !hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return undefined;
  }
}
