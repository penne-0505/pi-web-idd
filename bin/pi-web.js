#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseLaunchOptions } = require("./pi-web-options");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wireChildProcessLifecycle } = require("./process-lifecycle");

const pkgDir = path.join(__dirname, "..");
const nextDir = path.join(pkgDir, ".next");

// intent: DEC-543 — next CLI を直接 resolve して npx 経由の .bin symlink 欠落を回避
let nextBin;
try {
  nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
} catch {
  // intent: DEC-543 — resolve 失敗時は package root から bin path を derive
  try {
    const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
    nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
  } catch {
    nextBin = path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
  }
}

const { port, hostname, openBrowser } = parseLaunchOptions();
const loopbackHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const passwordEnabled = Boolean(process.env.PI_WEB_PASSWORD);

if (!fs.existsSync(nextDir)) {
  console.error("Build artifacts not found. Please report this issue.");
  process.exit(1);
}

if (!loopbackHostnames.has(hostname)) {
  if (passwordEnabled) {
    console.warn(
      `Warning: pi-web is listening on ${hostname} with Basic Auth over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`,
    );
  } else {
    console.warn(
      `Warning: pi-web is listening on ${hostname} without authentication. Only use this on a trusted network.`,
    );
  }
}

const nextArgs = ["start", "-p", port];
nextArgs.push("-H", hostname);

// intent: DEC-543 — node で JS entry を直接起動して shell:true 経由の path with spaces 問題を回避
const child = spawn(process.execPath, [nextBin, ...nextArgs], {
  cwd: pkgDir,
  stdio: ["inherit", "pipe", "inherit"],
  env: { ...process.env, PI_WEB_HOSTNAME: hostname },
});
wireChildProcessLifecycle(child);

let browserOpened = false;
const url = `http://${hostname}:${port}`;

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (openBrowser && !browserOpened && text.includes("Ready")) {
    browserOpened = true;
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";
    // intent: DEC-543 — Node.js DEP0190 と shell escaping リスクを避けるため argv 分離で spawn
    let opener;
    if (isWindows) {
      // intent: DEC-543 — `start` は cmd 内蔵、空 title 引数を URL の前に置く必要がある
      opener = spawn(process.env.ComSpec || "cmd.exe", ["/c", "start", "", url], {
        stdio: "ignore",
        detached: true,
      });
    } else if (isMac) {
      opener = spawn("open", [url], {
        stdio: "ignore",
        detached: true,
      });
    } else {
      opener = spawn("xdg-open", [url], {
        stdio: "ignore",
        detached: true,
      });
    }

    opener.on("error", (error) => {
      console.warn(`Could not open browser automatically: ${error.message}`);
    });

    opener.unref();
  }
});
