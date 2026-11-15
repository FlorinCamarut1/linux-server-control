// What the server is busy with, and what it is waiting for: the processes
// that use the most CPU and memory, the package updates it can install,
// whether it needs a restart, and the services that failed. All of it is read
// only, by one host command each, when Overview asks.
import { runAsync, serverSettings } from "./ssh";

// The processes are read twice, a second apart: a process's CPU use is the
// CPU time it took in between, as a share of what all the cores had. Each
// line of /proc/<pid>/stat is the process's number, its name in parentheses
// (which may itself hold spaces and parentheses) and its counters; the 12th
// and 13th after the name are its CPU time, the 22nd its memory in pages.
export const PROCESSES_SCRIPT = [
  String.raw`snap() { for stat in /proc/[0-9]*/stat; do IFS= read -r line < "$stat" && printf '%s\n' "$line"; done 2>/dev/null; }`,
  String.raw`total() { read -r _ a b c d e f g h _ < /proc/stat; echo $((a + b + c + d + e + f + g + h)); }`,
  String.raw`before=$(total); first=$(snap); sleep 1; after=$(total); second=$(snap)`,
  String.raw`printf 'total %s\npage %s\n' "$((after - before))" "$(getconf PAGESIZE 2>/dev/null || echo 4096)"`,
  String.raw`{ printf '%s\n' "$first"; echo ---; printf '%s\n' "$second"; } | awk '`,
  String.raw`/^---$/ { second = 1; next }`,
  String.raw`{`,
  String.raw`  left = index($0, "("); right = 0; rest = $0`,
  String.raw`  while ((at = index(rest, ") ")) > 0) { right += at + 1; rest = substr(rest, at + 2) }`,
  String.raw`  if (!left || !right) next`,
  String.raw`  pid = substr($0, 1, left - 2); split(rest, field, " ")`,
  String.raw`  ticks = field[12] + field[13]`,
  String.raw`  if (!second) { earlier[pid] = ticks; next }`,
  String.raw`  printf "process %s %d %d %s\n", pid, (pid in earlier) ? ticks - earlier[pid] : ticks, field[22], substr($0, left + 1, right - left - 2)`,
  String.raw`}'`,
].join("\n");
export type Process = { pid: number; name: string; cpuPercent: number; memoryBytes: number };
const PROCESSES_SHOWN = 8;
// The processes worth showing: those that use the most CPU and those that hold
// the most memory, the busiest first.
export function processesFromOutput(output: string): Process[] {
  let total = 0, page = 4096;
  const all: Process[] = [];
  for (const line of output.split("\n")) {
    const [kind, ...values] = line.split(" ");
    if (kind === "total") total = Number(values[0]) || 0;
    else if (kind === "page") page = Number(values[0]) || 4096;
    else if (kind === "process" && values.length >= 4) {
      const ticks = Math.max(0, Number(values[1]) || 0);
      all.push({ pid: Number(values[0]), name: values.slice(3).join(" "), cpuPercent: total > 0 ? Math.round(1000 * ticks / total) / 10 : 0, memoryBytes: (Number(values[2]) || 0) * page });
    }
  }
  const busiest = [...all].sort((a, b) => b.cpuPercent - a.cpuPercent).filter((process) => process.cpuPercent > 0).slice(0, PROCESSES_SHOWN);
  const largest = [...all].sort((a, b) => b.memoryBytes - a.memoryBytes).filter((process) => process.memoryBytes > 0).slice(0, PROCESSES_SHOWN);
  return [...new Set([...busiest, ...largest])].sort((a, b) => b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes);
}
export async function topProcesses() {
  return { processes: processesFromOutput(await runAsync(["bash", "-c", PROCESSES_SCRIPT, "processes"], 20000)), at: Date.now() };
}

// Updates are counted from what the server's package manager already knows:
// apt from the package lists the system refreshes itself, the others by asking
// their mirrors, within a time limit. The count is empty where it is not
// known. A restart is known to be needed, or not, only where the system says:
// Debian and Ubuntu leave a file, Fedora and its relatives have a command, and
// Arch removes the modules of the kernel that still runs.
const SYSTEM_SCRIPT = [
  String.raw`limited() { if command -v timeout >/dev/null 2>&1; then timeout 45 "$@"; else "$@"; fi; }`,
  String.raw`printf 'os=%s\nkernel=%s\n' "$( . /etc/os-release 2>/dev/null; printf %s "$PRETTY_NAME" )" "$(uname -r)"`,
  String.raw`manager= updates= security=`,
  String.raw`if command -v apt-get >/dev/null 2>&1; then`,
  String.raw`  manager=apt`,
  String.raw`  if list=$(LC_ALL=C apt-get -s -o Debug::NoLocking=true dist-upgrade 2>/dev/null); then`,
  String.raw`    updates=$(printf '%s\n' "$list" | grep -c '^Inst ')`,
  String.raw`    security=$(printf '%s\n' "$list" | grep '^Inst ' | grep -ci security)`,
  String.raw`  fi`,
  String.raw`elif command -v dnf >/dev/null 2>&1; then`,
  String.raw`  manager=dnf`,
  String.raw`  list=$(LC_ALL=C limited dnf -q check-update 2>/dev/null); code=$?`,
  String.raw`  if [ "$code" = 0 ]; then updates=0`,
  String.raw`  elif [ "$code" = 100 ]; then updates=$(printf '%s\n' "$list" | awk 'NF == 0 { if (seen) exit; next } NF >= 3 { seen = 1; count++ } END { print count + 0 }'); fi`,
  String.raw`elif command -v checkupdates >/dev/null 2>&1; then`,
  String.raw`  manager=pacman`,
  String.raw`  list=$(limited checkupdates 2>/dev/null); code=$?`,
  String.raw`  if [ "$code" = 0 ]; then updates=$(printf '%s\n' "$list" | grep -c .); elif [ "$code" = 2 ]; then updates=0; fi`,
  String.raw`elif command -v pacman >/dev/null 2>&1; then`,
  String.raw`  manager=pacman`,
  String.raw`  updates=$(pacman -Qu 2>/dev/null | grep -c .)`,
  String.raw`elif command -v zypper >/dev/null 2>&1; then`,
  String.raw`  manager=zypper`,
  String.raw`  if list=$(LC_ALL=C limited zypper -n -q list-updates 2>/dev/null); then updates=$(printf '%s\n' "$list" | grep -c '^v '); fi`,
  String.raw`fi`,
  String.raw`restart=`,
  String.raw`if [ -e /var/run/reboot-required ]; then restart=yes`,
  String.raw`elif [ "$manager" = apt ]; then { [ -e /etc/kernel/postinst.d/unattended-upgrades ] || [ -e /usr/share/update-notifier/notify-reboot-required ]; } && restart=no`,
  String.raw`elif command -v needs-restarting >/dev/null 2>&1; then limited needs-restarting -r >/dev/null 2>&1; case $? in 0) restart=no ;; 1) restart=yes ;; esac`,
  String.raw`elif [ "$manager" = pacman ] && [ -d /usr/lib/modules ]; then if [ -d "/usr/lib/modules/$(uname -r)" ]; then restart=no; else restart=yes; fi`,
  String.raw`fi`,
  String.raw`printf 'manager=%s\nupdates=%s\nsecurity=%s\nrestart=%s\n' "$manager" "$updates" "$security" "$restart"`,
  String.raw`if command -v systemctl >/dev/null 2>&1 && units=$(systemctl list-units --state=failed --no-legend --plain --no-pager 2>/dev/null); then`,
  String.raw`  echo units=read`,
  String.raw`  printf '%s\n' "$units" | awk 'NF { print "unit=" $1 }'`,
  String.raw`fi`,
].join("\n");
export type SystemReport = {
  os: string; kernel: string;
  // The package manager the updates were counted with; empty when none is known.
  manager: string;
  updates: number | null; security: number | null;
  restartNeeded: boolean | null;
  // The services that failed; null on a server without systemd.
  failedUnits: string[] | null;
  at: number;
};
export function systemFromOutput(output: string, at = Date.now()): SystemReport {
  const values = new Map<string, string>(), units: string[] = [];
  for (const line of output.split("\n")) {
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    const key = line.slice(0, equals), value = line.slice(equals + 1).trim();
    if (key === "unit") units.push(value);
    else values.set(key, value);
  }
  const count = (key: string) => (/^\d+$/.test(values.get(key) ?? "") ? Number(values.get(key)) : null);
  const restart = values.get("restart");
  return {
    os: values.get("os") ?? "", kernel: values.get("kernel") ?? "", manager: values.get("manager") ?? "",
    updates: count("updates"), security: values.get("manager") === "apt" ? count("security") : null,
    restartNeeded: restart === "yes" ? true : restart === "no" ? false : null,
    failedUnits: values.get("units") === "read" ? units : null, at,
  };
}
// A report is used for 15 minutes and belongs to one server. On globalThis,
// like the other readings the API's copies of this module share.
const REPORT_FRESH_MS = 15 * 60 * 1000;
const kept = globalThis as { lscSystem?: { target: string; report: SystemReport }; lscSystemPending?: Promise<SystemReport> };
export function systemReport(fresh = false): Promise<SystemReport> {
  const target = serverSettings().sshTarget, last = kept.lscSystem;
  if (!fresh && last && last.target === target && Date.now() - last.report.at < REPORT_FRESH_MS) return Promise.resolve(last.report);
  kept.lscSystemPending ??= runAsync(["sh", "-c", SYSTEM_SCRIPT, "system"], 120000)
    .then((output) => {
      const report = systemFromOutput(output);
      kept.lscSystem = { target, report };
      return report;
    })
    .finally(() => { kept.lscSystemPending = undefined; });
  return kept.lscSystemPending;
}
