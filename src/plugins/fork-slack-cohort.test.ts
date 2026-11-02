import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import { buildPluginManifestRegistry } from "./manifest-registry-build.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { writeArtifacts as writeTree } from "./public-surface.test-support.js";

const host = vi.hoisted(() => ({ root: "" }));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRootSync: () => host.root,
}));
const commit = "a".repeat(40);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  host.root = tempDirs.make("fork-slack-selection-");
  writeTree(host.root, { "package.json": { name: "openclaw" } });
  vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", undefined);
}

it.each([undefined, "b".repeat(40), commit])(
  "selects matching staged Slack over a retained official generation only with SHA=%s",
  (stagedCommit) => {
    fixture();
    const pluginRoot = path.join(host.root, "dist/extensions/slack");
    const retained = tempDirs.make("retained-slack-");
    for (const root of [pluginRoot, retained]) {
      writeTree(root, {
        "package.json": {
          name: "@openclaw/slack",
          version: "2026.10.9",
          openclaw: { extensions: ["./index.js"], build: { bundledDist: root === pluginRoot } },
        },
        "openclaw.plugin.json": { id: "slack", configSchema: {} },
        // The incompatible retained runtime must never be evaluated.
        "index.js":
          root === retained
            ? 'throw new Error("retained official incompatible generation loaded");'
            : "export default {};",
      });
    }
    writeTree(host.root, {
      "dist/build-info.json": {
        commit,
        ...(stagedCommit
          ? { stagedOfficialPlugins: { commit: stagedCommit, pluginIds: ["slack"] } }
          : {}),
      },
    });
    const config = {
      channels: { slack: { enabled: true } },
      bindings: [{ agentId: "routing-fixture", match: { channel: "slack" } }],
      plugins: { entries: { slack: { enabled: true } } },
    };
    const installRecords = {
      slack: { source: "npm" as const, spec: "@openclaw/slack@2026.10.9", installPath: retained },
    };
    const before = JSON.stringify({ config, installRecords });
    const registry = withPluginCache(createPluginCache(), () =>
      buildPluginManifestRegistry({
        env: process.env,
        config,
        getInstallRecords: () => installRecords,
        candidates: [
          recordPluginCandidateInstallOwner(
            {
              rootDir: retained,
              origin: "global",
              idHint: "slack",
              source: path.join(retained, "index.js"),
            },
            "slack",
          ),
          {
            rootDir: pluginRoot,
            origin: "bundled",
            idHint: "slack",
            source: path.join(pluginRoot, "index.js"),
          },
        ],
      }),
    );
    const selected = registry.plugins.find((plugin) => plugin.id === "slack");
    expect(selected).toMatchObject({
      rootDir: stagedCommit === commit ? pluginRoot : retained,
      origin: stagedCommit === commit ? "bundled" : "global",
    });
    if (stagedCommit === commit) {
      expect(selected?.trust).toMatchObject({ reason: "bundled" });
    }
    expect(JSON.stringify({ config, installRecords })).toBe(before);
  },
);
