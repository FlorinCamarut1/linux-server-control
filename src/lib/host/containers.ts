// What the Containers page shows and does beyond the list a refresh reads:
// each container's CPU and memory use, and updating a container to the newest
// version of its image.
import os from "node:os";
import { audit } from "./store";
import { CommandError, run } from "./ssh";
import { CONTAINER_NAME } from "./monitor";
import { t } from "../i18n";

export type ContainerUse = { cpuPercent: number | null; memory: string; memoryPercent: number | null };
const percent = (value: unknown) => {
  const parsed = Number(String(value ?? "").replace("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
};
// Docker measures every running container for a second or two, so the use is
// read apart from the refresh, while the Containers page is shown.
export async function containerStats(): Promise<Record<string, ContainerUse>> {
  const output = await run(["docker", "stats", "--no-stream", "--format", "{{json .}}"], 30000);
  const stats: Record<string, ContainerUse> = {};
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    let read: { Name?: string; CPUPerc?: string; MemUsage?: string; MemPerc?: string };
    try { read = JSON.parse(line); } catch { continue; }
    if (!read.Name) continue;
    // "310MiB / 15.5GiB": what it uses, of what it may use.
    stats[read.Name] = { cpuPercent: percent(read.CPUPerc), memory: String(read.MemUsage ?? "").split("/")[0].trim(), memoryPercent: percent(read.MemPerc) };
  }
  return stats;
}

// Updating a container: Compose pulls the image of its service and starts the
// service again, which replaces the container only if the image is a newer
// one. The project, its folder and its files are read from the labels Compose
// gave the container, so they are the ones it was started with. The script
// reports what it cannot do as a word after "lsc:", and at the end the image
// before and after.
const UPDATE_SCRIPT = [
  String.raw`name=$1 self=$2`,
  String.raw`details=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}{{"\n"}}{{index .Config.Labels "com.docker.compose.service"}}{{"\n"}}{{index .Config.Labels "com.docker.compose.project.working_dir"}}{{"\n"}}{{index .Config.Labels "com.docker.compose.project.config_files"}}{{"\n"}}{{.Id}}{{"\n"}}{{.Image}}' "$name") || exit 1`,
  String.raw`{ IFS= read -r project; IFS= read -r service; IFS= read -r folder; IFS= read -r files; IFS= read -r id; IFS= read -r image; } <<EOF`,
  String.raw`$details`,
  String.raw`EOF`,
  String.raw`[ -n "$project" ] && [ -n "$service" ] || { echo lsc:not-compose >&2; exit 3; }`,
  String.raw`if [ -n "$self" ]; then case $id in "$self"*) echo lsc:self >&2; exit 4 ;; esac; fi`,
  String.raw`if docker compose version >/dev/null 2>&1; then set -- docker compose`,
  String.raw`elif command -v docker-compose >/dev/null 2>&1; then set -- docker-compose`,
  String.raw`else echo lsc:no-compose >&2; exit 5; fi`,
  String.raw`[ -n "$folder" ] && cd "$folder" 2>/dev/null || { echo lsc:no-folder >&2; exit 6; }`,
  String.raw`set -- "$@" -p "$project" --project-directory "$folder"`,
  String.raw`set -f; saved=$IFS; IFS=,`,
  String.raw`for file in $files; do [ -n "$file" ] && set -- "$@" -f "$file"; done`,
  String.raw`IFS=$saved; set +f`,
  String.raw`"$@" pull "$service" || exit 1`,
  String.raw`"$@" up -d --no-deps "$service" || exit 1`,
  String.raw`printf 'lsc-image %s %s\n' "$image" "$(docker inspect --format '{{.Image}}' "$name" 2>/dev/null)"`,
].join("\n");
const UPDATE_PROBLEMS: Record<string, () => string> = {
  "lsc:not-compose": () => t("This container was not started with Docker Compose, so the dashboard cannot update it."),
  "lsc:self": () => t("The dashboard cannot update its own container. Run the installer again on the server instead."),
  "lsc:no-compose": () => t("Docker Compose is not installed on the server."),
  "lsc:no-folder": () => t("The folder of this container's Compose project is no longer on the server."),
};
// A large image takes minutes to pull.
const UPDATE_MS = 20 * 60 * 1000;
// Inside its own container the dashboard's host name is the start of that
// container's identifier; replacing it would end the update halfway.
const ownContainer = () => (/^[0-9a-f]{12}$/.test(os.hostname()) ? os.hostname() : "");
export async function updateContainer(name: string) {
  if (!CONTAINER_NAME.test(name)) throw Error(t("Invalid container name"));
  let output: string;
  try {
    output = await run(["sh", "-c", UPDATE_SCRIPT, "update", name, ownContainer()], UPDATE_MS);
  } catch (error) {
    const problem = error instanceof CommandError ? UPDATE_PROBLEMS[error.message] : undefined;
    if (problem) throw Error(problem());
    throw error;
  }
  const [, before, after] = /^lsc-image (\S+) (\S*)$/m.exec(output) ?? [];
  const updated = Boolean(before && after && before !== after);
  audit(`container ${name} ${updated ? "updated to a new image" : "checked for a new image: none"}`);
  return { updated };
}
