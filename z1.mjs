#!/usr/bin/env node
/**
 * z1 launcher: resolve the SDK, pick the entry point, and hand the terminal to
 * tsx. The console (`chat.ts`) is the default; `tools` is the inventory command
 * from this repository; the SDK commands go to the SDK's own CLI.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sdk = resolve(process.env['Z1_SDK_REPO']?.trim() || join(here, '..', 'z1-sdk'))
const tsx = join(sdk, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const runtimeConfig = join(here, 'tsconfig.runtime.json')

if (!existsSync(tsx)) {
  console.error(`z1: z1-sdk is not installed or not built at ${sdk}`)
  console.error('    set Z1_SDK_REPO to the z1-sdk root and run: pnpm install && pnpm -C z1 build')
  process.exit(1)
}

/** Commands owned by the SDK CLI, not the console. */
const sdkCommands = new Set([
  'list',
  'validate',
  'run',
  'tree',
  'fork',
  'memory',
  'template',
  'module',
  'serve',
  'studio',
  'eval',
  'cassette',
  'models',
  'model',
])

/**
 * The z2q checkout, resolved the same way `sdk.ts` resolves it for `tool.create`:
 * `Z1_TOOL_SDK_PATH`, then a sibling `../z1-tool-sdk`, then one under the cwd.
 * `z1 tool …` runs that package's own CLI, so a proposal built by `tool.create`
 * can be installed from the same command the user already types.
 */
const resolveToolSdk = () => {
  const candidates = []
  const explicit = process.env['Z1_TOOL_SDK_PATH']?.trim()
  if (explicit !== undefined && explicit !== '') candidates.push(explicit)
  candidates.push(resolve(here, '..', 'z1-tool-sdk'), resolve(process.cwd(), 'z1-tool-sdk'))
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'dist', 'cli.js'))) return candidate
  }
  return undefined
}

const args = process.argv.slice(2)
const first = args[0]

let entry = join(here, 'chat.ts')
let pass = args
/** A plain node entry point, without tsx: the z2q CLI is already compiled. */
let nodeEntry

if (first === 'tool') {
  // `z1 tool install <dir>` — the name every proposal's next step prints, so the
  // console's own instruction works even though `z1-tool` is not on PATH.
  const root = resolveToolSdk()
  if (root === undefined) {
    console.error('z1: z2q is not installed or not built')
    console.error('    set Z1_TOOL_SDK_PATH to the z1-tool-sdk root and run: npm run build')
    process.exit(1)
  }
  nodeEntry = join(root, 'dist', 'cli.js')
  pass = args.slice(1)
} else if (first === 'tools') {
  entry = join(here, 'tools.ts')
  pass = args.slice(1)
} else if (first === 'chat') {
  pass = args.slice(1)
} else if (first === 'ask') {
  pass = ['--once', args.slice(1).join(' ')]
} else if (first !== undefined && sdkCommands.has(first)) {
  entry = join(sdk, 'z1', 'apps', 'cli', 'src', 'bin.ts')
} else if (first !== undefined && !first.startsWith('-')) {
  // `z1 "prompt"` — one turn, no session, matching the console's --once mode.
  pass = ['--once', args.join(' ')]
}

const child = nodeEntry === undefined
  ? spawn(process.execPath, [tsx, '--tsconfig', runtimeConfig, entry, ...pass], {
      stdio: 'inherit',
      env: { ...process.env, Z1_SDK_REPO: sdk },
    })
  : spawn(process.execPath, [nodeEntry, ...pass], {
      stdio: 'inherit',
      env: { ...process.env, Z1_TOOL_SDK_PATH: resolveToolSdk() ?? '' },
    })

child.on('error', (error) => {
  console.error(`z1: ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
