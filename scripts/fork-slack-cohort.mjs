// Fork distribution composition, not an official registry installation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stampDesktopRuntimePlugins } from "./lib/desktop-runtime-plugins.mjs";

// Plugins compiled from the same checkout as the private core. A registry
// generation built against upstream SDK exports cannot load on this host.
export const COHORT_PLUGIN_IDS = ["codex", "slack"];

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
for (const id of COHORT_PLUGIN_IDS) {
  assert.equal(readJson(`dist/extensions/${id}/package.json`).name, `@openclaw/${id}`);
  assert.equal(readJson(`dist/extensions/${id}/openclaw.plugin.json`).id, id);
}

function listModules(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : listModules(file);
    }
    return /\.m?js$/.test(entry.name) ? [file] : [];
  });
}

// Lazy chunks (harness, monitors) are not reached by importing the entry, so
// statically resolve every host SDK import, including named exports, against
// this installed core.
async function assertHostSdkImports(id, pluginRoot) {
  const exportsMap = readJson("package.json").exports ?? {};
  const required = new Map();
  const pattern =
    /(?:import|export)\s*(?:(\{[^}]*\})|\*\s*as\s+\w+|\w+)?\s*(?:,\s*\{[^}]*\}\s*)?(?:from\s*)?["']openclaw\/plugin-sdk\/([\w./-]+)["']/g;
  for (const file of listModules(pluginRoot)) {
    for (const [, names, subpath] of fs.readFileSync(file, "utf8").matchAll(pattern)) {
      const set = required.get(subpath) ?? new Set();
      for (const raw of names?.slice(1, -1).split(",") ?? []) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
        if (name && !raw.trim().startsWith("type ")) set.add(name);
      }
      required.set(subpath, set);
    }
  }
  for (const [subpath, names] of required) {
    const target = exportsMap[`./plugin-sdk/${subpath}`];
    const relative = typeof target === "string" ? target : target?.default;
    assert.ok(relative, `${id} imports removed SDK path openclaw/plugin-sdk/${subpath}`);
    const sdk = await import(pathToFileURL(path.join(root, relative)).href);
    for (const name of names) {
      assert.ok(name in sdk, `${id} imports missing export ${name} from plugin-sdk/${subpath}`);
    }
  }
  return required.size;
}

if (operation === "stage") {
  // This canonical owner records same-commit bundled selection. The canonical
  // packer's --bundle-plugin flags separately transfer bundledDist ownership,
  // compose runtime dependencies, remove exclusions and regenerate inventory.
  stampDesktopRuntimePlugins(root, { commit, pluginIds: COHORT_PLUGIN_IDS });
} else {
  assert.deepEqual(
    readJson("dist/build-info.json").stagedOfficialPlugins,
    { commit, pluginIds: COHORT_PLUGIN_IDS },
    "Missing or mismatched staged cohort SHA",
  );
  const plugins = [];
  for (const id of COHORT_PLUGIN_IDS) {
    const manifest = readJson(`dist/extensions/${id}/package.json`);
    assert.equal(manifest.openclaw?.build?.bundledDist, true, `${id} is not distribution-owned`);
    assert.ok(
      !readJson("package.json").files?.includes(`!dist/extensions/${id}/**`),
      `${id} is still excluded from the core package`,
    );
    const pluginRoot = path.join(root, `dist/extensions/${id}`);
    assert.equal(
      fs.realpathSync(pluginRoot),
      pluginRoot,
      `${id} resolves outside the installed artifact`,
    );
    const sdkPaths = await assertHostSdkImports(id, pluginRoot);
    const entry = await import(pathToFileURL(path.join(pluginRoot, "index.js")).href);
    if (id === "slack") {
      assert.equal(entry.default?.kind, "bundled-channel-entry");
      assert.equal(entry.default.loadChannelPlugin()?.id, "slack");
      // Channel entry loading alone leaves the provider lazy. This barrel imports
      // monitor/provider and therefore catches removed SDK paths AND named exports.
      const runtime = await import(pathToFileURL(path.join(pluginRoot, "runtime-api.js")).href);
      assert.equal(typeof runtime.monitorSlackProvider, "function");
    } else {
      assert.ok(entry.default, `${id} entry has no default export`);
    }
    plugins.push({
      plugin_id: id,
      package_name: manifest.name,
      origin: "bundled",
      relative_path: `dist/extensions/${id}`,
      sdk_paths_checked: sdkPaths,
      runtime_import: "passed",
    });
  }
  console.log(
    JSON.stringify(
      { source_sha: commit, plugins, official_registry_provenance: false },
      null,
      2,
    ),
  );
}
