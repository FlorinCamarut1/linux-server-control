export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startBackgroundMonitor } = await import("@/lib/server");
    startBackgroundMonitor();
  }
}
