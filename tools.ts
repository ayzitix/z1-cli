/**
 * `z1 tools` — list the tools the installed service modules expose. Not part
 * of the repository. Opens the runtime, borrows the `tools` service for one
 * short-lived run, prints names, disposes and closes.
 */

import { createRuntime, loadRuntimeConfig } from '/home/oleksii/Projects/z1-sdk/z1/packages/bootstrap/src/index.ts'

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
      for (const tool of tools) console.log(tool.name)
      if (tools.length === 0) console.error('no tools installed')
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
