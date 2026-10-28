import { describe, expect, it } from 'vitest'
import { isEditableTarget, shortcutAction } from './keyboardShortcuts'

describe('shortcut boundaries', () => {
  it('leaves browser commands, text undo, and unassigned modified keys alone', () => {
    for (const key of ['p', 'z', 'w', 't', '1']) {
      expect(shortcutAction(new KeyboardEvent('keydown', { key, metaKey: true }))).toBeNull()
      expect(shortcutAction(new KeyboardEvent('keydown', { key, ctrlKey: true }))).toBeNull()
    }
    expect(shortcutAction(new KeyboardEvent('keydown', { key: 's', altKey: true }))).toBeNull()
    expect(shortcutAction(new KeyboardEvent('keydown', { key: 'D', shiftKey: true }))).toBeNull()
    expect(
      shortcutAction(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, altKey: true })),
    ).toBeNull()
  })

  it('ignores composition and keys already handled by another control', () => {
    expect(shortcutAction(new KeyboardEvent('keydown', { key: 'c', isComposing: true }))).toBeNull()
    const event = new KeyboardEvent('keydown', { key: 'c', cancelable: true })
    event.preventDefault()
    expect(shortcutAction(event)).toBeNull()
  })

  it('recognizes native and custom editing controls, including nested editable elements', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isEditableTarget(document.createElement(tag))).toBe(true)
    }
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', '')
    const nested = document.createElement('span')
    editor.append(nested)
    expect(isEditableTarget(nested)).toBe(true)
    editor.setAttribute('contenteditable', 'false')
    expect(isEditableTarget(nested)).toBe(false)
    editor.setAttribute('role', 'textbox')
    expect(isEditableTarget(nested)).toBe(true)
    expect(isEditableTarget(document.createElement('button'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
