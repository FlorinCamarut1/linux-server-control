export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { recoverInterruptedRuns, startBackgroundMonitor } = await import("@/lib/server");
    recoverInterruptedRuns();
    startBackgroundMonitor();
  }
}
