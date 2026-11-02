import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { configureSqliteWalMaintenance } from "./sqlite-wal.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import { withSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-scope.js";
import type { SqliteWorkerOperationContext } from "./sqlite-worker-operation-settlement.js";
import { SqliteWorkerSlotCustody } from "./sqlite-worker-request-custody.js";
import {
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerAdmissionTimeout,
} from "./sqlite-writer-admission-client.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const filename = path.join(tempDirs.make("wal-admission-"), "proof.sqlite");
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL;
    CREATE TABLE proof (value BLOB);
    INSERT INTO proof VALUES (zeroblob(1048576)); DELETE FROM proof;`);
  const competitor = new DatabaseSync(filename);
  competitor.exec("PRAGMA busy_timeout = 0");
  const maintenance = configureSqliteWalMaintenance(db, { checkpointIntervalMs: 0 });
  const free = () => Number(db.prepare("PRAGMA freelist_count").get()!.freelist_count);
  const run = (
    port: SqliteWorkerOperationContext["port"],
    owner: SqliteWorkerOperationContext = { port },
  ) =>
    withSqliteWorkerOperationAdmission(owner, () =>
      maintenance.maintainPeriodic!({ maxPages: 1, checkpointMode: "PASSIVE" }, (stage) =>
        requestSqliteWorkerOperationAdmission({ stage, facts: { writerHeld: db.isTransaction } }),
      ),
    );
  const close = async () => {
    await maintenance.stop();
    competitor.close();
    db.close();
  };
  return { db, competitor, maintenance, free, run, close };
}

it.each(["transaction", "commit"] as const)(
  "cancels a stalled WAL %s grant, rolls back and rejects late authority",
  async (stage) => {
    const f = fixture();
    const before = f.free();
    let now = process.hrtime.bigint();
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
    const grants: boolean[] = [];
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
      grants.push(grant());
    });
    // Service the real host/client protocol synchronously; only the selected
    // writer-held admission is stalled. The native transaction/rollback are real.
    let stalled = false;
    let writerHeld = false;
    let freeWhileWaiting: number | undefined;
    vi.spyOn(Atomics, "wait").mockImplementation((_decision, _index, _value, timeout) => {
      const selected = f.db.isTransaction && (stage === "transaction" || grants.length === 2);
      if (!stalled && selected) {
        stalled = true;
        try {
          f.competitor.exec("BEGIN IMMEDIATE; ROLLBACK");
        } catch (error) {
          writerHeld = String(error).includes("database is locked");
        }
        freeWhileWaiting = f.free();
        now += 2_000_000_000n;
        if (timeout !== undefined) {
          return "timed-out";
        }
      }
      admission.service();
      return "ok";
    });
    try {
      const result = f.run(admission.port);
      expect(stalled).toBe(true);
      expect(writerHeld).toBe(true);
      expect(freeWhileWaiting).toBe(stage === "transaction" ? before : before - 1);
      expect(result.reclaimedPages).toBe(0);
      expect(f.maintenance.health?.state).toBe("error");
      expect(f.free()).toBe(before);
      expect(f.db.isTransaction).toBe(false);
      f.competitor.exec("BEGIN IMMEDIATE; INSERT INTO proof VALUES ('successor'); COMMIT");
      const countBeforeLate = grants.length;
      admission.service();
      expect(grants).toHaveLength(countBeforeLate);
      expect(admission.failure).toBeUndefined();
      expect(f.competitor.prepare("SELECT value FROM proof").get()!.value).toBe("successor");
    } finally {
      admission.finish();
      await f.close();
    }
  },
);

it.each(["refused", "custody revoked"] as const)(
  "does not commit vacuum after commit authority is %s",
  async (mode) => {
    const f = fixture();
    const before = f.free();
    const custody = new SqliteWorkerSlotCustody().createRequest();
    custody.activate();
    custody.accept();
    let commits = 0;
    let freeAtCommit: number | undefined;
    const admission = createSqliteWorkerOperationAdmission((request, grant) => {
      if (request.stage === "commit") {
        commits++;
        freeAtCommit = f.free();
        if (mode === "refused") {
          throw new Error("commit denied");
        }
        grant();
        custody.retire();
      } else {
        grant();
      }
    });
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      admission.service();
      return "ok";
    });
    try {
      const result = f.run(admission.port, {
        port: admission.port,
        requestCustody: custody.descriptor,
      });
      expect(commits).toBe(1);
      expect(freeAtCommit).toBe(before - 1);
      expect(result.reclaimedPages).toBe(0);
      expect(f.free()).toBe(before);
      expect(f.db.isTransaction).toBe(false);
      f.competitor.exec("BEGIN IMMEDIATE; COMMIT");
    } finally {
      admission.finish();
      await f.close();
    }
  },
);

it("bounds nested periodic maintenance commit without undoing an earlier authorized vacuum", async () => {
  const f = fixture();
  const before = f.free();
  let now = process.hrtime.bigint();
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
  let nested = false;
  let stalled = false;
  vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
    if (nested) {
      stalled = true;
      now += 2_000_000_000n;
      if (timeout !== undefined) return "timed-out";
    }
    admission.service();
    return "ok";
  });
  try {
    withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
      f.maintenance.maintainPeriodic!(
        { maxPages: 1, checkpointMode: "PASSIVE" },
        (stage) => requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
        () =>
          runSqliteImmediateTransactionSync(f.db, () => {
            f.db.exec("INSERT INTO proof VALUES ('uncommitted')");
            nested = true;
            requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
          }),
      ),
    );
    expect(stalled).toBe(true);
    expect(f.db.isTransaction).toBe(false);
    expect(f.db.prepare("SELECT * FROM proof").all()).toEqual([]);
    expect(f.free()).toBe(before - 1);
    expect(f.maintenance.health?.state).toBe("error");
    f.competitor.exec("BEGIN IMMEDIATE; COMMIT");
  } finally {
    admission.finish();
    await f.close();
  }
});

it("commits an authorized WAL unit and leaves ordinary admission unbounded", async () => {
  vi.spyOn(process.hrtime, "bigint").mockReturnValue(process.hrtime.bigint());
  const f = fixture();
  const before = f.free();
  const stages: string[] = [];
  const admission = createSqliteWorkerOperationAdmission((request, grant) => {
    stages.push(request.stage);
    grant();
  });
  const waits: Array<number | undefined> = [];
  vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
    waits.push(timeout);
    admission.service();
    return "ok";
  });
  try {
    expect(f.run(admission.port).reclaimedPages).toBeGreaterThan(0);
    expect(f.free()).toBeLessThan(before);
    expect(stages).toContain("commit");
    expect(waits.every((timeout) => timeout !== undefined && timeout <= 100)).toBe(true);
    withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
      withSqliteWorkerAdmissionTimeout(50, () =>
        withSqliteWorkerAdmissionTimeout(200, () =>
          requestSqliteWorkerOperationAdmission({
            stage: "commit",
            facts: undefined,
            deadlineMs: 5,
          }),
        ),
      ),
    );
    expect(waits.at(-1)).toBeGreaterThan(0);
    expect(waits.at(-1)).toBeLessThanOrEqual(5);
    withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined }),
    );
    expect(waits.at(-1)).toBeUndefined();
  } finally {
    admission.finish();
    await f.close();
  }
});
