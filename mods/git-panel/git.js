// Pure parsing for the Git panel: no Herdr imports, so tests run it in Node.

/**
 * `git status --porcelain=v2 --branch --show-stash -z --untracked-files=all`.
 * Returns the branch line data and three lists: staged, unstaged (incl. untracked) and conflicts.
 */
export function parseStatus(out) {
  const branch = { oid: null, head: null, upstream: null, ahead: 0, behind: 0, stashes: 0 };
  const staged = [], unstaged = [], conflicts = [];
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith("# ")) {
      const [, key, ...rest] = t.split(" "), value = rest.join(" ");
      if (key === "branch.oid") branch.oid = value === "(initial)" ? null : value;
      else if (key === "branch.head") branch.head = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") branch.upstream = value;
      else if (key === "branch.ab") { const m = /^\+(\d+) -(\d+)$/.exec(value); if (m) { branch.ahead = +m[1]; branch.behind = +m[2]; } }
      else if (key === "stash") branch.stashes = +value || 0;
      continue;
    }
    const kind = t[0];
    if (kind === "?") { unstaged.push({ path: t.slice(2), code: "U", untracked: true }); continue; }
    if (kind === "!") continue;
    if (kind === "1" || kind === "2") {
      // 1 XY sub mH mI mW hH hI path / 2 XY sub mH mI mW hH hI Xscore path\0orig
      const fields = t.split(" "), xy = fields[1], cut = kind === "1" ? 8 : 9;
      const path = fields.slice(cut).join(" "), orig = kind === "2" ? tokens[++i] : null;
      const x = xy[0], y = xy[1];
      if (x !== ".") staged.push({ path, orig: x === "R" || x === "C" ? orig : null, code: letter(x) });
      if (y !== ".") unstaged.push({ path, code: letter(y) });
      continue;
    }
    if (kind === "u") {
      const fields = t.split(" ");
      conflicts.push({ path: fields.slice(10).join(" "), code: "!", how: fields[1] });
    }
  }
  return { branch, staged, unstaged, conflicts };
}

// The letter shown beside a file: Added, Modified, Deleted, Renamed, Copied, Type change.
function letter(c) {
  return c === "A" ? "A" : c === "D" ? "D" : c === "R" ? "R" : c === "C" ? "C" : c === "T" ? "T" : "M";
}

/** `git diff --numstat -z` → { path: {add, del, binary} }. Renames come as "a\td\t\0old\0new". */
export function parseNumstat(out) {
  const stats = {}, tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i]);
    if (!m) continue;
    let path = m[3];
    if (path === "") { i += 2; path = tokens[i]; }
    stats[path] = { add: m[1] === "-" ? 0 : +m[1], del: m[2] === "-" ? 0 : +m[2], binary: m[1] === "-" };
  }
  return stats;
}

/** `git for-each-ref --format=%(refname)%00%(upstream:short)%00%(committerdate:relative)%00%(HEAD)` lines. */
export function parseBranches(out) {
  const local = [], remote = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [ref, upstream, when, head] = line.split("\0");
    if (ref.startsWith("refs/heads/")) local.push({ name: ref.slice(11), upstream: upstream || null, when, current: head === "*" });
    else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) remote.push({ name: ref.slice(13), when });
  }
  return { local, remote };
}

const SEP = "\x1f";
export const LOG_FORMAT = ["%H", "%h", "%s", "%an", "%cr", "%P"].join("%x1f");

/** `git log --format=LOG_FORMAT` → commits. */
export function parseLog(out) {
  return out.split("\n").filter(Boolean).map((line) => {
    const [sha, short, subject, author, when, parents] = line.split(SEP);
    return { sha, short, subject, author, when, merge: (parents ?? "").trim().split(" ").length > 1 };
  });
}

/** `git stash list --format=%gd%x1f%s%x1f%cr` → stashes. */
export function parseStashes(out) {
  return out.split("\n").filter(Boolean).map((line) => {
    const [ref, subject, when] = line.split(SEP);
    return { ref, subject, when };
  });
}

// Text draws a tab as nothing: pad each to the next 4-column stop.
export const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

/**
 * A unified diff (one or many files) → rows to draw and hunks to act on.
 * Rows: {kind: "file", text, path} | {kind: "@", text, hunk} | {kind: "+"|"-"|" ", old?, number?, text} | {kind: "", text}.
 * Hunks keep the exact patch text needed to apply just that hunk.
 */
export function parseDiff(text, { maxLines = 4000 } = {}) {
  const rows = [], hunks = [];
  const lines = text.replace(/\n$/, "").split("\n");
  let header = [], inHeader = false, file = null, hunk = null, old = 0, next = 0;
  const end = () => { if (hunk) { hunks.push(hunk); hunk = null; } };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      end();
      header = [line]; inHeader = true;
      const m = / b\/(.*)$/.exec(line);
      file = m ? m[1] : line.slice(11);
      if (rows.length < maxLines) rows.push({ kind: "file", text: file, path: file });
      continue;
    }
    if (inHeader && !line.startsWith("@@")) {
      header.push(line);
      const plus = /^\+\+\+ b\/(.*)$/.exec(line);
      if (plus) file = plus[1];
      if (/^Binary files /.test(line) && rows.length < maxLines) rows.push({ kind: "", text: "Binary file changed" });
      continue;
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      end(); inHeader = false;
      old = +m[1]; next = +m[2];
      hunk = { index: hunks.length, file, header: header.join("\n"), lines: [line] };
      if (rows.length < maxLines) rows.push({ kind: "@", text: line, hunk: hunk.index });
      continue;
    }
    if (!hunk) { if (rows.length < maxLines && line) rows.push({ kind: "", text: line }); continue; }
    hunk.lines.push(line);
    if (rows.length >= maxLines) continue;
    const kind = line[0], body = untab(line.slice(1)) || " ";
    if (kind === "-") rows.push({ kind, old: old++, text: body });
    else if (kind === "+") rows.push({ kind, number: next++, text: body });
    else if (kind === " ") { rows.push({ kind, old: old++, number: next++, text: body }); }
    else rows.push({ kind: "", text: line });   // "\ No newline at end of file"
  }
  end();
  return { rows, hunks, truncated: lines.length > maxLines };
}

/** The patch that applies one hunk on its own (`git apply [--cached] [--reverse] -`). */
export function hunkPatch(hunk) {
  return `${hunk.header}\n${hunk.lines.join("\n")}\n`;
}

/** A new file's text as an all-added diff, for untracked files. */
export function addedDiff(path, text, maxLines = 4000) {
  const lines = text.replace(/\n$/, "").split("\n");
  const rows = [{ kind: "file", text: path, path }, { kind: "@", text: `@@ -0,0 +1,${lines.length} @@ new file` }];
  lines.slice(0, maxLines).forEach((l, i) => rows.push({ kind: "+", number: i + 1, text: untab(l) || " " }));
  return { rows, hunks: [], truncated: lines.length > maxLines };
}

/** "src/a/b.ts" → { dir: "src/a/", name: "b.ts" }. */
export function splitPath(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

/** A branch name git would accept (the common rules of `git check-ref-format --branch`). */
export function validBranch(name) {
  return Boolean(name) && !/[\s~^:?*\[\\]|\.\.|@\{|\/\/|^[-\/.]|[\/.]$|\.lock$/.test(name) && name !== "@";
}

/** What the Commit button does: commit staged, or stage everything first when nothing is staged. */
export function commitPlan({ staged, unstaged, amend, message }) {
  if (!message.trim() && !amend) return { ok: false, why: "Write a message" };
  if (staged > 0) return { ok: true, stageAll: false, label: amend ? "Amend" : "Commit" };
  if (unstaged > 0) return { ok: true, stageAll: true, label: amend ? "Amend all" : "Commit all" };
  if (amend) return { ok: true, stageAll: false, label: "Amend" };
  return { ok: false, why: "Nothing to commit" };
}
