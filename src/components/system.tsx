"use client";
import { useCallback, useEffect, useState } from "react";
import { Activity, Loader2, Package, Power, RefreshCw, Wrench } from "lucide-react";
import { api } from "@/lib/client-api";
import { Btn, PAGE_REFRESH, Panel, formatBytes } from "@/components/ui";
import { locale, t } from "@/lib/i18n";
import type { Process, SystemReport } from "@/lib/types";

// Something Overview reads apart from the page's refresh: when the page opens
// (what the dashboard read last, if recent), and again from the server on
// Refresh or "Check now".
function useReading<T>(path: string, fresh: string) {
  const [reading, setReading] = useState<T | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async (again = false) => {
    if (again) setChecking(true);
    try {
      setReading(await api(again ? fresh : path, undefined, true));
      setFailed(false);
    } catch {
      // The rest of Overview stays usable; the panel says nothing is known.
      setFailed(true);
    } finally {
      if (again) setChecking(false);
    }
  }, [path, fresh]);
  useEffect(() => {
    // The rule cannot see that load only sets state after awaiting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const refresh = () => void load(true);
    window.addEventListener(PAGE_REFRESH, refresh);
    return () => window.removeEventListener(PAGE_REFRESH, refresh);
  }, [load]);
  return { reading, checking, failed, check: () => load(true) };
}
const CheckNow = ({ checking, disabled, check }: { checking: boolean; disabled: boolean; check: () => void }) => (
  <Btn disabled={checking || disabled} onClick={check}>
    {checking ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
    <span className="button-label">{t("Check now")}</span>
  </Btn>
);

// What the server waits for: updates, a restart, failed services.
export const useSystem = () => useReading<SystemReport>("system", "system?fresh=true");
export function SystemPanel({ reading: report, checking, failed, check }: ReturnType<typeof useSystem>) {
  return (
    <Panel title={t("System")} note={t("Package updates, a pending restart and failed services, as the server reports them.")} extra={<CheckNow checking={checking} disabled={!report && !failed} check={check} />}>
      {!report && !failed && <div className="empty-state" role="status"><Loader2 className="spin" size={22} /></div>}
      {!report && failed && <div className="empty-state"><Wrench size={22} /><b>{t("The system's state cannot be read")}</b></div>}
      {report && <>
        <div className="schedule-row">
          <div className="service-icon"><Package size={19} /></div>
          <div className="grow">
            <b>{report.updates === null ? t("The number of updates is not known") : report.updates === 0 ? t("The system is up to date") : t("Packages that can be updated: {count}", { count: report.updates.toLocaleString(locale()) })}</b>
            <small>
              {[report.security ? t("of which security updates: {count}", { count: report.security.toLocaleString(locale()) }) : "", report.os, report.kernel ? t("kernel {version}", { version: report.kernel }) : ""].filter(Boolean).join(" · ")}
            </small>
          </div>
          {report.updates !== null && <div className="row-side"><span className={`badge ${report.security ? "down" : report.updates ? "neutral" : "up"}`}>{report.updates ? t("Updates") : t("Up to date")}</span></div>}
        </div>
        <div className="schedule-row">
          <div className="service-icon"><Power size={19} /></div>
          <div className="grow">
            <b>{report.restartNeeded === null ? t("Whether a restart is needed is not known") : report.restartNeeded ? t("The server needs a restart") : t("No restart is needed")}</b>
            {report.restartNeeded && <small>{t("An updated kernel or system library is used only after a restart.")}</small>}
          </div>
          {report.restartNeeded !== null && <div className="row-side"><span className={`badge ${report.restartNeeded ? "down" : "up"}`}>{report.restartNeeded ? t("Restart needed") : t("No restart")}</span></div>}
        </div>
        <div className="schedule-row">
          <div className="service-icon"><Wrench size={19} /></div>
          <div className="grow">
            <b>{report.failedUnits === null ? t("Services are not known: the server has no systemd") : report.failedUnits.length ? t("Failed services: {count}", { count: report.failedUnits.length.toLocaleString(locale()) }) : t("No service has failed")}</b>
            {!!report.failedUnits?.length && <small className="disk-problems" dir="ltr">{report.failedUnits.join(" · ")}</small>}
          </div>
          {report.failedUnits !== null && <div className="row-side"><span className={`badge ${report.failedUnits.length ? "down" : "up"}`}>{report.failedUnits.length ? t("Failed") : t("Healthy")}</span></div>}
        </div>
      </>}
    </Panel>
  );
}

// The processes that use the most CPU and memory.
export const useProcesses = () => useReading<{ processes: Process[]; at: number }>("processes", "processes");
export function ProcessesPanel({ reading, checking, failed, check }: ReturnType<typeof useProcesses>) {
  return (
    <Panel title={t("Processes")} note={t("What uses the most CPU and memory now, measured over one second. CPU is the share of all cores.")} extra={<CheckNow checking={checking} disabled={!reading && !failed} check={check} />}>
      {!reading && !failed && <div className="empty-state" role="status"><Loader2 className="spin" size={22} /></div>}
      {!reading && failed && <div className="empty-state"><Activity size={22} /><b>{t("The processes cannot be read")}</b></div>}
      {reading && !reading.processes.length && <div className="empty-state"><Activity size={22} /><b>{t("No process is using the CPU")}</b></div>}
      {reading?.processes.map((process) => (
        <div className="schedule-row process-row" key={process.pid}>
          <div className="grow">
            <b dir="ltr">{process.name}</b>
            <small>PID {process.pid}</small>
          </div>
          <div className="row-side process-use" dir="ltr">
            <span>CPU {process.cpuPercent.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</span>
            <span>RAM {formatBytes(process.memoryBytes)}</span>
          </div>
        </div>
      ))}
    </Panel>
  );
}
