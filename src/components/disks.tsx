"use client";
import { useCallback, useEffect, useState } from "react";
import { HardDrive, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/client-api";
import { Btn, PAGE_REFRESH, Panel, formatBytes } from "@/components/ui";
import { locale, t, tn } from "@/lib/i18n";
import type { Disk, DiskReport } from "@/lib/types";

// The server reads the disks every 5 minutes; an open page asks as often.
const DISKS_REFRESH_MS = 5 * 60 * 1000;
// The disks' health, read when the page opens, every 5 minutes while it is
// shown, and again from the server on Refresh or "Check now".
export function useDisks() {
  const [report, setReport] = useState<DiskReport | null>(null);
  const [checking, setChecking] = useState(false);
  const load = useCallback(async (fresh = false) => {
    if (fresh) setChecking(true);
    try {
      setReport(await api(fresh ? "disks?fresh=true" : "disks", undefined, true));
    } catch {
      // The rest of Overview stays usable; the panel says nothing is known.
    } finally {
      if (fresh) setChecking(false);
    }
  }, []);
  useEffect(() => {
    // The rule cannot see that load only sets state after awaiting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, DISKS_REFRESH_MS);
    const refresh = () => void load(true);
    window.addEventListener(PAGE_REFRESH, refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener(PAGE_REFRESH, refresh);
    };
  }, [load]);
  return { report, checking, check: () => load(true) };
}
export const diskName = (disk: Disk) => `${disk.model}${disk.device ? ` (${disk.device})` : ""}`;
const BADGE: Record<Disk["status"], string> = { ok: "up", attention: "down", failing: "down", unknown: "neutral" };
function statusLabel(status: Disk["status"]) {
  // Each text literally, so that it is listed for translation.
  return status === "ok" ? t("Healthy") : status === "attention" ? t("Needs attention") : status === "failing" ? t("Failing") : t("Not read yet");
}
export function DisksPanel({ report, checking, check }: ReturnType<typeof useDisks>) {
  const action = (
    <Btn disabled={checking || !report} onClick={check}>
      {checking ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
      <span className="button-label">{t("Check now")}</span>
    </Btn>
  );
  return (
    <Panel title={t("Disks")} note={t("The SMART health of the server's disks, as udisks reads it every 10 minutes.")} extra={action}>
      {!report && <div className="empty-state" role="status"><Loader2 className="spin" size={22} /></div>}
      {report && !report.available && (
        <div className="empty-state">
          <HardDrive size={22} />
          <b>{report.reason === "missing" ? t("udisks is not installed on the server") : t("Disk health cannot be read: {error}", { error: report.error || t("unknown error") })}</b>
          <p>{report.reason === "missing" ? t("Install the udisks2 package on the server (apt, dnf, zypper or pacman) to see the disks' health here.") : t("Check that the udisks2 service is running on the server.")}</p>
        </div>
      )}
      {report?.available && !report.disks.length && (
        <div className="empty-state"><HardDrive size={22} /><b>{t("No disks report SMART data")}</b></div>
      )}
      {report?.disks.map((disk) => (
        <div className="schedule-row disk-row" key={disk.id}>
          <div className="service-icon"><HardDrive size={19} /></div>
          <div className="grow">
            <b>{disk.model}</b>
            <small>
              {[disk.device, formatBytes(disk.sizeBytes), disk.kind === "nvme" ? "NVMe" : disk.rotational ? "HDD" : "SSD",
                disk.temperatureC !== null ? `${disk.temperatureC.toLocaleString(locale())} °C` : "",
                disk.powerOnHours !== null ? tn("{count} hour powered on|{count} hours powered on", disk.powerOnHours) : ""].filter(Boolean).join(" · ")}
            </small>
            {disk.problems.length > 0 && <small className="disk-problems">{disk.problems.join(" · ")}</small>}
          </div>
          <div className="row-side">
            <span className={`badge ${BADGE[disk.status]}`} title={disk.updatedAt ? t("Read {time}", { time: new Date(disk.updatedAt).toLocaleString(locale()) }) : undefined}>
              {statusLabel(disk.status)}
            </span>
          </div>
        </div>
      ))}
    </Panel>
  );
}
