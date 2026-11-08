// The scoped signal cancels the operation underneath a timed-out host adapter.
export function awaitSignal(thunk, parentSignal, timeoutMs = 5000) {
  parentSignal.throwIfAborted();
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", parentAbort);
      controller.signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(controller.signal.reason || Error("Cancelled"));
    };
    const parentAbort = () =>
      controller.abort(parentSignal.reason || Error("Cancelled"));
    const timer = setTimeout(
      () =>
        controller.abort(
          Error("Agent adapter deadline exceeded; inspect before retry"),
        ),
      timeoutMs,
    );
    controller.signal.addEventListener("abort", abort, { once: true });
    parentSignal.addEventListener("abort", parentAbort, { once: true });
    if (parentSignal.aborted) parentAbort();
    Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return thunk(controller.signal);
      })
      .then(
        (value) => {
          cleanup();
          if (controller.signal.aborted) reject(controller.signal.reason);
          else resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
  });
}
