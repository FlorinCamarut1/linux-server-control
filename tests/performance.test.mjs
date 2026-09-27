import assert from "node:assert/strict";
import test from "node:test";
import { loadServer } from "./harness.mjs";

function snapshotHost({ failDocker = false } = {}) {
  return (argv) => {
    if (argv[0] === "docker") return failDocker ? { code: 1, stderr: "Cannot connect to the Docker daemon" } : { stdout: '{"Names":"example"}\n' };
    if (argv[0] === "df") return { stdout: "Filesystem 1-blocks Used Available Capacity Mounted\n/dev/example 1000 200 800 20% /srv/example\n" };
    if (argv[0] === "bash") return { stdout: "cpuUsagePercent=12.5\nmemoryTotalBytes=1000\n" };
    return { stdout: "" };
  };
}

test("simultaneous snapshots share asynchronous host reads; next refresh reads again", async () => {
  const { server, commands } = loadServer({ host: snapshotHost(), delay: 5 });
  const count = (name) => commands.filter((item) => item.argv[0] === name).length;
  const first = server.hostSnapshot();
  const second = server.hostSnapshot();
  assert.equal(first, second);
  const snapshot = await first;
  assert.ok(count("docker") && count("bash") && count("date"));
  assert.equal(snapshot.stats.cpuUsagePercent, 12.5);
  assert.equal(snapshot.stats.storage[0].usedPercent, 20);
  assert.equal(count("docker"), 1);
  await server.hostSnapshot();
  assert.equal(count("docker"), 2);
});

test("failed reads do not poison later snapshots and do not leak the command line", async () => {
  const { server, commands } = loadServer({ host: snapshotHost({ failDocker: true }) });
  await assert.rejects(server.hostSnapshot(), (error) => {
    assert.equal(error.message, "Cannot connect to the Docker daemon");
    assert.ok(!error.message.includes("docker ps"));
    return true;
  });
  await assert.rejects(server.hostSnapshot(), /Docker daemon/);
  assert.equal(commands.filter((item) => item.argv[0] === "docker").length, 2);
});
