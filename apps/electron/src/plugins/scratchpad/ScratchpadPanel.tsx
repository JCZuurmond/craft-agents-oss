/**
 * Scratchpad plugin — panel UI
 *
 * A plain-text note that autosaves on every edit. Built entirely on the
 * plugin API: content persists through the plugin's scoped ctx.storage
 * namespace, so it survives pane close/reopen, live disable/enable from
 * Settings, and app restarts.
 */

import { useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { PluginContext, PluginPanelProps } from '../../renderer/plugins/types'

export const NOTE_STORAGE_KEY = 'note'

export interface NoteStats {
  chars: number
  words: number
  lines: number
}

/** Footer stats for the current note (pure; unit-tested) */
export function noteStats(text: string): NoteStats {
  const trimmed = text.trim()
  return {
    chars: text.length,
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    lines: text ? text.split('\n').length : 0,
  }
}

export function createScratchpadPanel(ctx: PluginContext) {
  return function ScratchpadPanel(_props: PluginPanelProps) {
    const [text, setText] = useState<string>(() => ctx.storage.get(NOTE_STORAGE_KEY, ''))
    // 'restored' on mount when storage had content; 'saved' after any edit
    const [saveState, setSaveState] = useState<'empty' | 'restored' | 'saved'>(
      () => (ctx.storage.get(NOTE_STORAGE_KEY, '') ? 'restored' : 'empty'),
    )
    const textareaRef = useRef<HTMLTextAreaElement | null>(null)

    const onChange = (value: string) => {
      setText(value)
      ctx.storage.set(NOTE_STORAGE_KEY, value)
      setSaveState('saved')
    }

    const onClear = () => {
      ctx.storage.remove(NOTE_STORAGE_KEY)
      setText('')
      setSaveState('empty')
      textareaRef.current?.focus()
    }

    const stats = noteStats(text)
    const statusText =
      saveState === 'saved' ? 'Saved ✓'
      : saveState === 'restored' ? 'Restored from plugin storage'
      : 'Autosaves as you type'

    return (
      <div className="h-full flex flex-col">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          placeholder={'Jot anything down — meeting notes, prompts to retry, follow-ups.\n\nEverything autosaves to this plugin’s scoped storage.'}
          aria-label="Scratchpad note"
          spellCheck={false}
          className="flex-1 min-h-0 w-full resize-none px-4 py-3 text-[13px] leading-relaxed bg-transparent text-foreground placeholder:text-muted-foreground/60 outline-none font-mono"
        />
        <div className="shrink-0 flex items-center gap-2 px-3 h-8 border-t border-border/50 text-[11px] text-muted-foreground">
          <span data-testid="scratchpad-status">{statusText}</span>
          <span className="flex-1" />
          <span data-testid="scratchpad-stats">
            {`${stats.words} words · ${stats.chars} chars`}
          </span>
          <button
            onClick={onClear}
            disabled={text.length === 0}
            aria-label="Clear note"
            className="p-1 rounded-md text-muted-foreground enabled:hover:text-foreground enabled:hover:bg-foreground/5 disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    )
  }
}
