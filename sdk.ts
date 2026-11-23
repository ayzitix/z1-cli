/**
 * The one place z1-cli finds the z1 SDK.
 *
 * The CLI is a workspace tool, not a published package: it lives next to the
 * SDK instead of depending on it through node_modules. The old source imports
 * named an absolute home directory, which made the checkout unusable anywhere
 * else. This module resolves the checkout at runtime instead:
 *
 *   1. Z1_SDK_REPO
 *   2. a sibling ../z1-sdk (the `z1-projects/z1-sdk` + `z1-projects/z1-cli`
 *      layout)
 *   3. a z1-sdk directory under the current working directory
 *
 * The SDK must be installed and built (`pnpm install`, `pnpm -C z1 build`);
 * the CLI loads the built lib/ packages so it does not typecheck the SDK on
 * every start. If the checkout moves, set Z1_SDK_REPO or keep the two folders
 * siblings.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { Runtime, RunHandle, Session, SessionStore, SessionSummary } from '@z1/bootstrap'
import type { ChatMessage } from '@z1/node'
import type { ApprovalService, RunEvent, RunResult, ToolService } from '@z1/runtime'

const here = dirname(fileURLToPath(import.meta.url))

const candidates = (): string[] => {
  const values = [
    process.env['Z1_SDK_REPO']?.trim(),
    resolve(here, '..', 'z1-sdk'),
    resolve(process.cwd(), 'z1-sdk'),
  ]
  return values.filter((value): value is string => value !== undefined && value !== '')
}

const resolveSdkRoot = (): string => {
  for (const candidate of candidates()) {
    const root = resolve(candidate)
    if (existsSync(join(root, 'z1', 'packages', 'bootstrap', 'lib', 'index.js'))) {
      return root
    }
  }
  const tried = candidates().map((candidate) => `  ${resolve(candidate)}`).join('\n')
  throw new Error(
    [
      'z1-sdk checkout not found or not built.',
      'Set Z1_SDK_REPO to the z1-sdk root and run:',
      '  pnpm install',
      '  pnpm -C z1 build',
      '',
      'Tried:',
      tried,
    ].join('\n'),
  )
}

export const SDK_ROOT = resolveSdkRoot()

const load = async <T>(packageName: string): Promise<T> => {
  const file = join(SDK_ROOT, 'z1', 'packages', packageName, 'lib', 'index.js')
  return (await import(pathToFileURL(file).href)) as T
}

const bootstrap = await load<typeof import('@z1/bootstrap')>('bootstrap')
const agent = await load<typeof import('@z1/agent')>('agent')
const runtime = await load<typeof import('@z1/runtime')>('runtime')
const graph = await load<typeof import('@z1/graph')>('graph')

export const { createRuntime, loadRuntimeConfig } = bootstrap
export const { buildAgentGraph } = agent
export const { runGraph } = runtime
export const { graphDigest } = graph
export const { SessionClearedError, SessionTooNewError, createSessionStore, findRepoRoot } = bootstrap

export type { Runtime, RunHandle, Session, SessionStore, SessionSummary } from '@z1/bootstrap'
export type { ChatMessage } from '@z1/node'
export type { ApprovalService, RunEvent, RunResult, ToolService } from '@z1/runtime'
