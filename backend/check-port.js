// Run by START-WINDOWS.bat before the server starts.
// If another program already uses the port - usually an older copy of this server, maybe from another project
// folder - the browser would show THAT copy and its database instead of this one. This finds it and offers to stop it.
// Exit code 0: the port is free (or was freed). Exit code 1: it is still in use; do not start.
import net from "node:net";
import { execSync } from "node:child_process";
import readline from "node:readline";
import dotenv from "dotenv";

dotenv.config();
const PORT = Number(process.env.PORT || 8080);

export function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port); // same as the server: every address
  });
}

// Lines of `netstat -ano` whose local address ends in :PORT and that are listening (remote address 0.0.0.0:0 or [::]:0,
// which also works on Windows set to another language).
export function listeningPids(netstatText, port) {
  const pids = new Set();
  for (const line of String(netstatText).split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t.length < 5 || !/^TCP/i.test(t[0])) continue;
    const [, local, remote] = t;
    const pid = t[t.length - 1];
    if (local.endsWith(":" + port) && /^(0\.0\.0\.0|\[::\]):0$/.test(remote) && /^\d+$/.test(pid) && pid !== "0")
      pids.add(pid);
  }
  return [...pids];
}

export function processName(tasklistCsv) {
  const m = String(tasklistCsv).match(/^"([^"]+)"/m);
  return m ? m[1] : "";
}

const ask = (q) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      resolve(String(a || "").trim().toLowerCase());
    });
  });

async function main() {
  if (await portFree(PORT)) return 0;
  console.log(`\n  Port ${PORT} is already in use. Another copy of this server is probably still running,`);
  console.log("  maybe an older version from another folder. While it runs, the browser shows THAT copy,");
  console.log("  not this one.\n");
  if (process.platform !== "win32") {
    console.log("  Stop the other copy (close its window), then start again.");
    return 1;
  }
  let found = [];
  try {
    found = listeningPids(execSync("netstat -ano", { encoding: "utf8" }), PORT).map((pid) => {
      let name = "";
      try {
        name = processName(execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: "utf8" }));
      } catch {}
      return { pid, name };
    });
  } catch {}
  const others = found.filter((p) => p.name.toLowerCase() !== "node.exe");
  if (!found.length || others.length) {
    const who = found.map((p) => `${p.name || "unknown program"} (PID ${p.pid})`).join(", ");
    console.log(`  It is used by: ${who || "a program that could not be identified"}.`);
    console.log("  That is not this server, so it was not stopped. Close that program, or set another");
    console.log("  PORT in backend\\.env, then start again.");
    return 1;
  }
  console.log(`  It is used by: ${found.map((p) => `node.exe (PID ${p.pid})`).join(", ")}.`);
  const a = await ask("  Stop the other copy and start this version? [Y/N] ");
  if (a !== "y" && a !== "yes") {
    console.log("\n  Nothing was stopped. Close the other server window, then start again.");
    return 1;
  }
  for (const p of found) {
    try {
      execSync(`taskkill /PID ${p.pid} /F`, { stdio: "ignore" });
    } catch {}
  }
  for (let i = 0; i < 20; i++) {
    if (await portFree(PORT)) {
      console.log("  The other copy was stopped.\n");
      return 0;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log("  The other copy could not be stopped. Restart the computer, then start again.");
  return 1;
}

// Run only when started directly (node check-port.js), not when a test imports it.
if (/check-port\.js$/i.test(process.argv[1] || "")) main().then((code) => process.exit(code));
