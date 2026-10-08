export const COMMAND_DESCRIPTORS = [
  {
    id: 'navigate-home',
    label: 'Go to Home',
    keywords: ['home', 'nav', 'main', 'start']
  },
  {
    id: 'navigate-search',
    label: 'Search files',
    keywords: ['search', 'find', 'files', 'query', 'download']
  },
  {
    id: 'navigate-library',
    label: 'Open shared library',
    keywords: ['library', 'share', 'files', 'shared', 'add']
  },
  {
    id: 'navigate-transfers',
    label: 'Open transfers',
    keywords: ['transfers', 'downloads', 'uploads', 'progress']
  },
  {
    id: 'navigate-network',
    label: 'Open network',
    keywords: ['network', 'connect', 'peers', 'supernode', 'status']
  },
  {
    id: 'open-appearance',
    label: 'Open Appearance',
    keywords: ['appearance', 'theme', 'settings', 'preferences', 'color']
  },
  {
    id: 'theme-system',
    label: 'Use system appearance',
    keywords: ['system', 'theme', 'appearance', 'auto', 'os']
  },
  {
    id: 'theme-light',
    label: 'Use light appearance',
    keywords: ['light', 'theme', 'appearance', 'bright', 'white', 'day']
  },
  {
    id: 'theme-dark',
    label: 'Use dark appearance',
    keywords: ['dark', 'theme', 'appearance', 'black', 'night']
  }
] as const

export type CommandDescriptor = (typeof COMMAND_DESCRIPTORS)[number]
export type CommandId = CommandDescriptor['id']

export function filterCommands(query: string): CommandDescriptor[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return [...COMMAND_DESCRIPTORS]
  }

  return COMMAND_DESCRIPTORS.filter((cmd) => {
    if (cmd.label.toLowerCase().includes(normalized)) {
      return true
    }
    return cmd.keywords.some((kw) => kw.toLowerCase().includes(normalized))
  })
}
