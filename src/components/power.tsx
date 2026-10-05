"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Gauge, Pencil, Plug, Plus, Power, Trash2, Wallet, Zap } from "lucide-react";
import { api } from "@/lib/client-api";
import { ChartFrame, ColumnChart, LineChart, RangeFilter, formatTime, type Range } from "@/components/charts";
import { appConfirm, Btn, Metric, Modal, ModalActions, Panel, RowMenu } from "@/components/ui";
import { language, locale, t } from "@/lib/i18n";

type Field = { key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string; help?: string };
type Driver = { id: string; name: string; description: string; fields: Field[] };
type Device = {
  id: string; name: string; driver: string; enabled: boolean; config: Record<string, string>; canSwitch?: boolean;
  status: { at: number | null; powerW: number | null; on: boolean | null; error: string | null } | null;
};
type Settings = { pricePerKwh: number; currency: string };
type History = {
  from: number; to: number;
  devices: { id: string; name: string }[];
  power: { id: string; points: { at: number; w: number }[] }[];
  energy: { id: string; hours: { at: number; wh: number }[] }[];
  settings: Settings;
};
const HOUR = 3600000;
// A reading older than this no longer counts as the current power.
const STALE_MS = 5 * 60000;

const clock = { format: (at: number) => new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" }).format(at) };
const kwh = (wh: number) => wh / 1000;
const fixed = (value: number, digits: number) => value.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
const formatWatts = (w: number) => (w >= 1000 ? `${fixed(w / 1000, 2)} kW` : `${fixed(w, w < 10 ? 1 : 0)} W`);
const startOfDay = (at: number) => { const date = new Date(at); date.setHours(0, 0, 0, 0); return date.getTime(); };
const startOfMonth = (at: number) => { const date = new Date(startOfDay(at)); date.setDate(1); return date.getTime(); };

// compact: the Overview version, with the tiles and charts only, following the
// caller's range, and nothing at all until a device exists.
export function PowerPage({ range: controlled, compact = false, readOnly = false }: { range?: Range; compact?: boolean; readOnly?: boolean } = {}) {
  const [own, setRange] = useState<Range>("24h");
  const range = controlled ?? own;
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [settings, setSettings] = useState<Settings>({ pricePerKwh: 0, currency: "lei" });
  const [history, setHistory] = useState<History | null>(null);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [editing, setEditing] = useState<Device | null | undefined>();
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState("");
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    api("power/drivers", undefined, true).then((data) => setDrivers(data.drivers)).catch(() => {});
  }, []);
  useEffect(() => {
    let current = true;
    const load = () => Promise.all([api("power/devices", undefined, true), api(`power/history?range=${range}`, undefined, true)])
      .then(([list, data]) => {
        if (!current) return;
        setDevices(list.devices); setSettings(list.settings); setHistory(data); setError("");
      })
      .catch((reason) => { if (current) setError(reason instanceof Error ? reason.message : t("Could not load power data")); });
    void load();
    // Plugs are read every minute on the server; follow along while the page is open.
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 60000);
    return () => { current = false; clearInterval(timer); };
  }, [range, version]);

  const now = history?.to ?? 0;
  const hours = useMemo(() => history?.energy.flatMap((item) => item.hours) ?? [], [history]);
  const sumSince = (from: number) => hours.filter((hour) => hour.at >= from).reduce((sum, hour) => sum + hour.wh, 0);
  const live = (devices ?? []).filter((device) => device.enabled && device.status?.at && now - device.status.at < STALE_MS && device.status.powerW !== null);
  const powerNow = live.reduce((sum, device) => sum + (device.status!.powerW || 0), 0);
  const todayWh = sumSince(startOfDay(now));
  const monthWh = sumSince(startOfMonth(now));
  const cost = kwh(monthWh) * settings.pricePerKwh;

  // Power chart: one series per device on the union of their timestamps.
  const powerChart = useMemo(() => {
    if (!history) return { times: [] as number[], series: [] };
    const times = [...new Set(history.power.flatMap((item) => item.points.map((point) => point.at)))].sort((a, b) => a - b);
    const series = history.devices.map((device) => {
      const points = new Map(history.power.find((item) => item.id === device.id)?.points.map((point) => [point.at, point.w]));
      return { id: device.id, label: device.name, values: times.map((at) => points.get(at) ?? null) };
    });
    return { times, series };
  }, [history]);
  const shown = language();

  // Energy chart: hourly columns for a day, daily columns for longer ranges.
  const energyChart = useMemo(() => {
    if (!history) return { labels: [] as string[], starts: [] as number[], series: [] };
    const hourly = range === "24h";
    const count = hourly ? 24 : range === "7d" ? 7 : 30;
    const starts = Array.from({ length: count }, (_, index) => {
      if (hourly) return Math.floor(now / HOUR) * HOUR - (count - 1 - index) * HOUR;
      const date = new Date(startOfDay(now));
      date.setDate(date.getDate() - (count - 1 - index));
      return date.getTime();
    });
    const slot = (at: number) => {
      for (let index = starts.length - 1; index >= 0; index--) if (at >= starts[index]) return index;
      return -1;
    };
    const series = history.devices.map((device) => {
      const values = Array(count).fill(0);
      for (const hour of history.energy.find((item) => item.id === device.id)?.hours ?? []) {
        const index = slot(hour.at);
        if (index >= 0) values[index] += kwh(hour.wh);
      }
      return { id: device.id, label: device.name, values };
    });
    const labels = starts.map((at) => formatTime(at, hourly ? 0 : Infinity));
    return { labels, starts, series };
    // Its labels are dates in the chosen language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, range, now, shown]);

  const span = (history?.to ?? 0) - (history?.from ?? 0);
  const noDevices = devices !== null && devices.length === 0;
  if (compact && (devices === null || noDevices)) return null;
  return <>
    <section className="metrics">
      <Metric label={t("Power now")} value={live.length ? formatWatts(powerNow) : "—"} note={t("{count} of {total} devices reporting", { count: live.length, total: devices?.filter((device) => device.enabled).length ?? 0 })} icon={<Zap />} />
      <Metric label={t("Today")} value={`${fixed(kwh(todayWh), 2)} kWh`} note={t("Since midnight")} icon={<Gauge />} />
      <Metric label={t("This month")} value={`${fixed(kwh(monthWh), 1)} kWh`} note={now ? new Date(now).toLocaleDateString(locale(), { month: "long", year: "numeric" }) : ""} icon={<Plug />} />
      <Metric label={t("Cost this month")} value={settings.pricePerKwh ? `${fixed(cost, 2)} ${settings.currency}` : "—"} note={settings.pricePerKwh ? `${settings.pricePerKwh.toLocaleString(locale())} ${settings.currency}/kWh` : compact ? t("Set a price on the Power page") : t("Set a price below")} icon={<Wallet />} />
    </section>
    {error && <div className="alert">{error}</div>}
    {!noDevices && <>
      {!controlled && <RangeFilter value={range} onChange={setRange} />}
      <div className="chart-grid-2" style={{ opacity: history ? 1 : 0.6 }}>
        <ChartFrame
          title={t("Power")}
          note={range === "24h" ? t("Watts, one reading per minute") : t("Watts, hourly average")}
          table={{ columns: [t("Time"), ...powerChart.series.map((item) => `${item.label} (W)`)], rows: () => powerChart.times.map((at, index) => [formatTime(at, span) + (span > 36 * HOUR ? " " + clock.format(at) : ""), ...powerChart.series.map((item) => item.values[index] === null ? "—" : item.values[index]!.toFixed(1))]) }}
        >
          <LineChart times={powerChart.times} series={powerChart.series} unit="W" digits={1} empty={t("No readings in this range yet. Devices are read every minute.")} />
        </ChartFrame>
        <ChartFrame
          title={t("Energy")}
          note={range === "24h" ? t("kWh per hour") : t("kWh per day")}
          table={{ columns: [range === "24h" ? t("Hour") : t("Day"), ...energyChart.series.map((item) => `${item.label} (kWh)`), t("Total (kWh)")], rows: () => energyChart.labels.map((label, index) => [label, ...energyChart.series.map((item) => item.values[index].toFixed(3)), energyChart.series.reduce((sum, item) => sum + item.values[index], 0).toFixed(3)]) }}
        >
          <ColumnChart labels={energyChart.labels} series={energyChart.series} unit="kWh" digits={range === "24h" ? 3 : 2} />
        </ChartFrame>
      </div>
    </>}
    {!compact && <Panel title={t("Devices")} note={t("Smart plugs and energy meters, read every minute on the server.")} extra={readOnly ? undefined : <Btn className="primary" onClick={() => setEditing(null)}><Plus size={16} />{t("Add device")}</Btn>}>
      {noDevices && <div className="empty-state"><Plug size={22} /><b>{t("No devices yet")}</b><p>{readOnly ? t("An administrator can add smart plugs and energy meters.") : t("Add a Tapo, Shelly, Tasmota or Home Assistant device to start recording power.")}</p></div>}
      {devices?.map((device) => {
        const driver = drivers.find((item) => item.id === device.driver);
        const status = device.status;
        const fresh = status?.at && now - status.at < STALE_MS;
        return <div className="schedule-row" key={device.id}>
          <span className="service-icon"><Plug size={18} /></span>
          <div className="grow">
            <b>{device.name}</b>
            <small>{driver?.name ?? device.driver}{status?.error ? ` · ${status.error}` : status?.at ? ` · ${t("last reading {time}", { time: new Date(status.at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) })}` : ""}</small>
          </div>
          <div className="row-side">
            {switching === device.id ? <span className="badge root">{t("Switching…")}</span>
              : !device.enabled ? <span className="badge neutral">{t("Paused")}</span>
              : status?.error ? <span className="badge down">{t("Unreachable")}</span>
              : fresh && status?.powerW !== null ? <span className="badge up">{formatWatts(status!.powerW!)}{status?.on === false ? ` · ${t("off")}` : ""}</span>
              : <span className="badge root">{t("Waiting")}</span>}
          </div>
          {!readOnly && <RowMenu label={t("Actions for {name}", { name: device.name })} disabled={switching === device.id} items={[
            // Only offered while the relay's state is known, so the item says what it will do.
            device.canSwitch && device.enabled && typeof status?.on === "boolean" && !status.error && {
              label: status.on ? t("Turn off") : t("Turn on"), icon: <Power size={15} />,
              onSelect: async () => {
                const on = !status.on;
                if (!on && !await appConfirm(t("Turn off {name}? Everything powered through it loses power, including this server if it is plugged into it.", { name: device.name }), t("Turn off device"), t("Turn off"), true)) return;
                setSwitching(device.id); setError("");
                try { await api("power/device/switch", { id: device.id, on }); reload(); }
                catch (reason) { setError(reason instanceof Error ? reason.message : t("Could not switch the device")); }
                finally { setSwitching(""); }
              },
            },
            { label: t("Edit"), icon: <Pencil size={15} />, onSelect: () => setEditing(device) },
            {
              label: t("Delete"), icon: <Trash2 size={15} />, danger: true,
              onSelect: async () => {
                if (!await appConfirm(t("Delete {name} and its recorded power history?", { name: device.name }), t("Delete device"), t("Delete"), true)) return;
                try { await api("power/device/delete", { id: device.id }); reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : t("Could not delete the device")); }
              },
            },
          ]} />}
        </div>;
      })}
      {!readOnly && <PriceForm settings={settings} saved={reload} />}
    </Panel>}
    {editing !== undefined && <DeviceForm device={editing} drivers={drivers} close={() => setEditing(undefined)} saved={() => { setEditing(undefined); reload(); }} />}
  </>;
}

function PriceForm({ settings, saved }: { settings: Settings; saved: () => void }) {
  const [message, setMessage] = useState(""), [error, setError] = useState("");
  return <form key={`${settings.pricePerKwh}-${settings.currency}`} className="price-form" onSubmit={async (event) => {
    event.preventDefault(); setMessage(""); setError("");
    try { await api("power/settings", Object.fromEntries(new FormData(event.currentTarget))); setMessage(t("Price saved.")); saved(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t("Could not save the price")); }
  }}>
    <label>{t("Price per kWh")}<input name="pricePerKwh" type="number" min="0" step="0.001" defaultValue={settings.pricePerKwh || ""} placeholder="1.50" required /></label>
    <label>{t("Currency")}<input name="currency" defaultValue={settings.currency} maxLength={8} required /></label>
    <Btn>{t("Save price")}</Btn>
    {message && <small className="price-feedback">{message}</small>}
    {error && <small className="price-feedback error">{error}</small>}
  </form>;
}

function DeviceForm({ device, drivers, close, saved }: { device: Device | null; drivers: Driver[]; close: () => void; saved: () => void }) {
  const [driverId, setDriverId] = useState(device?.driver ?? drivers[0]?.id ?? "tapo");
  const [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const driver = drivers.find((item) => item.id === driverId);
  return <Modal title={device ? t("Edit {name}", { name: device.name }) : t("Add device")} close={close} guard>
    <form onSubmit={async (event) => {
      event.preventDefault(); setError(""); setSaving(true);
      const values = Object.fromEntries(new FormData(event.currentTarget));
      try { await api("power/device/save", { ...values, id: device?.id, enabled: values.enabled === "true" }); saved(); }
      catch (reason) { setError(reason instanceof Error ? reason.message : t("Could not read the device")); }
      finally { setSaving(false); }
    }}>
      <label>{t("Device type")}<select name="driver" value={driverId} onChange={(event) => setDriverId(event.target.value)} disabled={!!device}>{drivers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        {driver && <small>{driver.description}</small>}</label>
      {device && <input type="hidden" name="driver" value={driverId} />}
      <label>{t("Name")}<input name="name" defaultValue={device?.name} required maxLength={60} placeholder={t("Server rack")} /></label>
      {driver?.fields.map((field) => (
        <label key={`${driverId}-${field.key}`}>{field.label}{field.required ? "" : ` (${t("optional")})`}
          <input name={field.key} type={field.secret ? "password" : "text"} autoComplete={field.secret ? "new-password" : "off"} spellCheck={false}
            defaultValue={device?.driver === driverId ? device.config[field.key] ?? "" : ""}
            placeholder={field.secret && device ? t("Leave blank to keep the saved value") : field.placeholder}
            required={field.required && !(field.secret && device)} />
          {field.help && <small>{field.help}</small>}
        </label>
      ))}
      <label><input name="enabled" type="checkbox" value="true" defaultChecked={device?.enabled !== false} /> {t("Record this device")}</label>
      {error && <div className="alert">{error}</div>}
      <small className="form-note">{t("A recorded device is read once before saving, to check the connection and credentials.")}</small>
      <ModalActions cancel={close}><Btn className="primary" disabled={saving}>{saving ? t("Saving…") : device ? t("Save device") : t("Add device")}</Btn></ModalActions>
    </form>
  </Modal>;
}
