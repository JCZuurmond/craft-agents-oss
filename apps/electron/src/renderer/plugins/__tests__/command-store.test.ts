/**
 * Command store semantics: declarative seeding, core-shortcut collision
 * refusal, lazy activation on execute (the `onCommand:` path), hook
 * emission, and per-plugin removal. Runs under bun without a DOM — the
 * keybinding listener itself is DOM-bound and guarded, so it is not
 * installed here.
 */

import './storage-stub'
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  declarePluginCommands,
  removePluginCommands,
  registerPluginCommand,
  executePluginCommand,
  listDeclaredPluginCommands,
  setPluginCommandActivationHandler,
  pluginCommandRegistry,
  __resetPluginCommandsForTests,
} from '../command-store'
import { pluginHostHooks } from '../host-hooks'

beforeEach(() => {
  __resetPluginCommandsForTests()
})

describe('declarePluginCommands', () => {
  test('seeds declared commands with their keybindings', () => {
    declarePluginCommands('demo', [
      { id: 'open', title: 'Open', keybinding: 'mod+shift+9' },
      { id: 'reload', title: 'Reload' },
    ])
    const declared = listDeclaredPluginCommands()
    expect(declared).toHaveLength(2)
    expect(declared.find((c) => c.commandId === 'open')?.keybinding).toBe('mod+shift+9')
  })

  test('refuses a keybinding that collides with a core action default', () => {
    // 'mod+n' is app.newChat's default hotkey; order-insensitive comparison.
    declarePluginCommands('demo', [
      { id: 'steal', title: 'Steal', keybinding: 'mod+n' },
      { id: 'ok', title: 'OK', keybinding: 'mod+shift+9' },
    ])
    const declared = listDeclaredPluginCommands()
    expect(declared.find((c) => c.commandId === 'steal')?.keybinding).toBeUndefined()
    expect(declared.find((c) => c.commandId === 'ok')?.keybinding).toBe('mod+shift+9')
  })

  test('re-declaring an existing command is a no-op', () => {
    declarePluginCommands('demo', [{ id: 'open', title: 'Open' }])
    declarePluginCommands('demo', [{ id: 'open', title: 'Renamed' }])
    expect(listDeclaredPluginCommands()).toHaveLength(1)
    expect(listDeclaredPluginCommands()[0]?.title).toBe('Open')
  })
})

describe('executePluginCommand', () => {
  test('executes a registered command and emits command:executed', async () => {
    const executed: string[] = []
    const subscription = pluginHostHooks.on('command:executed', (p) => {
      executed.push(`${p.pluginId}.${p.commandId}`)
    })
    try {
      declarePluginCommands('demo', [{ id: 'open', title: 'Open' }])
      registerPluginCommand('demo', 'open', (args) => `opened:${String(args ?? '')}`)

      expect(await executePluginCommand('demo.open', 'x')).toBe('opened:x')
      expect(executed).toEqual(['demo.open'])
    } finally {
      subscription.dispose()
    }
  })

  test('lazily activates the owning plugin for a declared, unregistered command', async () => {
    const activations: string[] = []
    setPluginCommandActivationHandler(async (pluginId) => {
      activations.push(pluginId)
      // Activation registers the handler, like a real renderer entry would.
      registerPluginCommand(pluginId, 'open', () => 'lazy-result')
    })
    declarePluginCommands('demo', [{ id: 'open', title: 'Open' }])

    expect(await executePluginCommand('demo.open')).toBe('lazy-result')
    expect(activations).toEqual(['demo'])

    // Second execution dispatches directly, no re-activation.
    await executePluginCommand('demo.open')
    expect(activations).toEqual(['demo'])
  })

  test('rejects when a declared command is never registered by activation', async () => {
    setPluginCommandActivationHandler(async () => {})
    declarePluginCommands('demo', [{ id: 'open', title: 'Open' }])
    await expect(executePluginCommand('demo.open')).rejects.toThrow("did not register declared command")
  })

  test('rejects unknown commands without invoking activation', async () => {
    const activations: string[] = []
    setPluginCommandActivationHandler(async (pluginId) => {
      activations.push(pluginId)
    })
    await expect(executePluginCommand('ghost.command')).rejects.toThrow("Unknown plugin command")
    expect(activations).toEqual([])
  })

  test('undeclared code-only commands execute once registered', async () => {
    registerPluginCommand('demo', 'secret', () => 'ran')
    expect(await executePluginCommand('demo.secret')).toBe('ran')
  })
})

describe('removePluginCommands', () => {
  test('sweeps declarations and handlers for one plugin only', () => {
    declarePluginCommands('a', [{ id: 'one', title: 'One' }])
    declarePluginCommands('b', [{ id: 'two', title: 'Two' }])
    registerPluginCommand('a', 'one', () => {})
    registerPluginCommand('b', 'two', () => {})

    removePluginCommands('a')
    expect(listDeclaredPluginCommands().map((c) => c.pluginId)).toEqual(['b'])
    expect(pluginCommandRegistry.has('a.one')).toBe(false)
    expect(pluginCommandRegistry.has('b.two')).toBe(true)
  })
})
