// Disk health: the SMART state of the server's disks, as udisks keeps it.
// udisks reads SMART for ATA and NVMe disks every 10 minutes, leaves a disk
// that sleeps asleep, and lets any user read what it found, so the dashboard
// needs neither root nor smartctl: one host command, `udisksctl dump`. It is
// installed on Ubuntu, Debian, Fedora, openSUSE and Arch desktops, and on
// servers as the udisks2 package.
import { audit, emitDashboardEvent, read, save } from "./store";
import { CommandError, runAsync, serverSettings } from "./ssh";
import { msg, t, tn } from "../i18n";

// A problem as the server records it, put into words when it is shown.
export type DiskProblem = { text: string; count?: number };
export type DiskStatus = "ok" | "attention" | "failing" | "unknown";
export type DiskHealth = {
  id: string; device: string; model: string; serial: string; sizeBytes: number;
  kind: "ata" | "nvme"; rotational: boolean; status: DiskStatus;
  temperatureC: number | null; powerOnHours: number | null; problems: DiskProblem[];
  // When udisks last read the disk's SMART data, in milliseconds.
  updatedAt: number | null;
};
export type DiskReading = { available: boolean; reason?: "missing" | "failed"; error?: string; disks: DiskHealth[]; at: number };

const PROBLEMS = {
  failing: msg("The disk reports that it is about to fail"),
  selftest: msg("The last self-test failed"),
  spare: msg("Little spare capacity is left"),
  temperature: msg("Its temperature is outside its limits"),
  degraded: msg("Its reliability is degraded"),
  readonly: msg("It has become read-only"),
  volatile: msg("The backup of its volatile memory failed"),
};
// A problem in the language of the request or of the notification.
export function describeProblem(problem: DiskProblem) {
  const count = problem.count ?? 0;
  if (problem.text === "attributes") return tn("{count} SMART attribute below its threshold|{count} SMART attributes below their threshold", count);
  if (problem.text === "sectors") return tn("{count} bad sector|{count} bad sectors", count);
  if (problem.text === "failedBefore") return tn("{count} SMART attribute failed in the past|{count} SMART attributes failed in the past", count);
  return t(PROBLEMS[problem.text as keyof typeof PROBLEMS] ?? problem.text);
}

// `udisksctl dump` prints each object's path, its interfaces indented by two
// spaces and their properties by four; a list continues on lines of its own.
type Objects = Map<string, Map<string, Record<string, string>>>;
export function parseUdisksDump(output: string): Objects {
  const objects: Objects = new Map();
  let object: Map<string, Record<string, string>> | undefined, properties: Record<string, string> | undefined, key = "";
  for (const line of output.split("\n")) {
    const path = /^(\/org\/freedesktop\/UDisks2\/\S+):$/.exec(line);
    if (path) {
      object = new Map();
      objects.set(path[1], object);
      properties = undefined;
      continue;
    }
    const face = /^ {2}(org\.freedesktop\.UDisks2\.[\w.]+):$/.exec(line);
    if (face && object) {
      properties = {};
      object.set(face[1], properties);
      continue;
    }
    const property = /^ {4}(\w+):\s*(.*)$/.exec(line);
    if (property && properties) {
      key = property[1];
      properties[key] = property[2].trim();
    } else if (properties && key && /^ {5,}\S/.test(line)) properties[key] += "\n" + line.trim();
  }
  return objects;
}

const number = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
// udisks gives temperatures in kelvin, and 0 when it has none.
const celsius = (kelvin: string | undefined) => {
  const value = number(kelvin);
  return value > 0 ? Math.round(value - 273.15) : null;
};
const unquote = (value = "") => value.replace(/^'(.*)'$/, "$1");
// Self-test results that mean the disk found a fault, for ATA and NVMe disks.
const FAILED_SELFTEST = /^(fatal|error_\w+|known_seg_fail|unknown_seg_fail|.*fail.*)$/;
// NVMe critical warnings: those that mean the disk is failing, and the others.
const NVME_FAILING: Record<string, keyof typeof PROBLEMS> = { degraded: "degraded", readonly: "readonly", volatile_mem: "volatile", pmr_readonly: "readonly" };
const NVME_ATTENTION: Record<string, keyof typeof PROBLEMS> = { spare: "spare", temperature: "temperature" };

export function disksFromDump(output: string): DiskHealth[] {
  const objects = parseUdisksDump(output);
  // The whole disk of each drive: a block device that is no partition.
  const devices = new Map<string, string>();
  for (const [, object] of objects) {
    const block = object.get("org.freedesktop.UDisks2.Block");
    if (!block || object.has("org.freedesktop.UDisks2.Partition")) continue;
    const drive = unquote(block.Drive);
    if (drive && drive !== "/" && !devices.has(drive)) devices.set(drive, block.Device || block.PreferredDevice || "");
  }
  const disks: DiskHealth[] = [];
  for (const [path, object] of objects) {
    const drive = object.get("org.freedesktop.UDisks2.Drive");
    const ata = object.get("org.freedesktop.UDisks2.Drive.Ata");
    const nvme = object.get("org.freedesktop.UDisks2.NVMe.Controller");
    // Optical drives and USB adapters without SMART have no health to show.
    if (!drive || !(nvme || (ata && ata.SmartSupported === "true"))) continue;
    const problems: DiskProblem[] = [];
    let status: DiskStatus = "ok";
    const attention = (problem: DiskProblem) => { problems.push(problem); if (status === "ok") status = "attention"; };
    const failing = (problem: DiskProblem) => { problems.unshift(problem); status = "failing"; };
    let updated = 0, temperatureC: number | null = null, powerOnHours: number | null = null, selftest = "";
    if (ata) {
      updated = number(ata.SmartUpdated);
      temperatureC = celsius(ata.SmartTemperature);
      powerOnHours = ata.SmartPowerOnSeconds ? Math.round(number(ata.SmartPowerOnSeconds) / 3600) : null;
      selftest = ata.SmartSelftestStatus || "";
      if (ata.SmartFailing === "true") failing({ text: "failing" });
      if (number(ata.SmartNumAttributesFailing) > 0) attention({ text: "attributes", count: number(ata.SmartNumAttributesFailing) });
      if (number(ata.SmartNumBadSectors) > 0) attention({ text: "sectors", count: number(ata.SmartNumBadSectors) });
      if (number(ata.SmartNumAttributesFailedInThePast) > 0) attention({ text: "failedBefore", count: number(ata.SmartNumAttributesFailedInThePast) });
    } else if (nvme) {
      updated = number(nvme.SmartUpdated);
      temperatureC = celsius(nvme.SmartTemperature);
      powerOnHours = nvme.SmartPowerOnHours ? number(nvme.SmartPowerOnHours) : null;
      selftest = nvme.SmartSelftestStatus || "";
      for (const warning of (nvme.SmartCriticalWarning || "").match(/[a-z_]+/g) ?? []) {
        if (warning in NVME_FAILING) failing({ text: NVME_FAILING[warning] });
        else if (warning in NVME_ATTENTION) attention({ text: NVME_ATTENTION[warning] });
      }
    }
    if (FAILED_SELFTEST.test(selftest)) attention({ text: "selftest" });
    // Not read yet, or SMART is turned off: nothing is known.
    if (!updated && status === "ok") status = "unknown";
    disks.push({
      id: drive.Id || path.split("/").pop() || path, device: devices.get(path) || "",
      model: [drive.Vendor, drive.Model].filter(Boolean).join(" ") || drive.Id || "", serial: drive.Serial || "",
      sizeBytes: number(drive.Size), kind: nvme ? "nvme" : "ata", rotational: number(drive.RotationRate) !== 0,
      status, temperatureC, powerOnHours: powerOnHours || null, problems, updatedAt: updated ? updated * 1000 : null,
    });
  }
  return disks.sort((a, b) => a.device.localeCompare(b.device));
}

// The script tells a missing udisksctl from one that cannot reach udisks.
const DISKS_SCRIPT = 'command -v udisksctl >/dev/null 2>&1 || { echo "udisksctl: not found" >&2; exit 127; }; exec udisksctl dump';
// A reading is used for 5 minutes, as long as the background monitor waits
// between two, and belongs to one server. On globalThis, so the API and the
// background monitor, which Next.js loads apart, share it.
const READING_FRESH_MS = 5 * 60 * 1000;
const kept = globalThis as { lscDisks?: { target: string; reading: DiskReading }; lscDisksPending?: Promise<DiskReading> };
export function diskHealth(fresh = false): Promise<DiskReading> {
  const target = serverSettings().sshTarget;
  const last = kept.lscDisks;
  if (!fresh && last && last.target === target && Date.now() - last.reading.at < READING_FRESH_MS) return Promise.resolve(last.reading);
  kept.lscDisksPending ??= readDisks(target).finally(() => { kept.lscDisksPending = undefined; });
  return kept.lscDisksPending;
}
async function readDisks(target: string): Promise<DiskReading> {
  let reading: DiskReading;
  try {
    reading = { available: true, disks: disksFromDump(await runAsync(["sh", "-c", DISKS_SCRIPT, "disks"], 20000)), at: Date.now() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const missing = error instanceof CommandError && message === "udisksctl: not found";
    reading = { available: false, reason: missing ? "missing" : "failed", ...(missing ? {} : { error: message }), disks: [], at: Date.now() };
  }
  kept.lscDisks = { target, reading };
  return reading;
}
// The hottest disk at the last reading, for the alert rules; 0 when none is known.
export function hottestDisk() {
  const last = kept.lscDisks;
  if (!last || last.target !== serverSettings().sshTarget) return 0;
  return Math.max(0, ...last.reading.disks.map((disk) => disk.temperatureC ?? 0));
}

// Announces a disk that starts to report a problem, a worse one, or none any
// more. What each disk reported last is kept in DATA_DIR, so a restart neither
// repeats an announcement nor misses that a disk recovered. A disk first seen
// with a problem is announced too.
const SEVERITY: Record<DiskStatus, number> = { unknown: -1, ok: 0, attention: 1, failing: 2 };
export async function checkDisks() {
  const reading = await diskHealth(true);
  if (!reading.available) return reading;
  const known = read<Record<string, DiskStatus>>("disk-health", {});
  const next: Record<string, DiskStatus> = { ...known };
  for (const disk of reading.disks) {
    // A disk whose SMART data is not known keeps what it last reported.
    if (disk.status === "unknown") continue;
    const before = known[disk.id];
    next[disk.id] = disk.status;
    const name = `${disk.model} (${disk.device || disk.id})`;
    if (SEVERITY[disk.status] > SEVERITY[before ?? "ok"]) {
      audit(`disk ${disk.device || disk.id}: ${disk.status}`);
      emitDashboardEvent(() => ({
        type: "disk-health", severity: disk.status === "failing" ? "critical" : "warning",
        title: t("Disk problem: {name}", { name }),
        message: disk.problems.map(describeProblem).join("; ") + ".",
      }));
    } else if (disk.status === "ok" && before && before !== "ok") {
      audit(`disk ${disk.device || disk.id}: ok`);
      emitDashboardEvent(() => ({ type: "disk-health", severity: "success", title: t("Disk healthy again: {name}", { name }), message: t("It no longer reports a problem.") }));
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(known)) save("disk-health", next);
  return reading;
}
