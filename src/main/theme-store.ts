import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isThemePreference, type ThemePreference } from '../shared/contracts.ts'

export interface ThemeStore {
  get(): ThemePreference
  set(theme: ThemePreference): Promise<ThemePreference>
}

interface SettingsFilePayload {
  theme?: unknown
}

export async function createThemeStore(filePath: string): Promise<ThemeStore> {
  let currentTheme: ThemePreference = 'system'

  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as SettingsFilePayload
    if (isThemePreference(parsed.theme)) {
      currentTheme = parsed.theme
    } else {
      console.warn(`[theme-store] Invalid theme in settings file at ${filePath}; defaulting to system appearance.`)
    }
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException
    if (err?.code !== 'ENOENT') {
      console.warn(`[theme-store] Unable to read settings file at ${filePath}; defaulting to system appearance.`, err)
    }
  }

  let writeQueue: Promise<void> = Promise.resolve()

  const set = (theme: ThemePreference): Promise<ThemePreference> => {
    if (!isThemePreference(theme)) {
      return Promise.reject(new TypeError('Invalid theme preference'))
    }

    const task = async (): Promise<ThemePreference> => {
      const tempPath = `${filePath}.${randomUUID()}.tmp`
      try {
        await mkdir(dirname(filePath), { recursive: true })
        const payload = JSON.stringify({ theme }, null, 2) + '\n'
        await writeFile(tempPath, payload, 'utf-8')
        await rename(tempPath, filePath)
        currentTheme = theme
        return theme
      } catch (writeError) {
        await rm(tempPath, { force: true }).catch(() => {})
        throw writeError
      }
    }

    const enqueued = writeQueue.then(task)
    writeQueue = enqueued.then(
      () => {},
      () => {}
    )
    return enqueued
  }

  return {
    get: () => currentTheme,
    set
  }
}
