// Fork distribution composition, not an official registry installation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stampDesktopRuntimePlugins } from "./lib/desktop-runtime-plugins.mjs";

const [operation, packageRoot, commit] = process.argv.slice(2);
assert.ok(
  ["stage", "smoke"].includes(operation) && packageRoot && /^[0-9a-f]{40}$/.test(commit ?? ""),
  "Usage: fork-slack-cohort.mjs stage|smoke <package-root> <immutable-source-sha>",
);
const root = fs.realpathSync(packageRoot);
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
assert.equal(readJson("package.json").name, "openclaw");
assert.equal(
  readJson("dist/build-info.json").commit,
  commit,
  "Core build SHA does not match source",
);
assert.equal(readJson("dist/extensions/slack/package.json").name, "@openclaw/slack");
assert.equal(readJson("dist/extensions/slack/openclaw.plugin.json").id, "slack");
if (operation === "stage") {
  // This canonical owner records same-commit bundled selection. The canonical
  // packer's --bundle-plugin slack separately transfers bundledDist ownership,
  // composes runtime dependencies, removes exclusions and regenerates inventory.
  stampDesktopRuntimePlugins(root, { commit, pluginIds: ["slack"] });
} else {
  assert.deepEqual(
    readJson("dist/build-info.json").stagedOfficialPlugins,
    { commit, pluginIds: ["slack"] },
    "Missing or mismatched staged Slack SHA",
  );
  const manifest = readJson("dist/extensions/slack/package.json");
  assert.equal(manifest.openclaw?.build?.bundledDist, true, "Slack is not distribution-owned");
  assert.ok(
    !readJson("package.json").files?.includes("!dist/extensions/slack/**"),
    "Slack is still excluded from the core package",
  );
  const pluginRoot = path.join(root, "dist/extensions/slack");
  assert.equal(
    fs.realpathSync(pluginRoot),
    pluginRoot,
    "Slack resolves outside the installed artifact",
  );
  const entry = await import(pathToFileURL(path.join(pluginRoot, "index.js")).href);
  assert.equal(entry.default?.kind, "bundled-channel-entry");
  assert.equal(entry.default.loadChannelPlugin()?.id, "slack");
  // Channel entry loading alone leaves the provider lazy. This barrel imports
  // monitor/provider and therefore catches removed SDK paths AND named exports.
  const runtime = await import(pathToFileURL(path.join(pluginRoot, "runtime-api.js")).href);
  assert.equal(typeof runtime.monitorSlackProvider, "function");
  console.log(
    JSON.stringify(
      {
        source_sha: commit,
        plugin_id: "slack",
        package_name: manifest.name,
        origin: "bundled",
        relative_path: "dist/extensions/slack",
        runtime_import: "passed",
        official_registry_provenance: false,
      },
      null,
      2,
    ),
  );
}
