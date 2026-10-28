#!/usr/bin/env node
// tunnelhop: start/stop the local ProtonVPN proxy stack and run work through it.
// Follows the ~/.claude skill conventions: shared CLI (--help), shared fetchJson (timeout+retry).
// Secrets (proxy password, rotator key) are read from the project's .env and only
// ever passed to child processes as env vars, never printed.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags, handleHelp, usageError } from "../../_shared/cli.mjs";
import { fetchJson } from "../../_shared/http.mjs";

const USAGE = `tunnelhop.mjs: run work through ProtonVPN exit IPs (~/tunnelhop)

  up [--ttl <min>]        start the stack, wait until the tunnel has an exit IP,
                          and arm an auto-stop after <min> idle minutes (default 30, 0 = off)
  down                    stop the stack and cancel the auto-stop
  status                  running or not, plus the current exit IP
  ip                      current exit IP + location
  rotate                  switch to a new Proton IP (new /24 by default)
  run -- <cmd> [args...]  run a command with HTTP(S)_PROXY / ALL_PROXY set to the proxy,
                          plus ROTATOR_URL + ROTATOR_API_KEY for in-script rotation.
                          Starts the stack if needed and re-arms the auto-stop.
  with -- <cmd> [args...] up, run the command, then down (always, also on failure)

Env: TUNNELHOP_DIR overrides the project dir (default ~/tunnelhop).

Run with --help to see this.`;

const PROJECT_DIR = process.env.TUNNELHOP_DIR || join(homedir(), "tunnelhop");
const GLUETUN_CONTAINER = "tunnelhop-gluetun";
const DEFAULT_TTL_MIN = 30;
const UP_TIMEOUT_MS = 120_000;
const DOCKER_START_TIMEOUT_MS = 90_000;
const POLL_MS = 2_000;
const ROTATE_TIMEOUT_MS = 300_000;
const AUTOSTOP_PID_FILE = join(tmpdir(), "tunnelhop-autostop.pid");
const SELF = fileURLToPath(import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnv() {
  const file = join(PROJECT_DIR, ".env");
  if (!existsSync(file)) {
    throw new Error(`no .env in ${PROJECT_DIR}; run ./setup.sh there first`);
  }
  const env = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function endpoints(env) {
  const host = env.BIND_ADDR && env.BIND_ADDR !== "0.0.0.0" ? env.BIND_ADDR : "127.0.0.1";
  const user = encodeURIComponent(env.PROXY_USER || "scraper");
  const pass = encodeURIComponent(env.PROXY_PASSWORD || "");
  return {
    proxyUrl: `http://${user}:${pass}@${host}:${env.PROXY_PORT || 8888}`,
    proxyDisplay: `http://${host}:${env.PROXY_PORT || 8888}`,
    rotatorUrl: `http://${host}:${env.ROTATOR_PORT || 8081}`,
    rotatorKey: env.ROTATOR_API_KEY,
  };
}

function docker(args, { quiet = false } = {}) {
  return spawnSync("docker", args, {
    cwd: PROJECT_DIR,
    stdio: quiet ? "pipe" : ["ignore", "inherit", "inherit"],
    encoding: "utf8",
  });
}

async function ensureDocker() {
  if (docker(["info"], { quiet: true }).status === 0) return;
  if (process.platform !== "darwin") throw new Error("Docker is not running");
  console.error("Docker is not running, starting Docker Desktop...");
  spawnSync("open", ["-a", "Docker"]);
  const deadline = Date.now() + DOCKER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (docker(["info"], { quiet: true }).status === 0) return;
  }
  throw new Error("Docker Desktop did not start in time");
}

function isRunning() {
  const r = docker(["inspect", "-f", "{{.State.Running}}", GLUETUN_CONTAINER], { quiet: true });
  return r.status === 0 && r.stdout.trim() === "true";
}

async function rotator(ep, method, path, timeoutMs = 15_000) {
  return fetchJson(ep.rotatorUrl + path, {
    method,
    headers: { "X-API-Key": ep.rotatorKey },
    timeoutMs,
    retries: method === "GET" ? 2 : 0,
  });
}

async function waitForExitIp(ep) {
  const deadline = Date.now() + UP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const info = await rotator(ep, "GET", "/ip", 5_000);
      if (info?.public_ip) return info;
    } catch {
      // rotator or tunnel not ready yet
    }
    await sleep(POLL_MS);
  }
  throw new Error("tunnel did not come up in time; check: docker compose logs gluetun");
}

function describe(info) {
  return [info.public_ip, info.city, info.country].filter(Boolean).join(" | ");
}

function readAutostop() {
  if (!existsSync(AUTOSTOP_PID_FILE)) return null;
  try {
    return JSON.parse(readFileSync(AUTOSTOP_PID_FILE, "utf8"));
  } catch {
    return null;
  }
}

function cancelAutostop() {
  const timer = readAutostop();
  if (timer) {
    try {
      process.kill(timer.pid);
    } catch {
      // already gone
    }
  }
  rmSync(AUTOSTOP_PID_FILE, { force: true });
}

function armAutostop(ttlMin) {
  cancelAutostop();
  if (!ttlMin) return;
  const child = spawn(process.execPath, [SELF, "_autostop", String(ttlMin)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  writeFileSync(AUTOSTOP_PID_FILE, JSON.stringify({ pid: child.pid, ttl: ttlMin }));
}

function ttlFrom(flags) {
  if (flags.ttl === undefined) return DEFAULT_TTL_MIN;
  const ttl = Number(flags.ttl);
  if (!Number.isFinite(ttl) || ttl < 0) throw new Error("--ttl must be a number of minutes >= 0");
  return ttl;
}

async function up(ttlMin) {
  const ep = endpoints(loadEnv());
  await ensureDocker();
  if (!isRunning()) {
    console.error("starting tunnelhop stack...");
    const r = docker(["compose", "up", "-d"], { quiet: true });
    if (r.status !== 0) throw new Error(`docker compose up failed: ${r.stderr.trim()}`);
  }
  const info = await waitForExitIp(ep);
  armAutostop(ttlMin);
  console.log(`up: ${describe(info)}`);
  console.log(`proxy: ${ep.proxyDisplay} (credentials from .env)`);
  console.log(ttlMin ? `auto-stop after ${ttlMin} idle min` : "auto-stop off");
  return ep;
}

function down() {
  cancelAutostop();
  if (!existsSync(join(PROJECT_DIR, "compose.yaml"))) throw new Error(`no compose.yaml in ${PROJECT_DIR}`);
  const r = docker(["compose", "down"], { quiet: true });
  if (r.status !== 0) throw new Error(`docker compose down failed: ${r.stderr.trim()}`);
  console.log("down: tunnelhop stopped");
}

function runThroughProxy(ep, argv) {
  if (argv.length === 0) throw new Error("nothing to run; use: run -- <cmd> [args...]");
  const proxyEnv = {
    HTTP_PROXY: ep.proxyUrl,
    HTTPS_PROXY: ep.proxyUrl,
    http_proxy: ep.proxyUrl,
    https_proxy: ep.proxyUrl,
    ALL_PROXY: ep.proxyUrl,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    NODE_USE_ENV_PROXY: "1", // honoured by Node 24+ fetch only
    ROTATOR_URL: ep.rotatorUrl,
    ROTATOR_API_KEY: ep.rotatorKey,
  };
  const r = spawnSync(argv[0], argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, ...proxyEnv },
  });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

function commandAfterDashes(rawArgs) {
  const i = rawArgs.indexOf("--");
  return i === -1 ? [] : rawArgs.slice(i + 1);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const [cmd] = rawArgs;
  if (cmd !== "run" && cmd !== "with") handleHelp(rawArgs, USAGE, { requireCommand: true });
  const dashIndex = rawArgs.indexOf("--");
  const optionArgs = dashIndex === -1 ? rawArgs.slice(1) : rawArgs.slice(1, dashIndex);
  const { flags, positional } = parseFlags(optionArgs);

  switch (cmd) {
    case "up":
      await up(ttlFrom(flags));
      break;
    case "down":
      down();
      break;
    case "status": {
      const ep = endpoints(loadEnv());
      if (docker(["info"], { quiet: true }).status !== 0 || !isRunning()) {
        console.log("status: stopped");
        break;
      }
      const info = await rotator(ep, "GET", "/ip").catch(() => ({}));
      console.log(`status: running | ${info.public_ip ? describe(info) : "no exit IP yet"}`);
      break;
    }
    case "ip": {
      const info = await rotator(endpoints(loadEnv()), "GET", "/ip");
      console.log(describe(info));
      break;
    }
    case "rotate": {
      const r = await rotator(endpoints(loadEnv()), "POST", "/rotate", ROTATE_TIMEOUT_MS);
      console.log(`rotated: ${r.old_ip} -> ${describe(r)} | new_subnet: ${r.new_subnet} | attempts: ${r.attempts}`);
      break;
    }
    case "run": {
      const wasRunning = isRunning();
      const ep = wasRunning ? endpoints(loadEnv()) : await up(ttlFrom(flags));
      const timer = readAutostop();
      if (wasRunning && timer) armAutostop(flags.ttl === undefined ? timer.ttl : ttlFrom(flags));
      process.exitCode = runThroughProxy(ep, commandAfterDashes(rawArgs));
      break;
    }
    case "with": {
      const ep = await up(ttlFrom(flags));
      try {
        process.exitCode = runThroughProxy(ep, commandAfterDashes(rawArgs));
      } finally {
        down();
      }
      break;
    }
    case "_autostop": {
      await sleep(Number(positional[0]) * 60_000);
      rmSync(AUTOSTOP_PID_FILE, { force: true });
      docker(["compose", "down"], { quiet: true });
      break;
    }
    default:
      usageError(`Unknown command: ${cmd || "(none)"}`, USAGE);
  }
}

main().catch((e) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
