// Opening a file in the Editor mod, from any mod. The editor's whole public interface.
//
// A mod can't import another mod's code, so a mod that wants to open files in the Editor
// carries a copy of this file (Files Editor and Quick Open do). The protocol is just
// shared state and two app commands, so the copies never need to match exactly:
//
//   - If the focused tab already has an Editor pane: set shared "editor.open" to
//     { tab, file, root, machine, nonce } and focus that pane. The pane opens the file
//     in a new file tab (or switches to it when it's already open).
//   - Otherwise: pane.split {direction: "right", mod: "editor", props: {tab, file, root, machine}}.
//
// file: an absolute path. root: the folder paths are shown relative to (a repo root), or
// null. machine: a space's machine (null for this computer).

import { focused, panes, run, setShared, readTextFile, appHome } from "herdr";

export const OPEN_KEY = "editor.open";
export const EDITOR_MOD = "editor";

let installed = null;

/** Whether the Editor mod is installed (checked once, then cached). */
export async function editorInstalled() {
  if (installed === null) {
    installed = Boolean(await readTextFile(`${appHome()}/mods/${EDITOR_MOD}/mod.json`).catch(() => null));
  }
  return installed;
}

/** Opens `file` in the focused tab's Editor pane, making one beside `pane` if it has none. */
export function openInEditor({ file, root = null, machine = null, pane = null }) {
  const f = focused();
  const tab = f?.tab ?? null;
  const existing = panes().find((p) => p.mod === EDITOR_MOD && p.tab === tab);
  if (existing) {
    setShared(OPEN_KEY, { tab, file, root, machine, nonce: `${Date.now()}:${Math.random()}` });
    run("pane.focus", { pane: existing.pane });
    return;
  }
  const beside = pane ?? f?.pane ?? null;
  run("pane.split", { direction: "right", ...(beside ? { pane: beside } : {}), mod: EDITOR_MOD, props: { tab, file, root, machine } });
}
