#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const legacyWatcher = resolve(scriptDir, "watch-rc-heartbeat.js")
const child = spawnSync(process.execPath, [legacyWatcher, ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
})

if (child.status === null) {
  process.exit(1)
}

process.exit(child.status)
