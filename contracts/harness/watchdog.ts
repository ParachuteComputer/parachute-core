// Preloaded into the throwaway hub and vault (`bun --preload`). If the harness that started them goes away, by
// any means including SIGKILL, the service is re-parented and exits within half a second. Signal handlers can't
// promise that; this can.
const startedBy = process.ppid;
setInterval(() => {
  if (process.ppid !== startedBy) process.exit(0);
}, 500).unref();
export {};
