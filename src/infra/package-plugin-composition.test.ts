import { describe, expect, it } from "vitest";
import { composePackagePlugins } from "./package-plugin-composition.js";

describe("selected plugin package composition", () => {
  it("composes a private prerelease host with same-build Slack's satisfied host API floor", () => {
    const result = composePackagePlugins({ name: "openclaw", version: "2026.10.10-102" }, [
      {
        id: "slack",
        packageJson: {
          name: "@openclaw/slack",
          version: "2026.10.9",
          peerDependencies: { openclaw: ">=2026.10.9" },
        },
      },
    ]);
    expect(result.version).toBe("2026.10.10-102");
  });

  it.each(["2026.10.8-102", "2027.1.1-102"])("still rejects out-of-range host %s", (version) => {
    expect(() =>
      composePackagePlugins({ name: "openclaw", version }, [
        {
          id: "slack",
          packageJson: {
            name: "@openclaw/slack",
            version: "2026.10.9",
            peerDependencies: { openclaw: ">=2026.10.9 <2027.0.0" },
          },
        },
      ]),
    ).toThrow("requires peer openclaw");
  });

  it("does not admit a prerelease third-party peer by relaxing host composition", () => {
    expect(() =>
      composePackagePlugins(
        { name: "openclaw", version: "2026.10.10-102", dependencies: { other: "1.1.0-beta.1" } },
        [
          {
            id: "slack",
            packageJson: {
              name: "@openclaw/slack",
              version: "2026.10.9",
              peerDependencies: { other: ">=1.0.0" },
            },
          },
        ],
      ),
    ).toThrow("requires peer other");
  });

  it("preserves npm's all-dependencies bundle form when selecting plugins", () => {
    const result = composePackagePlugins(
      {
        name: "openclaw",
        version: "2026.10.6",
        dependencies: { "core-dependency": "1.0.0" },
        bundledDependencies: true,
      },
      [
        {
          id: "fixture",
          packageJson: {
            name: "fixture-plugin",
            version: "2026.10.6",
            dependencies: { "plugin-dependency": "2.0.0" },
          },
        },
      ],
    );
    expect(result.bundleDependencies).toEqual(["core-dependency", "plugin-dependency"]);
    expect(result.bundledDependencies).toBeUndefined();
  });

  it("retains plugin-owned patched dependency bundles with the core bundle", () => {
    const result = composePackagePlugins(
      {
        name: "openclaw",
        version: "2026.10.6",
        dependencies: { "chrome-devtools-mcp": "1.12.0" },
        bundleDependencies: ["chrome-devtools-mcp"],
      },
      [
        {
          id: "openai",
          packageJson: {
            name: "@openclaw/openai-provider",
            version: "2026.10.6",
            dependencies: { "@shinyoshiaki/binary-data": "0.6.1", werift: "0.25.0" },
            bundleDependencies: ["@shinyoshiaki/binary-data"],
          },
        },
        {
          id: "qa-lab",
          packageJson: {
            name: "@openclaw/qa-lab",
            version: "2026.10.6",
            dependencies: { "@openclaw/crabline": "0.1.31" },
            bundledDependencies: ["@openclaw/crabline"],
          },
        },
      ],
    );
    expect(result.bundleDependencies).toEqual([
      "@openclaw/crabline",
      "@shinyoshiaki/binary-data",
      "chrome-devtools-mcp",
    ]);
    expect(result.dependencies).toEqual({
      "chrome-devtools-mcp": "1.12.0",
      "@shinyoshiaki/binary-data": "0.6.1",
      werift: "0.25.0",
      "@openclaw/crabline": "0.1.31",
    });
  });
});
