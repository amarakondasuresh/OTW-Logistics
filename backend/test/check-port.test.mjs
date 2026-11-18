import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { listeningPids, processName, portFree } from "../check-port.js";

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012
  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       5524
  TCP    127.0.0.1:8080         127.0.0.1:52344        ESTABLISHED     5524
  TCP    127.0.0.1:52344        127.0.0.1:8080         ESTABLISHED     9120
  TCP    0.0.0.0:80800          0.0.0.0:0              LISTENING       777
  TCP    [::]:8080              [::]:0                 LISTENING       5524
  TCP    [::]:8081              [::]:0                 ABHÖREN         6000
  UDP    0.0.0.0:8080           *:*                                    4321
`;

test("finds the program listening on the port (IPv4 and IPv6, once)", () => {
  assert.deepEqual(listeningPids(NETSTAT, 8080), ["5524"]);
});
test("ignores connections to the port, other ports and UDP", () => {
  assert.deepEqual(listeningPids(NETSTAT, 9999), []);
  assert.deepEqual(listeningPids(NETSTAT, 80800), ["777"]);
});
test("works when Windows shows the state in another language", () => {
  assert.deepEqual(listeningPids(NETSTAT, 8081), ["6000"]);
});
test("reads the program name from tasklist", () => {
  assert.equal(processName('"node.exe","5524","Console","1","61,248 K"\r\n'), "node.exe");
  assert.equal(processName("INFO: No tasks are running which match the specified criteria."), "");
});
test("detects a port in use and a free port", async () => {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, r));
  const port = s.address().port;
  assert.equal(await portFree(port), false);
  await new Promise((r) => s.close(r));
  assert.equal(await portFree(port), true);
});
