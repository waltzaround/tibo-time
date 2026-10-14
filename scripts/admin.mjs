import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const rl = createInterface({ input: stdin, output: stdout });
try {
  const base = new URL(await rl.question("Worker URL: "));
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))) throw new Error("Use HTTPS, or HTTP for localhost.");
  const token = await rl.question("Admin token (input is visible in this terminal): ");
  const action = (await rl.question("Action [status, health, check, test-webhook]: ")).trim();
  if (!["status", "health", "check", "test-webhook"].includes(action)) throw new Error("Unknown action.");
  const response = await fetch(new URL(`/${action}`, base), {
    method: ["status", "health"].includes(action) ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  console.log(`HTTP ${response.status}`);
  console.log(JSON.stringify(await response.json(), null, 2));
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Request failed.");
  process.exitCode = 1;
} finally { rl.close(); }
