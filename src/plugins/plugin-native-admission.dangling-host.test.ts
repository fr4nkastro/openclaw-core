import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { createPluginNativeAdmission } from "./plugin-native-admission.js";

afterEach(() => vi.restoreAllMocks());

async function withNativeHostFixture(
  run: (fixture: {
    oldHost: string;
    newHost: string;
    originalNative: string;
    originalPeer: string;
    capture: () => ReturnType<typeof createPluginNativeAdmission> & { resolve(): string };
  }) => void,
) {
  const parent = fs.mkdtempSync(path.join(tmpdir(), "native-dangling-host-"));
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(parent, "state") }, async () => {
      const source = path.join(parent, "source");
      const oldHost = path.join(parent, "old-prefix", "openclaw");
      const newHost = path.join(parent, "current-prefix", "openclaw");
      fs.mkdirSync(source, { recursive: true });
      fs.mkdirSync(oldHost, { recursive: true });
      fs.mkdirSync(newHost, { recursive: true });
      fs.writeFileSync(path.join(source, "package.json"), '{"name":"native-host-fixture"}');
      fs.writeFileSync(path.join(source, "index.cjs"), "exports.value = 1;");
      fs.writeFileSync(path.join(source, "addon.node"), "retained native bytes");
      const cache = createPluginCache();
      let next = 0;
      const capture = () =>
        withPluginCache(cache, () => {
          const directory = path.join(parent, `generation-${next++}`);
          fs.mkdirSync(directory);
          const admission = createPluginNativeAdmission(source, directory);
          const filename = path.join(source, "addon.node");
          const target = path.join(directory, "addon.node");
          const native = admission.materialize(
            filename,
            source,
            target,
            fs.statSync(filename, { bigint: true }),
          )!;
          const bytes = fs.readFileSync(filename);
          native.record({
            contentHash: createHash("sha256").update(bytes).digest("hex"),
            sizeBytes: bytes.length,
          });
          admission.finish({ signature: "fixture", sourceDigest: "fixture" });
          return { ...admission, resolve: () => target };
        });
      try {
        const first = capture();
        first.linkHost(oldHost);
        const originalNative = fs.realpathSync(first.resolve());
        const originalPeer = path.join(
          path.dirname(path.dirname(originalNative)),
          "node_modules",
          "openclaw",
        );
        expect(fs.realpathSync(originalPeer)).toBe(oldHost);
        run({ oldHost, newHost, originalNative, originalPeer, capture });
      } finally {
        await retirePluginCache(cache);
      }
    });
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

it.each(["missing", "present"])(
  "forks retained native bytes for a new host when the former host is %s",
  async (formerHost) => {
    await withNativeHostFixture(({ oldHost, newHost, originalNative, originalPeer, capture }) => {
      if (formerHost === "missing") {
        // Full-home bind relocation hides the previous prefix, not captured native bytes.
        fs.rmSync(oldHost, { recursive: true });
        expect(fs.lstatSync(originalPeer).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(originalPeer)).toBe(false);
      }
      const successor = capture();
      expect(() => successor.linkHost(newHost)).not.toThrow();
      const native = fs.realpathSync(successor.resolve());
      expect(native).not.toBe(originalNative);
      expect(fs.readFileSync(native, "utf8")).toBe("retained native bytes");
      expect(
        fs.realpathSync(path.join(path.dirname(path.dirname(native)), "node_modules", "openclaw")),
      ).toBe(newHost);
      // Old consumers retain their namespace; never repair their peer link in place.
      expect(fs.readlinkSync(originalPeer)).toBe(oldHost);
      expect(fs.readFileSync(originalNative, "utf8")).toBe("retained native bytes");
    });
  },
);

it("does not bypass native integrity validation when the former host is missing", async () => {
  await withNativeHostFixture(({ oldHost, newHost, originalNative, originalPeer, capture }) => {
    const successor = capture();
    fs.rmSync(oldHost, { recursive: true });
    fs.writeFileSync(originalNative, "tampered native bytes");
    expect(() => successor.linkHost(newHost)).toThrow(
      "Native plugin companion changed during admission",
    );
    expect(fs.readlinkSync(originalPeer)).toBe(oldHost);
  });
});

it("does not turn host peer permission failures into replacement authority", async () => {
  await withNativeHostFixture(({ newHost, originalPeer, capture }) => {
    const successor = capture();
    const realpath = fs.realpathSync;
    const failure = Object.assign(new Error("host peer access denied"), { code: "EACCES" });
    vi.spyOn(fs, "realpathSync").mockImplementation((...args) => {
      if (args[0] === originalPeer) {
        throw failure;
      }
      return Reflect.apply(realpath, fs, args);
    });
    expect(() => successor.linkHost(newHost)).toThrow(failure);
  });
});
