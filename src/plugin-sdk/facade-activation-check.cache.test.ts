import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";

const mocks = vi.hoisted(() => ({
  applyPluginAutoEnable: vi.fn((params: { config: Record<string, unknown> }) => ({
    config: { ...params.config, autoEnabled: true },
    autoEnabledReasons: { fixture: ["configured"] },
  })),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));
vi.mock("../config/plugin-auto-enable.shared.js", () => ({
  configMayNeedPluginAutoEnable: () => true,
}));
vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: () => ({
    manifestRegistry: {
      plugins: [
        {
          id: "fixture",
          origin: "bundled",
          rootDir: "/nonexistent/fixture",
          channels: ["fixture-channel"],
        },
      ],
    },
  }),
}));
vi.mock("./facade-resolution-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./facade-resolution-shared.js")>()),
  resolveBundledMetadataManifestRecord: () => null,
}));

import {
  getFacadeBoundaryResolutionCountForTest,
  resolveBundledPluginPublicSurfaceAccess,
  resolveTrackedFacadePluginId,
} from "./facade-activation-check.runtime.js";

const params = { dirName: "fixture-channel", artifactBasename: "api.js" };

describe("facade boundary config cache", () => {
  beforeEach(() => {
    mocks.applyPluginAutoEnable.mockClear();
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
  });

  it("resolves plugin auto-enable once for many session rows of one config revision", () => {
    setRuntimeConfigSnapshot({ plugins: { allow: ["fixture"] } });
    const before = getFacadeBoundaryResolutionCountForTest();
    const results = Array.from({ length: 500 }, () =>
      resolveBundledPluginPublicSurfaceAccess(params),
    );
    expect(getFacadeBoundaryResolutionCountForTest() - before).toBe(1);
    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(resolveTrackedFacadePluginId(params)).toBe("fixture");
  });

  it("returns the same answer as a fresh resolution", () => {
    const config = { plugins: { allow: ["fixture"] } };
    setRuntimeConfigSnapshot(config);
    resolveBundledPluginPublicSurfaceAccess(params);
    const cached = resolveBundledPluginPublicSurfaceAccess(params);
    // An equal but distinct snapshot object cannot reuse the cached entry.
    setRuntimeConfigSnapshot(structuredClone(config));
    const before = getFacadeBoundaryResolutionCountForTest();
    const fresh = resolveBundledPluginPublicSurfaceAccess(params);
    expect(getFacadeBoundaryResolutionCountForTest() - before).toBe(1);
    expect(fresh).toEqual(cached);
  });

  it("re-resolves after a config reload publishes a new snapshot", () => {
    setRuntimeConfigSnapshot({ plugins: { allow: ["fixture"] } });
    resolveBundledPluginPublicSurfaceAccess(params);
    const before = getFacadeBoundaryResolutionCountForTest();
    setRuntimeConfigSnapshot({ plugins: { allow: [] } });
    resolveBundledPluginPublicSurfaceAccess(params);
    resolveBundledPluginPublicSurfaceAccess(params);
    expect(getFacadeBoundaryResolutionCountForTest() - before).toBe(1);
  });

  it("re-resolves when the process environment changes", () => {
    setRuntimeConfigSnapshot({ plugins: { allow: ["fixture"] } });
    resolveBundledPluginPublicSurfaceAccess(params);
    const before = getFacadeBoundaryResolutionCountForTest();
    vi.stubEnv("OPENCLAW_FACADE_CACHE_TEST_KEY", "set");
    resolveBundledPluginPublicSurfaceAccess(params);
    resolveBundledPluginPublicSurfaceAccess(params);
    expect(getFacadeBoundaryResolutionCountForTest() - before).toBe(1);
  });
});
