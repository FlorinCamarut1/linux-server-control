import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = ts.transpileModule(readFileSync(new URL("../src/lib/container-links.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { containerLinks, publishedPorts } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const urls = (container, all = [container], host = "192.168.1.10") => containerLinks(container, all, host).map((link) => link.url);

test("published TCP ports become links; IPv6 duplicates, UDP and unpublished ports are skipped", () => {
  const jellyfin = { Names: "jellyfin", Image: "lscr.io/linuxserver/jellyfin", Ports: "0.0.0.0:1900->1900/udp, [::]:1900->1900/udp, 0.0.0.0:8096->8096/tcp, [::]:8096->8096/tcp, 0.0.0.0:8920->8920/tcp, [::]:8920->8920/tcp, 5432/tcp" };
  assert.deepEqual(urls(jellyfin), ["http://192.168.1.10:8096", "https://192.168.1.10:8920"]);
});

test("the host port is used, ranges yield their first port, and loopback bindings are skipped", () => {
  assert.deepEqual(urls({ Names: "dashboard", Image: "x", Ports: "0.0.0.0:8443->3000/tcp" }), ["http://192.168.1.10:8443"]);
  assert.deepEqual(urls({ Names: "tdarr", Image: "x", Ports: "0.0.0.0:8265-8266->8265-8266/tcp" }), ["http://192.168.1.10:8265"]);
  assert.deepEqual(urls({ Names: "db", Image: "x", Ports: "127.0.0.1:5432->5432/tcp" }), []);
  assert.deepEqual(urls({ Names: "web", Image: "x", Ports: "192.168.1.50:80->80/tcp" }), ["http://192.168.1.50:80"]);
});

test("apps sharing a VPN container's network link to the port that container publishes", () => {
  const gluetun = { Names: "gluetun", Image: "qmcgaw/gluetun", Ports: "0.0.0.0:7878->7878/tcp, 0.0.0.0:8080->8080/tcp" };
  const radarr = { Names: "radarr", Image: "lscr.io/linuxserver/radarr:latest", Ports: "" };
  const sonarr = { Names: "sonarr", Image: "lscr.io/linuxserver/sonarr:latest", Ports: "" };
  const all = [gluetun, radarr, sonarr];
  assert.deepEqual(urls(radarr, all), ["http://192.168.1.10:7878"]);
  assert.deepEqual(urls(sonarr, all), [], "8989 is not published by any container");
  assert.deepEqual(urls({ Names: "tdarr-node", Image: "haveagitgat/tdarr_node", Ports: "8265-8266/tcp" }, all), []);
});

test("an lsc.url label overrides the detected links, and IPv6 hosts are bracketed", () => {
  const labelled = { Names: "app", Image: "x", Ports: "0.0.0.0:80->80/tcp", Labels: "com.docker.compose.project=media,lsc.url=https://media.example/app" };
  assert.deepEqual(urls(labelled), ["https://media.example/app"]);
  assert.deepEqual(urls({ Names: "web", Image: "x", Ports: "0.0.0.0:80->80/tcp" }, undefined, "fd00::1"), ["http://[fd00::1]:80"]);
  assert.equal(publishedPorts("").length, 0);
});
