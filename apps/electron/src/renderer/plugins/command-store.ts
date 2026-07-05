/**
 * Plugin Command Store
 *
 * Renderer-side command dispatch for plugin-contributed commands — the
 * VS Code/Obsidian `addCommand` surface backed by the shared
 * PluginCommandRegistry, plus the keybinding binder for commands declared
 * with a `keybinding` in the manifest (the Vim-mapping / VS Code-keybinding
 * pattern).
 *
 * Precedence and safety:
 * - Core app shortcuts always win. The action registry listens in the
 *   capture phase and stops propagation on a match; this store listens in
 *   the bubble phase, so it only ever sees keys core did not claim. On top
 *   of that, a declared chord that collides with a core action's default
 *   hotkey is refused at declare time (with a console warning).
 * - Plugin keybindings never fire while a text input is focused or a
 *   modal/menu is open (same context keys core when-clauses use).
 *
 * Lazy activation: executing a *declared* command whose plugin has not
 * activated yet activates the plugin first (the manifest's
 * `onCommand:{id}` activation event), then dispatches. The activation
 * callback is injected by the runtime to avoid an import cycle.
 */

import { PluginCommandRegistry, type PluginCommandHandler } from '@craft-agent/shared/plugins/commands'
import { qualifiedCommandId, type PluginCommandDeclaration, type PluginDisposable } from '@craft-agent/shared/plugins/types'
import { actions } from '@/actions/definitions'
import { matchesHotkey } from '@/actions/registry'
import { getKeybindingContext } from '@/actions/keybinding-context'
import { pluginHostHooks } from './host-hooks'

/** Singleton registry of handlers registered by activated plugins */
export const pluginCommandRegistry = new PluginCommandRegistry()

interface DeclaredCommand {
  pluginId: string
  commandId: string
  title: string
  keybinding?: string
}

/** Declared commands by qualified id (`{pluginId}.{commandId}`) */
const declaredCommands = new Map<string, DeclaredCommand>()

/** Injected by the runtime: activate a plugin (lazy `onCommand:` path) */
let activationHandler: ((pluginId: string) => Promise<void>) | null = null

export function setPluginCommandActivationHandler(handler: (pluginId: string) => Promise<void>): void {
  activationHandler = handler
}

/** Chord normalization so 'shift+mod+b' and 'mod+shift+b' compare equal */
function normalizeChord(chord: string): string {
  const parts = chord.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const modifiers = parts.slice(0, -1).sort()
  return [...modifiers, key].join('+')
}

const CORE_DEFAULT_CHORDS = new Set(
  Object.values(actions)
    .map((action) => action.defaultHotkey as string | null)
    .filter((hotkey): hotkey is string => hotkey !== null)
    .map(normalizeChord),
)

/**
 * Seed a plugin's declared commands (called by the runtime for enabled
 * plugins, from manifest data alone — before any plugin code runs).
 * Keybindings that collide with a core action default are dropped with a
 * warning; the command itself stays executable.
 */
export function declarePluginCommands(pluginId: string, declarations: PluginCommandDeclaration[]): void {
  for (const declaration of declarations) {
    const key = qualifiedCommandId(pluginId, declaration.id)
    if (declaredCommands.has(key)) continue
    let keybinding = declaration.keybinding
    if (keybinding && CORE_DEFAULT_CHORDS.has(normalizeChord(keybinding))) {
      console.warn(
        `[plugin:${pluginId}] keybinding '${keybinding}' for command '${declaration.id}' collides with a core shortcut and was not bound`,
      )
      keybinding = undefined
    }
    declaredCommands.set(key, { pluginId, commandId: declaration.id, title: declaration.title, keybinding })
  }
}

/** Remove a plugin's declared commands and any handlers it registered */
export function removePluginCommands(pluginId: string): void {
  for (const [key, declared] of declaredCommands) {
    if (declared.pluginId === pluginId) declaredCommands.delete(key)
  }
  pluginCommandRegistry.unregisterPlugin(pluginId)
}

/** Register a handler from plugin code (`ctx.commands.register`) */
export function registerPluginCommand(
  pluginId: string,
  commandId: string,
  handler: PluginCommandHandler,
): PluginDisposable {
  return pluginCommandRegistry.register(pluginId, commandId, handler)
}

/**
 * Execute a plugin command by qualified id. Declared commands lazily
 * activate their plugin first; undeclared (code-only) commands must already
 * be registered. Rejects when no handler exists after activation — a
 * declared command whose plugin never registers it is a plugin bug.
 */
export async function executePluginCommand(qualifiedId: string, args?: unknown): Promise<unknown> {
  const declared = declaredCommands.get(qualifiedId)
  if (!pluginCommandRegistry.has(qualifiedId) && declared && activationHandler) {
    await activationHandler(declared.pluginId)
  }
  if (!pluginCommandRegistry.has(qualifiedId)) {
    throw new Error(
      declared
        ? `Plugin '${declared.pluginId}' did not register declared command '${qualifiedId}'`
        : `Unknown plugin command '${qualifiedId}'`,
    )
  }
  const result = await pluginCommandRegistry.execute(qualifiedId, args)
  const separator = qualifiedId.indexOf('.')
  pluginHostHooks.emit('command:executed', {
    pluginId: declared?.pluginId ?? qualifiedId.slice(0, separator),
    commandId: declared?.commandId ?? qualifiedId.slice(separator + 1),
  })
  return result
}

/** Snapshot of declared commands (Settings/introspection + tests) */
export function listDeclaredPluginCommands(): DeclaredCommand[] {
  return Array.from(declaredCommands.values())
}

// ============================================================
// Keybinding listener
// ============================================================

function handleKeyDown(e: KeyboardEvent): void {
  if (declaredCommands.size === 0) return
  for (const declared of declaredCommands.values()) {
    if (!declared.keybinding || !matchesHotkey(e, declared.keybinding)) continue
    const context = getKeybindingContext(e)
    if (context.inputFocus || context.menuOpen) return
    e.preventDefault()
    e.stopPropagation()
    const key = qualifiedCommandId(declared.pluginId, declared.commandId)
    void executePluginCommand(key).catch((error) => {
      console.warn(`[plugin:${declared.pluginId}] keybinding '${declared.keybinding}' failed:`, error)
    })
    return
  }
}

let keybindingsInstalled = false

/**
 * Install the window-level keybinding listener (idempotent; called once by
 * the runtime). Bubble phase — the core action registry's capture-phase
 * listener always sees (and can claim) the event first.
 */
export function initializePluginKeybindings(): void {
  if (keybindingsInstalled || typeof window === 'undefined') return
  keybindingsInstalled = true
  window.addEventListener('keydown', handleKeyDown, false)
}

/** TEST ONLY: reset module state between tests */
export function __resetPluginCommandsForTests(): void {
  declaredCommands.clear()
  for (const command of pluginCommandRegistry.list()) {
    pluginCommandRegistry.unregisterPlugin(command.pluginId)
  }
  activationHandler = null
}
