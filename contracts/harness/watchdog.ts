// Preloaded into the throwaway hub and vault (`bun --preload`). If the harness that started them goes away, by
// any means including SIGKILL, the service exits within half a second. Signal handlers can't promise that; this can.
// The harness passes its own pid, so a harness that dies before this file even runs is still noticed.
const harness = Number(process.env.PCORE_HARNESS_PID);
if (harness > 0) {
  setInterval(() => {
    try {
      process.kill(harness, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") process.exit(0);
    }
  }, 500).unref();
}
export {};
