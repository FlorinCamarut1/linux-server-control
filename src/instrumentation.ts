export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { announceSetupToken, onDashboardEvent, read, recoverInterruptedRuns, runDueBackup, startBackgroundMonitor } = await import("@/lib/server");
    const { samplePower } = await import("@/lib/power");
    const { deliver } = await import("@/lib/notify");
    // Registered once per process; events from every module instance reach it.
    const events = globalThis as { lscNotifications?: boolean };
    if (!events.lscNotifications) {
      events.lscNotifications = true;
      onDashboardEvent((event) => void deliver(event));
    }
    announceSetupToken();
    recoverInterruptedRuns();
    startBackgroundMonitor();
    // Smart plugs are read every minute, independently of the host snapshot.
    const state = globalThis as { lscPower?: ReturnType<typeof setInterval> };
    if (!state.lscPower) {
      let running = false;
      state.lscPower = setInterval(() => {
        if (running) return;
        running = true;
        samplePower().catch((error) => console.error("Power sampling:", error instanceof Error ? error.message : error)).finally(() => { running = false; });
      }, 60000);
      state.lscPower.unref?.();
    }
    // Cloud backups are made when their schedule says, looked at every 5 minutes.
    const backups = globalThis as { lscBackups?: ReturnType<typeof setInterval> };
    if (!backups.lscBackups) {
      let checking = false;
      backups.lscBackups = setInterval(() => {
        if (checking || !read<{ password?: string }>("config", {}).password) return;
        checking = true;
        runDueBackup().catch((error) => console.error("Cloud backup:", error instanceof Error ? error.message : error)).finally(() => { checking = false; });
      }, 5 * 60 * 1000);
      backups.lscBackups.unref?.();
    }
  }
}
