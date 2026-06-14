/**
 * Right-click context menu for the Veronum window.
 *
 * Electron ships with NO context menu — right-click does nothing until
 * you build one. This wires native Cut / Copy / Paste / Select All (plus
 * spelling fixes inside text fields and link actions) so the composer and
 * the chat behave like every other macOS app. Keyboard shortcuts
 * (Cmd+C/V/X/A) already work via the default application menu; this adds
 * the mouse path the user expects when they right-click.
 */
import { Menu, clipboard, shell, BrowserWindow } from "electron";

const MAX_SUGGESTIONS = 5;

/** Build the menu for a single right-click, shaped by what was clicked:
 *  an editable field, a text selection, or plain page chrome. Returns a
 *  fresh template every call — never mutates shared state. */
function buildTemplate(
  win: BrowserWindow,
  params: Electron.ContextMenuParams,
): Electron.MenuItemConstructorOptions[] {
  const { editFlags, isEditable, dictionarySuggestions, linkURL } = params;
  const hasSelection = params.selectionText.trim().length > 0;
  const items: Electron.MenuItemConstructorOptions[] = [];

  // A right-clicked link → open in the real browser (the app never spawns
  // popup windows) or copy its address.
  if (linkURL) {
    items.push(
      { label: "Open Link in Browser", click: () => void shell.openExternal(linkURL) },
      { label: "Copy Link Address", click: () => clipboard.writeText(linkURL) },
      { type: "separator" },
    );
  }

  // Spelling suggestions for a misspelled word under the cursor.
  if (isEditable && dictionarySuggestions.length > 0) {
    for (const word of dictionarySuggestions.slice(0, MAX_SUGGESTIONS)) {
      items.push({ label: word, click: () => win.webContents.replaceMisspelling(word) });
    }
    items.push({ type: "separator" });
  }

  if (isEditable) {
    // Composer / any text input — the full editing surface.
    items.push(
      { role: "undo", enabled: editFlags.canUndo },
      { role: "redo", enabled: editFlags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: editFlags.canCut },
      { role: "copy", enabled: editFlags.canCopy },
      { role: "paste", enabled: editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: editFlags.canSelectAll },
    );
  } else if (hasSelection) {
    // Highlighted chat text — copy it (and offer Select All).
    items.push({ role: "copy" }, { type: "separator" }, { role: "selectAll" });
  } else {
    // Empty area — at least offer Select All.
    items.push({ role: "selectAll" });
  }

  return items;
}

/** Attach the right-click menu to a window's web contents. */
export function installContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    const template = buildTemplate(win, params);
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}
