// Stands in for `rclone authorize <service>` in the tests, the way rclone 1.69
// behaves: it waits on 127.0.0.1:53682, names its sign-in address on stderr,
// sends /auth on to the service's sign-in page, and takes the browser's return
// with the code. The code "good" gives a token, printed as rclone prints it;
// any other code, or another state, ends it with rclone's errors.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const service = process.argv[2] === "authorize" ? process.argv[3] : process.argv[2];
const state = randomBytes(8).toString("hex");
const log = (text) => process.stderr.write(`2026/11/12 17:28:20 NOTICE: ${text}\n`);
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:53682");
  if (url.pathname === "/auth") {
    res.writeHead(307, { location: `https://accounts.example/${service}/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2F&state=${url.searchParams.get("state")}` });
    return res.end();
  }
  res.end("<h1>Success!</h1>");
  if (url.searchParams.get("state") !== state) {
    process.stderr.write(`Code: ""\nDescription: Expecting "${state}" got "${url.searchParams.get("state")}"\n`);
    process.exit(2);
  }
  if (url.searchParams.get("code") !== "good") {
    log(`Fatal error: failed to get token: oauth2: "invalid_grant" "Malformed auth code."`);
    process.exit(2);
  }
  process.stdout.write(`Paste the following into your remote machine --->\n{"access_token":"${service}-access","token_type":"Bearer","refresh_token":"${service}-refresh","expiry":"2026-11-12T18:28:20Z"}\n<---End paste\n`);
  server.close(() => process.exit(0));
});
server.listen(53682, "127.0.0.1", () => {
  log(`Please go to the following link: http://127.0.0.1:53682/auth?state=${state}`);
  log("Waiting for code...");
});
server.on("error", (error) => {
  log(`Fatal error: failed to start auth webserver: ${error.message}`);
  process.exit(2);
});
