import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const sha = "a".repeat(40);
const script = new URL("../../scripts/fork-slack-cohort.mjs", import.meta.url);
function fixture(t, commit = sha) {
  const root = mkdtempSync(path.join(os.tmpdir(), "fork-slack-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, "dist/extensions/slack");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify(hostManifest()));
  writeFileSync(path.join(root, "dist/build-info.json"), JSON.stringify({ commit }));
  mkdirSync(path.join(root, "dist/plugin-sdk"), { recursive: true });
  writeFileSync(
    path.join(root, "dist/plugin-sdk/agent-harness-runtime.js"),
    "export const sanitizeToolResult = (value) => value;",
  );
  const codex = path.join(root, "dist/extensions/codex");
  mkdirSync(codex, { recursive: true });
  writeFileSync(
    path.join(codex, "package.json"),
    JSON.stringify({
      name: "@openclaw/codex",
      type: "module",
      openclaw: { extensions: ["./index.js"], build: { bundledDist: true } },
    }),
  );
  writeFileSync(path.join(codex, "openclaw.plugin.json"), JSON.stringify({ id: "codex" }));
  writeFileSync(path.join(codex, "index.js"), 'export default { id: "codex" };');
  // Lazy harness chunk: never imported by the entry, so only static checks reach it.
  writeFileSync(
    path.join(codex, "harness.js"),
    'import { sanitizeToolResult as s } from "openclaw/plugin-sdk/agent-harness-runtime"; export const h = s;',
  );
  writeFileSync(
    path.join(plugin, "package.json"),
    JSON.stringify({
      name: "@openclaw/slack",
      type: "module",
      openclaw: { extensions: ["./index.js"], build: { bundledDist: true } },
    }),
  );
  writeFileSync(path.join(plugin, "openclaw.plugin.json"), JSON.stringify({ id: "slack" }));
  writeFileSync(
    path.join(plugin, "index.js"),
    'export default { kind: "bundled-channel-entry", loadChannelPlugin: () => ({ id: "slack" }) };',
  );
  writeFileSync(
    path.join(plugin, "runtime-api.js"),
    'export function monitorSlackProvider() { throw Error("must not start"); }',
  );
  return root;
}
function hostManifest(files = []) {
  return {
    name: "openclaw",
    files,
    exports: { "./plugin-sdk/agent-harness-runtime": "./dist/plugin-sdk/agent-harness-runtime.js" },
  };
}
function run(operation, root, commit = sha) {
  return spawnSync(process.execPath, [script.pathname, operation, root, commit], {
    encoding: "utf8",
  });
}
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/fork-hotfix-release.yml", import.meta.url),
  "utf8",
);

test("fork release builds and canonically packages Codex and Slack instead of retaining the registry generation", () => {
  assert.match(workflow, /OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS: "codex,slack"/);
  assert.match(workflow, /--bundle-plugin codex/);
  assert.match(workflow, /--bundle-plugin slack/);
  assert.match(workflow, /fork-slack-cohort\.mjs stage/);
  assert.match(workflow, /fork-slack-cohort\.mjs[" ]+smoke/);
});

test("stage records the immutable matching source cohort using the canonical staging owner", (t) => {
  const root = fixture(t);
  const result = run("stage", root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(root, "dist/build-info.json"))).stagedOfficialPlugins,
    { commit: sha, pluginIds: ["codex", "slack"] },
  );
});

test("smoke imports the installed cohort graphs without starting it and records bundled provenance", (t) => {
  const root = fixture(t);
  assert.equal(run("stage", root).status, 0);
  const result = run("smoke", root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), "missing cohort runtime import proof");
  assert.deepEqual(JSON.parse(result.stdout), {
    source_sha: sha,
    plugins: [
      {
        plugin_id: "codex",
        package_name: "@openclaw/codex",
        origin: "bundled",
        relative_path: "dist/extensions/codex",
        sdk_paths_checked: 1,
        runtime_import: "passed",
      },
      {
        plugin_id: "slack",
        package_name: "@openclaw/slack",
        origin: "bundled",
        relative_path: "dist/extensions/slack",
        sdk_paths_checked: 0,
        runtime_import: "passed",
      },
    ],
    official_registry_provenance: false,
  });
});

for (const commit of [undefined, "b".repeat(40), "short-sha"]) {
  test(`stage refuses missing/wrong build SHA (${commit}) without stamping`, (t) => {
    const root = fixture(t, commit);
    const file = path.join(root, "dist/build-info.json");
    if (commit === undefined) writeFileSync(file, "{}");
    const before = readFileSync(file, "utf8");
    assert.notEqual(run("stage", root).status, 0);
    assert.equal(readFileSync(file, "utf8"), before);
  });
}

for (const variant of [
  "missing-stage",
  "wrong-stage",
  "unowned",
  "excluded",
  "removed-sdk-path",
  "missing-named-export",
  "codex-removed-sdk-path",
  "codex-missing-sdk-export",
]) {
  test(`smoke refuses ${variant} rather than approving an incompatible cohort`, (t) => {
    const root = fixture(t);
    assert.equal(run("stage", root).status, 0);
    const plugin = path.join(root, "dist/extensions/slack");
    if (variant === "missing-stage" || variant === "wrong-stage") {
      writeFileSync(
        path.join(root, "dist/build-info.json"),
        JSON.stringify({
          commit: sha,
          ...(variant === "wrong-stage"
            ? { stagedOfficialPlugins: { commit: "b".repeat(40), pluginIds: ["codex", "slack"] } }
            : {}),
        }),
      );
    } else if (variant === "unowned") {
      const file = path.join(plugin, "package.json");
      const manifest = JSON.parse(readFileSync(file));
      manifest.openclaw.build.bundledDist = false;
      writeFileSync(file, JSON.stringify(manifest));
    } else if (variant === "excluded") {
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify(hostManifest(["!dist/extensions/slack/**"])),
      );
    } else if (variant.startsWith("codex-")) {
      // The registry codex 2026.10.9 failure mode: a lazy chunk needs an SDK
      // export (or path) this private host does not provide.
      writeFileSync(
        path.join(root, "dist/extensions/codex/harness.js"),
        variant === "codex-removed-sdk-path"
          ? 'import { x } from "openclaw/plugin-sdk/heartbeat-runtime"; export const h = x;'
          : 'import { sanitizeToolArgs } from "openclaw/plugin-sdk/agent-harness-runtime"; export const h = sanitizeToolArgs;',
      );
    } else {
      writeFileSync(
        path.join(plugin, "runtime-api.js"),
        variant === "removed-sdk-path"
          ? 'import "openclaw/plugin-sdk/heartbeat-runtime"; export function monitorSlackProvider() {}'
          : 'import { requestHeartbeat } from "./removed-export.js"; export function monitorSlackProvider() { return requestHeartbeat; }',
      );
      writeFileSync(
        path.join(plugin, "removed-export.js"),
        "export const enqueueSessionEvent = () => {};",
      );
    }
    const result = run("smoke", root);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  });
}
