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
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw", files: [] }));
  writeFileSync(path.join(root, "dist/build-info.json"), JSON.stringify({ commit }));
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

test("fork release builds and canonically packages Slack instead of retaining the registry generation", () => {
  assert.match(workflow, /OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS: "slack"/);
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
    { commit: sha, pluginIds: ["slack"] },
  );
});

test("smoke imports the installed Slack monitor graph without starting it and records bundled provenance", (t) => {
  const root = fixture(t);
  assert.equal(run("stage", root).status, 0);
  const result = run("smoke", root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), "missing cohort runtime import proof");
  assert.deepEqual(JSON.parse(result.stdout), {
    source_sha: sha,
    plugin_id: "slack",
    package_name: "@openclaw/slack",
    origin: "bundled",
    relative_path: "dist/extensions/slack",
    runtime_import: "passed",
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
            ? { stagedOfficialPlugins: { commit: "b".repeat(40), pluginIds: ["slack"] } }
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
        JSON.stringify({ name: "openclaw", files: ["!dist/extensions/slack/**"] }),
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
