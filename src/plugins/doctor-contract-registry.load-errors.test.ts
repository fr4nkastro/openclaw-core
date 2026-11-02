import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "./manifest-registry.types.js";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  artifact: vi.fn(),
  warn: vi.fn(),
}));

// Isolate the registry boundary, not the declaration validation or module coercion.
vi.mock("../channels/plugins/bundled-setup-policy.js", () => ({}));
vi.mock("../config/bundled-channel-config-metadata.generated.js", () => ({
  GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA: [],
}));
vi.mock("../config/io.plugin-metadata.js", () => ({}));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: mocks.warn }),
}));
vi.mock("../plugin-sdk/doctor-migration-plan-adapter.js", () => ({}));
vi.mock("../state/artifact-preserving-state-reads.js", () => ({}));
vi.mock("./bundled-dir.js", () => ({}));
vi.mock("./bundled-plugin-scan.js", () => ({}));
vi.mock("./config-contract-matches.js", () => ({}));
vi.mock("./config-state.js", () => ({}));
vi.mock("./discovery-availability.js", () => ({}));
vi.mock("./discovery.js", () => ({}));
vi.mock("./doctor-compatibility-migration.js", () => ({}));
vi.mock("./doctor-contract-artifact.js", () => ({
  resolvePluginDoctorContractArtifact: mocks.artifact,
}));
vi.mock("./doctor-contract-legacy-setup.js", () => ({}));
vi.mock("./doctor-contract-relevance.js", () => ({ collectRelevantDoctorPluginIds: vi.fn() }));
vi.mock("./manifest-owner-policy.js", () => ({}));
vi.mock("./manifest-registry-build.js", () => ({}));
vi.mock("./plugin-registry.js", () => ({}));
vi.mock("./plugin-setup-module.js", () => ({
  getPluginSetupModuleLoader: () =>
    Object.assign(mocks.load, { initialize: (run: () => unknown) => run() }),
}));
vi.mock("./plugin-source-capture-context.js", () => ({}));
vi.mock("./public-surface-loader.js", () => ({}));

import {
  listPluginDoctorStateMigrationEntries,
  PluginDoctorContractUnavailableError,
  PluginDoctorStateMigrationDeclarationError,
} from "./doctor-contract-registry.js";
import { PluginDependencyLinkError } from "./plugin-instance-error.js";

function inspect(
  declaration: true | Array<{ id: string; doctorOnly?: true; phase?: "after-session-repair" }>,
  validateDeclarations = true,
) {
  const onInspectedPlugin = vi.fn();
  const onInspectedStatelessPlugin = vi.fn();
  const onUnavailablePlugin = vi.fn();
  const record = {
    id: "alpha",
    origin: "bundled",
    rootDir: "/fixture/alpha",
    channels: [],
    providers: [],
    doctorContract: { stateMigrations: declaration },
  } as unknown as PluginManifestRegistry["plugins"][number];
  return {
    onInspectedPlugin,
    onInspectedStatelessPlugin,
    onUnavailablePlugin,
    run: () =>
      listPluginDoctorStateMigrationEntries({
        inventory: {
          records: [record],
          knownPluginIds: [record.id],
          sessionStoreOwnerPluginIds: [],
          descriptors: [],
          unresolvedPluginIds: [],
        },
        validateDeclarations,
        onInspectedPlugin,
        onInspectedStatelessPlugin,
        onUnavailablePlugin,
      }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.artifact.mockReturnValue({
    modulePath: "/fixture/alpha/doctor-contract-api.js",
    boundaryRoot: "/fixture/alpha",
  });
});

describe("Doctor contract load failures", () => {
  it("reports ENOSPC as unavailable instead of an immutable action mismatch", () => {
    const cause = Object.assign(new Error("ENOSPC: no space left on device, copyfile"), {
      code: "ENOSPC",
    });
    mocks.load.mockImplementation(() => {
      throw cause;
    });
    const probe = inspect([{ id: "repair" }]);
    let failure: unknown;
    try {
      probe.run();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "PluginDoctorContractUnavailableError",
      cause,
      message: expect.stringMatching(/alpha.*unavailable.*ENOSPC/i),
    });
    expect(failure).toBeInstanceOf(PluginDoctorContractUnavailableError);
    expect((failure as Error).cause).toBe(cause);
    expect(failure).not.toBeInstanceOf(PluginDoctorStateMigrationDeclarationError);
    expect(probe.onInspectedPlugin).not.toHaveBeenCalled();
    expect(probe.onInspectedStatelessPlugin).not.toHaveBeenCalled();
    expect(probe.onUnavailablePlugin).not.toHaveBeenCalled();
  });

  it.each([true, []] as const)(
    "fails closed for declaration %j even without validation",
    (declaration) => {
      const cause = new Error("contract initialization failed");
      mocks.load.mockImplementation(() => {
        throw cause;
      });
      const probe = inspect(declaration === true ? true : [], false);
      expect(probe.run).toThrow(PluginDoctorContractUnavailableError);
      expect(probe.onInspectedPlugin).not.toHaveBeenCalled();
      expect(probe.onInspectedStatelessPlugin).not.toHaveBeenCalled();
      expect(probe.onUnavailablePlugin).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ id: "other" }],
    [{ id: "repair", doctorOnly: true }],
    [{ id: "repair", phase: "after-session-repair" }],
    [{ id: "repair" }, { id: "extra" }],
  ] as const)("still refuses a genuine declaration mismatch: %j", (...actions) => {
    mocks.load.mockReturnValue({
      stateMigrations: [
        {
          id: "repair",
          label: "Repair",
          detectLegacyState: () => null,
          migrateLegacyState: () => ({ changes: [], warnings: [] }),
        },
      ],
    });
    const probe = inspect([...actions]);
    expect(probe.run).toThrow(PluginDoctorStateMigrationDeclarationError);
    expect(probe.onInspectedPlugin).not.toHaveBeenCalled();
    expect(probe.onInspectedStatelessPlugin).not.toHaveBeenCalled();
  });

  it("retains dependency-link unavailability handling", () => {
    const error = new PluginDependencyLinkError("dependency unavailable");
    mocks.load.mockImplementation(() => {
      throw error;
    });
    const probe = inspect([{ id: "repair" }]);
    expect(probe.run()).toEqual([]);
    expect(probe.onUnavailablePlugin).toHaveBeenCalledExactlyOnceWith("alpha", error);
    expect(probe.onInspectedPlugin).not.toHaveBeenCalled();
    expect(probe.onInspectedStatelessPlugin).not.toHaveBeenCalled();
  });

  it("recognizes an actually inspected empty contract as stateless", () => {
    mocks.load.mockReturnValue({ stateMigrations: [] });
    const probe = inspect([]);
    expect(probe.run()).toEqual([]);
    expect(probe.onInspectedStatelessPlugin).toHaveBeenCalledExactlyOnceWith("alpha");
  });
});
