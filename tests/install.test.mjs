import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// install.sh against stand-ins: Docker, sudo, the SSH tools and the group
// lookup are scripts that record what they are asked, so the installer's
// decisions are checked without changing this machine. The files it downloads
// come from this checkout.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INSTALLER = path.join(ROOT, "install.sh");
// The shell that runs it: sh, which is dash on Debian and Ubuntu; LSC_TEST_SHELL picks another.
const SHELL = process.env.LSC_TEST_SHELL || "sh";
const USER = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
const UID = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
// Where ufw is enabled, the installer lets Docker's networks reach SSH, unless
// a rule does already; the expectations follow this machine's firewall.
const readable = (file) => { try { return readFileSync(file, "utf8"); } catch { return ""; } };
const UFW_RULE = "ufw allow from 172.16.0.0/12 to any port 2222 proto tcp comment 'Linux Server Control'";
const UFW = /^ENABLED=yes/m.test(readable("/etc/ufw/ufw.conf")) && !readable("/etc/ufw/user.rules").includes("--dport 2222 -s 172.16.0.0/12 -j ACCEPT");

function server({ compose = true, dockerRunning = true, dockerGroup = true, sshRunning = true } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "lsc-install-"));
  const bin = path.join(base, "bin"), home = path.join(base, "home"), state = path.join(base, "state");
  for (const folder of [bin, home, state]) mkdirSync(folder);
  const tool = (name, body) => writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // Docker: compose may be missing and the daemon stopped; a finished setup
  // (data/config.json) prints no token.
  tool("docker", `printf '%s\\n' "$*" >> '${state}/docker.log'
case "$*" in
  "compose version") ${compose ? "echo 'Docker Compose version v2.40.0'" : "echo 'docker: unknown command: docker compose' >&2; exit 1"} ;;
  info) ${dockerRunning ? "exit 0" : "echo 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' >&2; exit 1"} ;;
  "compose up -d"|"compose up -d --build") exit 0 ;;
  "compose ps -q dashboard") echo 3f1c2a9b7d01 ;;
  "inspect "*) echo "running healthy" ;;
  "compose exec -T dashboard ssh "*) exit 0 ;;
  "compose logs "*) [ -f data/config.json ] || echo "dashboard-1  | Initial setup token: TOKEN-123_abc" ;;
  *) exit 64 ;;
esac`);
  // sudo records each command; starting the SSH server makes it answer.
  tool("sudo", `case "$1" in
  -v) exit 0 ;;
  sh) printf '%s\\n' "$3" >> '${state}/sudo.log'; case "$3" in *"enable --now ssh"*) : > '${state}/sshd' ;; esac; exit 0 ;;
  docker) shift; printf 'docker %s\\n' "$*" >> '${state}/sudo.log'; exec docker "$@" ;;
  *) printf '%s\\n' "$*" >> '${state}/sudo.log' ;;
esac`);
  if (sshRunning) writeFileSync(path.join(state, "sshd"), "");
  // The scanned identity is this machine's own key where it has one, as the
  // installer compares the two.
  tool("ssh-keyscan", `[ -f '${state}/sshd' ] || exit 1
key=$(awk '{ print $1 " " $2 }' /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null)
printf '|1|c2FsdA==|aGFzaA== %s\\n' "\${key:-ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStandIn}"`);
  tool("ssh", `printf '%s\\n' "$*" >> '${state}/ssh.log'`);
  // The groups of this machine's account, with or without docker.
  tool("id", `case "$1" in
  -nG) groups=$(/usr/bin/id "$@" | tr ' ' '\\n' | grep -vx docker | paste -sd' ' -); echo "$groups${dockerGroup ? " docker" : ""}" ;;
  *) exec /usr/bin/id "$@" ;;
esac`);
  for (const name of ["python3", "file", "crontab", "sshd", "apt-get"]) tool(name, "exit 0");
  const run = (env = {}, options = {}) => {
    const result = spawnSync(SHELL, options.piped ? [] : [INSTALLER], {
      encoding: "utf8",
      input: options.piped ? readFileSync(INSTALLER, "utf8") : "",
      // A session of its own: no terminal, so the installer cannot ask.
      detached: true,
      env: {
        PATH: `${bin}:${process.env.PATH}`, HOME: home, LANG: "C",
        LSC_SOURCE: `file://${ROOT}`, LSC_IP: "127.0.0.1", LSC_SSH_PORT: "2222",
        LSC_ALLOWED_PATHS: path.join(home, "scripts"), LSC_MONITORED_PATHS: "/", LSC_YES: "1",
        ...env,
      },
    });
    return { ...result, output: result.stdout + result.stderr };
  };
  const log = (name) => (existsSync(path.join(state, name)) ? readFileSync(path.join(state, name), "utf8").trim().split("\n") : []);
  const dir = path.join(home, "linux-server-control");
  return { run, log, home, dir, state };
}

test("a server that has everything is set up in one go", () => {
  const { run, log, home, dir } = server();
  const result = run();
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /Setup token\s+TOKEN-123_abc/);
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:8443/);
  const env = readFileSync(path.join(dir, ".env"), "utf8");
  for (const line of [`LAN_IP=127.0.0.1`, `SSH_TARGET=${USER}@127.0.0.1`, "SSH_PORT=2222", `SCRIPT_ROOT=${home}/scripts`, `ALLOWED_PATHS=${home}/scripts`, "MONITORED_PATHS=/", `REMOTE_LOGS=${home}/.local/state/media-dashboard`, "VERSION=latest", "SSH_MULTIPLEX=true"])
    assert.ok(env.split("\n").includes(line), `${line} in .env`);
  assert.equal(statSync(path.join(dir, ".env")).mode & 0o777, 0o600);
  assert.equal(readFileSync(path.join(dir, "compose.yaml"), "utf8"), readFileSync(path.join(ROOT, "compose.github.yaml"), "utf8"));
  assert.ok(existsSync(path.join(home, "scripts")), "the allowed folder is created");
  // The key may sign in, the server's identity is recorded, and the sign-in was tried.
  const publicKey = readFileSync(path.join(dir, "ssh", "id_ed25519.pub"), "utf8").trim();
  assert.deepEqual(readFileSync(path.join(home, ".ssh", "authorized_keys"), "utf8").trim().split("\n"), [publicKey]);
  assert.match(readFileSync(path.join(dir, "ssh", "known_hosts"), "utf8"), /^\|1\|\S+ ssh-ed25519 /);
  assert.match(log("ssh.log")[0], new RegExp(`-p 2222 ${USER}@127\\.0\\.0\\.1 true$`));
  assert.ok(log("docker.log").includes("compose up -d"));
  // Nothing needed sudo, except a firewall rule and handing the folders to the container's user.
  assert.deepEqual(log("sudo.log"), [...(UFW ? [UFW_RULE] : []), ...(UID === "1000" ? [] : [`chown -R 1000:1000 ${dir}/data ${dir}/ssh`])]);
});

test("running it again updates and keeps the settings, key and data", () => {
  const { run, home, dir } = server();
  assert.equal(run().status, 0);
  const env = readFileSync(path.join(dir, ".env"), "utf8");
  const key = readFileSync(path.join(dir, "ssh", "id_ed25519"), "utf8");
  writeFileSync(path.join(dir, "data", "config.json"), "{}");
  writeFileSync(path.join(dir, "compose.yaml"), "# changed by hand\n");
  const again = run({ LSC_IP: "", LSC_ALLOWED_PATHS: "/" });
  assert.equal(again.status, 0, again.output);
  assert.match(again.stdout, /Updating Linux Server Control/);
  assert.match(again.stdout, /up to date and running at http:\/\/127\.0\.0\.1:8443/);
  assert.doesNotMatch(again.stdout, /Setup token/);
  assert.equal(readFileSync(path.join(dir, ".env"), "utf8"), env, "the settings stay");
  assert.equal(readFileSync(path.join(dir, "ssh", "id_ed25519"), "utf8"), key, "the key stays");
  assert.equal(readFileSync(path.join(dir, "compose.yaml.bak"), "utf8"), "# changed by hand\n");
  assert.equal(readFileSync(path.join(dir, "compose.yaml"), "utf8"), readFileSync(path.join(ROOT, "compose.github.yaml"), "utf8"));
  assert.equal(readFileSync(path.join(home, ".ssh", "authorized_keys"), "utf8").trim().split("\n").length, 1, "the key is listed once");
});

test("an update records the server's identity when it is missing", () => {
  const { run, dir } = server();
  assert.equal(run().status, 0);
  const known = path.join(dir, "ssh", "known_hosts");
  const recorded = readFileSync(known, "utf8");
  writeFileSync(known, "", { flag: "w" });
  assert.equal(run().status, 0);
  assert.equal(readFileSync(known, "utf8"), "", "an update keeps a recorded identity");
  // Removed, it is recorded again.
  rmSync(known);
  const again = run();
  assert.equal(again.status, 0, again.output);
  assert.equal(readFileSync(known, "utf8").split(" ").slice(1).join(" "), recorded.split(" ").slice(1).join(" "));
});

test("in a copy of the source code it builds the dashboard from that code", () => {
  const { run, log, home } = server();
  // A clone: the source code with its own compose.yaml, which builds the image.
  const clone = path.join(home, "src", "linux-server-control");
  mkdirSync(clone, { recursive: true });
  for (const name of ["Dockerfile", "package.json", "compose.yaml", ".env.example"]) writeFileSync(path.join(clone, name), readFileSync(path.join(ROOT, name)));
  const result = run({ LSC_DIR: clone, LSC_SOURCE: "file:///nonexistent" });
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /built from the source code/);
  assert.equal(readFileSync(path.join(clone, "compose.yaml"), "utf8"), readFileSync(path.join(ROOT, "compose.yaml"), "utf8"), "its compose.yaml stays");
  assert.ok(!existsSync(path.join(clone, "compose.yaml.bak")));
  assert.match(readFileSync(path.join(clone, ".env"), "utf8"), /^SSH_TARGET=.+@127\.0\.0\.1$/m);
  assert.ok(log("docker.log").includes("compose up -d --build"));
  assert.match(result.stdout, /git pull, then run this again/);
});

test("a bare server gets what it lacks with sudo, once agreed", () => {
  const { run, log, dir } = server({ compose: false, dockerRunning: false, dockerGroup: false, sshRunning: false });
  const result = run();
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /To continue, these commands run with sudo:/);
  const commands = log("sudo.log");
  const planned = ["systemctl enable --now ssh", "apt-get install -y docker-compose-plugin || apt-get install -y docker-compose-v2", "systemctl enable --now docker", `usermod -aG docker ${USER}`];
  assert.deepEqual(commands.slice(0, planned.length), planned);
  // Until the next sign-in, Docker is used through sudo.
  assert.ok(commands.includes("docker compose up -d"), commands.join("\n"));
  assert.match(result.stdout, /Sign out and back in to use docker without sudo/);
  assert.match(result.stdout, /TOKEN-123_abc/);
  assert.ok(existsSync(path.join(dir, ".env")));
});

test("nothing is changed without consent", () => {
  const { run, log, dir } = server({ compose: false, dockerGroup: false });
  const result = run({ LSC_YES: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Nothing was changed/);
  assert.deepEqual(log("sudo.log"), []);
  assert.ok(!existsSync(dir), "no folder is created");
});

test("folders that are too wide or hold keys are refused", () => {
  for (const folders of ["/", "/home", "~/scripts", "HOME", "HOME/.ssh", "HOME/linux-server-control/data", "/srv/media,/"]) {
    const { run, home, dir } = server();
    const result = run({ LSC_ALLOWED_PATHS: folders.replace("HOME", home) });
    assert.equal(result.status, 1, folders);
    assert.match(result.stderr, /too wide|absolute folders/, folders);
    assert.ok(!existsSync(path.join(dir, ".env")), folders);
  }
});

test("an address that is not this server's is refused", () => {
  const { run, dir } = server();
  const result = run({ LSC_IP: "192.0.2.10" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /192\.0\.2\.10 is not an address of this server/);
  assert.ok(!existsSync(path.join(dir, ".env")));
});

test("it runs when piped into sh, as the one-line command does", () => {
  const { run } = server();
  const result = run({}, { piped: true });
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /TOKEN-123_abc/);
});
