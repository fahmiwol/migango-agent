import { test } from "node:test";
import assert from "node:assert/strict";
import { gracefulShutdown } from "../../src/core/shutdown.mjs";
test("shutdown waits for final task persistence and worker teardown before destroying UI/stores", async () => {
  const order = [];
  let release;
  const task = new Promise((resolve) => {
    release = () => {
      order.push("task-persisted");
      resolve();
    };
  });
  const closing = gracefulShutdown({
    abort: () => order.push("abort"),
    pending: [task],
    closeWorkers: async () => order.push("workers-closed"),
    closeStores: () => order.push("stores-closed"),
    destroy: () => order.push("destroy"),
  });
  await Promise.resolve();
  assert.deepEqual(order, ["abort"]);
  release();
  await closing;
  assert.deepEqual(order, [
    "abort",
    "task-persisted",
    "workers-closed",
    "stores-closed",
    "destroy",
  ]);
});
test("unconfirmed worker teardown cannot destroy UI or claim graceful closure", async () => {
  let destroyed = false;
  await assert.rejects(
    () =>
      gracefulShutdown({
        abort: () => {},
        pending: [],
        closeWorkers: async () => {
          throw Error("termination unconfirmed");
        },
        closeStores: () => {},
        destroy: () => {
          destroyed = true;
        },
      }),
    /unconfirmed/,
  );
  assert.equal(destroyed, false);
});
