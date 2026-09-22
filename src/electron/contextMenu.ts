/**
 * Right-click editing in every window.
 *
 * An Electron app gets ⌘C and ⌘V from the application menu's Edit roles, but
 * nothing at all from a right-click: there is no default context menu, so a
 * text field looks broken to anyone who reaches for the mouse. This is the
 * whole of that menu, installed once for every `webContents` the app ever
 * creates — the workbench, the palette, the preferences window — so a new
 * window cannot forget it.
 *
 * Roles rather than hand-rolled clipboard calls: `cut`/`copy`/`paste` applied
 * to the focused editable element are exactly what the OS means by them, and
 * they respect the field's own undo stack. `editFlags` is the renderer telling
 * us what that element can actually do, which is why the items grey out
 * correctly in a read-only field.
 *
 * Two shapes, decided by the params:
 * - an editable field gets the full set;
 * - anything else with a selection gets Copy alone, which is how the
 *   conversation transcript becomes copyable without pretending to be a field.
 */

import { Menu, type MenuItemConstructorOptions, type WebContents, app, clipboard } from 'electron';

export function installContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const { isEditable, editFlags, selectionText, misspelledWord, dictionarySuggestions } = params;
    const hasSelection = selectionText.trim().length > 0;
    const items: MenuItemConstructorOptions[] = [];

    // Spelling first, where every macOS app puts it: the corrections are the
    // reason the menu was opened when there is a red underline under the word.
    if (isEditable && misspelledWord) {
      for (const word of dictionarySuggestions.slice(0, 5)) {
        items.push({ label: word, click: () => contents.replaceMisspelling(word) });
      }
      if (dictionarySuggestions.length === 0) {
        items.push({ label: 'No spelling suggestions', enabled: false });
      }
      items.push({
        label: 'Add to Dictionary',
        click: () => contents.session.addWordToSpellCheckerDictionary(misspelledWord),
      });
      items.push({ type: 'separator' });
    }

    if (isEditable) {
      items.push(
        { role: 'undo', enabled: editFlags.canUndo },
        { role: 'redo', enabled: editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: editFlags.canCut },
        { role: 'copy', enabled: editFlags.canCopy },
        { role: 'paste', enabled: editFlags.canPaste },
        // Paste as plain text: pasting a styled fragment into a field that is
        // going to be sent to a CLI as text is never what was meant.
        {
          label: 'Paste and Match Style',
          enabled: editFlags.canPaste,
          click: () => contents.pasteAndMatchStyle(),
        },
        { type: 'separator' },
        { role: 'selectAll', enabled: editFlags.canSelectAll },
      );
    } else if (hasSelection) {
      items.push({ role: 'copy' }, { type: 'separator' }, { role: 'selectAll' });
    } else {
      return; // nothing to offer; an empty menu is worse than none
    }

    if (params.linkURL) {
      items.push(
        { type: 'separator' },
        { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) },
      );
    }

    // No `window`: the default is the focused one, which is the window the
    // click just happened in — and is also right for the palette and
    // preferences windows, which are children rather than the workbench.
    Menu.buildFromTemplate(items).popup();
  });
}

/** Install it on every renderer this process ever makes, past and future. */
export function installContextMenuEverywhere(): void {
  app.on('web-contents-created', (_event, contents) => installContextMenu(contents));
}
