/**
 * `z1 tools` — list the tools the installed service modules expose, with the
 * enablement decision stored by `/tools` in the console. Not part of the
 * repository. Opens the runtime, borrows the `tools` service for one short
 * run, prints the same snapshot the console shows, disposes and closes.
 */

import { createRuntime, loadRuntimeConfig } from '/home/oleksii/Projects/z1-sdk/z1/packages/bootstrap/src/index.ts'

import { ToolState as ToolStore } from './tool-state.ts'

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
      const store = new ToolStore(() => handle.services.tools.list())
      const snapshot = await store.reload()
      for (const record of snapshot.records.filter((row) => row.installed)) {
        console.log(
          record.state === 'enabled' ? record.name : `${record.name}\t${record.state}`,
        )
      }
      if (snapshot.installedCount === 0) console.error('no tools installed')
      if (!snapshot.inventoryKnown) {
        console.error(`tool inventory unavailable: ${snapshot.listError ?? 'unknown error'}`)
      }
      if (snapshot.error !== undefined) console.error(`tool preferences: ${snapshot.error}`)
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
