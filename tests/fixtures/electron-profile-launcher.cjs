const { app } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const sandboxAppData = process.argv[2]
const mainEntry = process.argv[3]

if (!sandboxAppData || !mainEntry) {
  console.error('Usage: electron-profile-launcher.cjs <sandboxAppDataPath> <mainEntryPath> [args...]')
  process.exit(1)
}

// Override appData to sandbox path before any application logic runs
app.setPath('appData', path.resolve(sandboxAppData))

// Remove the launcher arguments so the app sees only standard application arguments
process.argv.splice(2, 2)

// Load the compiled main entry file using dynamic import (since it has top-level await / ESM)
import(pathToFileURL(path.resolve(mainEntry)).href).catch((err) => {
  console.error('[launcher] Failed to load main entry:', err)
  process.exit(1)
})
