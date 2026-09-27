// Builds the web links for a container from `docker ps` data, so its interface
// can be opened directly from the Containers page.
export type LinkSource = { Names: string; Image: string; Ports: string; Labels?: string };
export type ContainerLink = { url: string; label: string };

// Container ports that serve HTTPS rather than HTTP.
const HTTPS_PORTS = new Set([443, 8443, 8920]);

// Default web ports of common self-hosted apps. They are used only for
// containers without published ports of their own, typically ones that share a
// VPN container's network, and only when another container publishes that port.
const KNOWN_PORTS: [RegExp, number][] = [
  [/jellyseerr|overseerr/, 5055],
  [/jellyfin/, 8096],
  [/radarr/, 7878],
  [/sonarr/, 8989],
  [/lidarr/, 8686],
  [/readarr/, 8787],
  [/prowlarr/, 9696],
  [/bazarr/, 6767],
  [/qbittorrent/, 8080],
  [/sabnzbd/, 8080],
  [/transmission/, 9091],
  [/tdarr(?!.*node)/, 8265],
  [/portainer/, 9000],
  [/homeassistant|home-assistant/, 8123],
  [/uptime-kuma/, 3001],
  [/immich/, 2283],
  [/plex/, 32400],
];

type Published = { hostIp: string; hostPort: number; containerPort: number };

// Parses entries such as "0.0.0.0:8096->8096/tcp" or "[::]:8265-8266->8265-8266/tcp".
// Unpublished ("5432/tcp") and UDP ports are skipped; a range yields its first port.
export function publishedPorts(ports: string): Published[] {
  const result: Published[] = [];
  for (const entry of ports.split(",").map((item) => item.trim())) {
    const match = /^(?:\[?([^\]]*?)\]?:)?(\d+)(?:-\d+)?->(\d+)(?:-\d+)?\/tcp$/.exec(entry);
    if (!match) continue;
    result.push({ hostIp: match[1] || "0.0.0.0", hostPort: Number(match[2]), containerPort: Number(match[3]) });
  }
  return result;
}

function label(labels: string | undefined, name: string) {
  for (const pair of (labels || "").split(",")) {
    const index = pair.indexOf("=");
    if (index > 0 && pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return "";
}

// `hostname` is the host the browser used to open the dashboard, which is the
// same machine the containers run on.
export function containerLinks(container: LinkSource, all: LinkSource[], hostname: string): ContainerLink[] {
  const explicit = label(container.Labels, "lsc.url");
  if (/^https?:\/\//.test(explicit)) return [{ url: explicit, label: new URL(explicit).host }];
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  const links = new Map<string, ContainerLink>();
  const add = (hostIp: string, hostPort: number, containerPort: number) => {
    // A port bound to the loopback interface is not reachable from the browser.
    if (hostIp.startsWith("127.") || hostIp === "::1") return;
    const address = hostIp === "0.0.0.0" || hostIp === "::" || hostIp === "" ? host : hostIp.includes(":") ? `[${hostIp}]` : hostIp;
    const scheme = HTTPS_PORTS.has(containerPort) ? "https" : "http";
    const url = `${scheme}://${address}:${hostPort}`;
    links.set(url, { url, label: String(hostPort) });
  };
  const own = publishedPorts(container.Ports);
  for (const port of own) add(port.hostIp, port.hostPort, port.containerPort);
  if (!own.length) {
    const image = `${container.Image} ${container.Names}`.toLowerCase();
    const port = KNOWN_PORTS.find(([pattern]) => pattern.test(image))?.[1];
    const publisher = port && all.flatMap((item) => publishedPorts(item.Ports)).find((item) => item.hostPort === port);
    if (publisher) add(publisher.hostIp, publisher.hostPort, publisher.containerPort);
  }
  return [...links.values()];
}
