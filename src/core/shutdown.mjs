export async function gracefulShutdown({
  abort,
  pending,
  closeWorkers,
  closeStores,
  destroy,
}) {
  abort();
  await Promise.allSettled(pending.filter(Boolean));
  await closeWorkers();
  await closeStores();
  destroy();
}
