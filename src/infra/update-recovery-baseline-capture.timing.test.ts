import { afterEach, expect, it, vi } from "vitest";

const { debug } = vi.hoisted(() => ({ debug: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ debug }),
}));

vi.mock("../commands/backup-verify-manifest.js", () => ({}));
vi.mock("../commands/doctor-rehearsal-databases.js", () => ({}));
vi.mock("../config/io.factory.js", () => ({}));
vi.mock("../config/io.plugin-metadata.js", () => ({}));
vi.mock("../plugins/doctor-contract-registry.js", () => ({}));
vi.mock("../state/openclaw-state-db-readonly.js", () => ({}));
vi.mock("./backup-config-capture.js", () => ({}));
vi.mock("./update-database-backup.js", () => ({}));
vi.mock("../snapshot/local-repository.js", () => ({}));
vi.mock("./database-engine/registry.js", () => ({}));
vi.mock("./directory-durability.js", () => ({}));
vi.mock("./sqlite-private-directory.js", () => ({}));
vi.mock("./update-run-driver.js", () => ({}));

import { withRecoveryCapturePhase } from "./update-recovery-baseline-capture.js";

afterEach(() => {
  vi.restoreAllMocks();
  debug.mockClear();
});

it("records bounded start and success timing without logging the result", async () => {
  vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(125);
  const secret = { path: "/private/config", token: "secret" };
  await expect(withRecoveryCapturePhase("config-read", async () => secret)).resolves.toBe(secret);
  expect(debug.mock.calls).toEqual([
    ["Recovery capture phase", { phase: "config-read", event: "start" }],
    [
      "Recovery capture phase",
      { phase: "config-read", event: "end", outcome: "success", elapsedMs: 25 },
    ],
  ]);
});

it.each([false, true])(
  "records failure in finally (cancelled=%s) and preserves the error",
  async (cancelled) => {
    const controller = new AbortController();
    const failure = new Error("secret failure path /private/config");
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(130);
    await expect(
      withRecoveryCapturePhase(
        "plugin-resource-preparation",
        async () => {
          if (cancelled) controller.abort(failure);
          throw failure;
        },
        controller.signal,
      ),
    ).rejects.toBe(failure);
    expect(debug.mock.calls).toEqual([
      ["Recovery capture phase", { phase: "plugin-resource-preparation", event: "start" }],
      [
        "Recovery capture phase",
        {
          phase: "plugin-resource-preparation",
          event: "end",
          outcome: cancelled ? "cancelled" : "failure",
          elapsedMs: 30,
        },
      ],
    ]);
  },
);
