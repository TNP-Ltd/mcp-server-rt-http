#!/usr/bin/env node
// rt-compact: runs mcp-server-rt and shrinks its read-tool results (see transform.mjs) on the way
// out. MCP over stdio is one JSON-RPC message per line in each direction. Requests are passed to
// mcp-server-rt as they are, apart from defaults added to some tool arguments; responses to
// tools/call and tools/list are transformed; everything else is passed back unchanged.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { applyArgumentDefaults, transformResult, transformToolList } from "./transform.mjs";

const server = spawn(process.env.RT_COMPACT_SERVER ?? "mcp-server-rt", process.argv.slice(2), {
  stdio: ["pipe", "pipe", "inherit"],
});
server.on("error", (err) => { console.error(`rt-compact: cannot start mcp-server-rt: ${err.message}`); process.exit(1); });
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.kill(sig));

// Request id -> tool name for tools/call, or "tools/list".
const pending = new Map();
const key = (id) => JSON.stringify(id);

function forEachMessage(line, fn) {
  let msg;
  try { msg = JSON.parse(line); } catch { return line; }
  const out = Array.isArray(msg) ? msg.map(fn) : fn(msg);
  return JSON.stringify(out);
}

function onRequest(msg) {
  if (msg?.id === undefined || msg.id === null) return msg;
  if (msg.method === "tools/list") pending.set(key(msg.id), "tools/list");
  if (msg.method === "tools/call" && typeof msg.params?.name === "string") {
    pending.set(key(msg.id), msg.params.name);
    return { ...msg, params: { ...msg.params, arguments: applyArgumentDefaults(msg.params.name, msg.params.arguments) } };
  }
  return msg;
}

function onResponse(msg) {
  if (msg?.id === undefined || msg.id === null || msg.method !== undefined) return msg;
  const tool = pending.get(key(msg.id));
  if (tool === undefined) return msg;
  pending.delete(key(msg.id));
  if (!msg.result) return msg;
  try {
    return { ...msg, result: tool === "tools/list" ? transformToolList(msg.result) : transformResult(tool, msg.result) };
  } catch (err) {
    // Never lose a result to a bug here: pass it on untransformed.
    console.error(`rt-compact: could not transform ${tool} result: ${err.stack ?? err}`);
    return msg;
  }
}

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (line) => { if (line.trim()) server.stdin.write(`${forEachMessage(line, onRequest)}\n`); })
  .on("close", () => server.stdin.end());

createInterface({ input: server.stdout, crlfDelay: Infinity })
  .on("line", (line) => { if (line.trim()) process.stdout.write(`${forEachMessage(line, onResponse)}\n`); });
