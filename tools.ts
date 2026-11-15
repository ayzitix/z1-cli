/**
 * `z1 tools` — list the tools the installed service modules expose, with the
 * enablement decision stored by `/tools` in the console. Not part of the
 * repository. Opens the runtime, borrows the `tools` service for one short
 * run, prints names, disposes and closes.
 */

import { createRuntime, loadRuntimeConfig } from '/home/oleksii/Projects/z1-sdk/z1/packages/bootstrap/src/index.ts'

import { loadToolPreferences, toolState } from './tool-policy.ts'

const main = async (): Promise<void> => {
  const config = loadRuntimeConfig({ cwd: process.cwd(), env: process.env })
  const runtime = await createRuntime(config)
  const approval = {
    async request() {
      return 'rejected' as const
    },
  }
  try {
    const handle = await runtime.beginRun({ approval })
    try {
      const tools = await handle.services.tools.list()
      const { prefs, error } = loadToolPreferences()
      for (const tool of tools) {
        const state = toolState(prefs, tool.name)
        console.log(state === 'enabled' ? tool.name : `${tool.name}\t${state}`)
      }
      if (tools.length === 0) console.error('no tools installed')
      if (error !== undefined) console.error(`tool preferences unreadable: ${error}`)
    } finally {
      await handle.dispose()
    }
  } finally {
    await runtime.close()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
