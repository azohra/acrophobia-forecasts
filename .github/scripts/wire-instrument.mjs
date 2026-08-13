/* Wire instrumentation for one build step. Preloaded with
   NODE_OPTIONS="--import .../wire-instrument.mjs", it patches
   node:http/node:https `request` — the engine's whole provider transport —
   times every download to body completion, and prints one summary block
   when the process exits. It never touches response bodies (sizes come
   from content-length), so the engine's streams behave exactly as before.

   Reading the summary:
   - wire-busy ≈ wall with mean concurrency pinned at the builder's fetch
     gate and low busy throughput → the tick is wire-bound; raise the gate
     or fetch fewer bytes.
   - p50 latency high against small mean request sizes → round-trip-bound;
     concurrency and connection reuse are the lever.
   - cpu ≈ wall → compute-bound again; the wire is no longer the story. */
import diagnostics from "node:diagnostics_channel";
import { writeSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const durationsMs = [];
const hosts = new Map();
let active = 0;
let busyMs = 0;
let lastTransitionAt = 0;
const startedAt = performance.now();

function transition(delta) {
  const now = performance.now();
  if (active > 0) busyMs += now - lastTransitionAt;
  lastTransitionAt = now;
  active += delta;
}

function record(host, ms, bytes, ok) {
  durationsMs.push(ms);
  const row = hosts.get(host) ?? { requests: 0, bytes: 0, ms: 0, failures: 0 };
  row.requests += 1;
  row.bytes += bytes;
  row.ms += ms;
  if (!ok) row.failures += 1;
  hosts.set(host, row);
}

/* The dataset endpoint's hostname carries the R2 account id; these lines
   land in public Actions logs, so it prints as a label, never verbatim. */
function redactHost(host) {
  return host.endsWith(".r2.cloudflarestorage.com") ? "r2 dataset endpoint" : host;
}

function hostOf(argument) {
  if (typeof argument === "string") return new URL(argument).host;
  if (argument instanceof URL) return argument.host;
  return argument?.host ?? argument?.hostname ?? "unknown";
}

function wrap(module_) {
  const originalRequest = module_.request;
  module_.request = function wireTimedRequest(...args) {
    const host = redactHost(hostOf(args[0]));
    const begunAt = performance.now();
    let settled = false;
    const settle = (bytes, ok) => {
      if (settled) return;
      settled = true;
      transition(-1);
      record(host, performance.now() - begunAt, bytes, ok);
    };
    transition(1);
    const request_ = originalRequest.apply(this, args);
    request_.on("response", (response) => {
      const bytes = Number(response.headers["content-length"] ?? 0);
      response.on("end", () => settle(bytes, true));
      response.on("close", () => settle(bytes, response.complete));
    });
    request_.on("error", () => settle(0, false));
    request_.on("close", () => settle(0, false));
    return request_;
  };
}

wrap(http);
wrap(https);
syncBuiltinESMExports();

/* The NOAA builders and the published-dataset reads go through
   globalThis.fetch (undici), which never touches node:http — undici's
   diagnostics channels cover that half of the transport. Timing runs
   request create → trailers (body complete), matching the node:http arm. */
const undiciBegunAt = new WeakMap();
const undiciBytes = new WeakMap();

function settleUndici(request_, ok) {
  const begunAt = undiciBegunAt.get(request_);
  if (begunAt === undefined) return;
  undiciBegunAt.delete(request_);
  transition(-1);
  const host = redactHost(request_.origin ? new URL(request_.origin).host : "unknown");
  record(host, performance.now() - begunAt, ok ? (undiciBytes.get(request_) ?? 0) : 0, ok);
}

diagnostics.subscribe("undici:request:create", ({ request: request_ }) => {
  undiciBegunAt.set(request_, performance.now());
  transition(1);
});
diagnostics.subscribe("undici:request:headers", ({ request: request_, response }) => {
  const raw = response.headers;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    if (String(raw[index]).toLowerCase() === "content-length") {
      undiciBytes.set(request_, Number(String(raw[index + 1])) || 0);
      break;
    }
  }
});
diagnostics.subscribe("undici:request:trailers", ({ request: request_ }) => {
  settleUndici(request_, true);
});
diagnostics.subscribe("undici:request:error", ({ request: request_ }) => {
  settleUndici(request_, false);
});

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

process.on("exit", () => {
  if (durationsMs.length === 0) return;
  if (active > 0) busyMs += performance.now() - lastTransitionAt;
  const wallMs = performance.now() - startedAt;
  const cpu = process.cpuUsage();
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const inFlightMs = sorted.reduce((total, ms) => total + ms, 0);
  const totalBytes = [...hosts.values()].reduce((total, row) => total + row.bytes, 0);
  const failures = [...hosts.values()].reduce((total, row) => total + row.failures, 0);
  const mib = (n) => (n / (1024 * 1024)).toFixed(1);
  const s = (ms) => (ms / 1000).toFixed(1);
  const lines = [
    `[wire] ${durationsMs.length} requests (${failures} failed), ${mib(totalBytes)} MiB, wall ${s(wallMs)} s`,
    `[wire] wire-busy ${s(busyMs)} s (${Math.round((busyMs / wallMs) * 100)}% of wall) · mean concurrency ${(inFlightMs / busyMs).toFixed(1)} · busy throughput ${mib(totalBytes / (busyMs / 1000))} MiB/s`,
    `[wire] request latency p50 ${quantile(sorted, 0.5).toFixed(0)} ms · p90 ${quantile(sorted, 0.9).toFixed(0)} ms · max ${s(sorted[sorted.length - 1])} s · mean size ${mib(totalBytes / durationsMs.length)} MiB`,
    `[wire] cpu user ${s(cpu.user / 1000)} s · system ${s(cpu.system / 1000)} s (of ${s(wallMs)} s wall)`,
    ...[...hosts.entries()].map(
      ([host, row]) =>
        `[wire]   ${host}: ${row.requests} requests, ${mib(row.bytes)} MiB, mean ${(row.ms / row.requests).toFixed(0)} ms${row.failures > 0 ? `, ${row.failures} failed` : ""}`,
    ),
  ];
  writeSync(1, `${lines.join("\n")}\n`);
});
