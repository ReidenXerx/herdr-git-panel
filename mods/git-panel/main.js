// Git panel for Herdr: a replacement for the built-in Changes panel.
// Staged and unstaged changes, stage/unstage/discard per file and per hunk, branches,
// fetch/pull/push, stashes, recent commits, amend, and an optional Claude-written message.
// It follows the focused pane's folder, like Changes, and works on other machines too.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, notify, nextCommand, checking } from "herdr";
import { parseStatus, parseNumstat, parseBranches, parseLog, parseStashes, parseDiff, hunkPatch, addedDiff, splitPath, validBranch, commitPlan, LOG_FORMAT } from "./git.js";
import { openInEditor, editorInstalled } from "./open.js";

const ICON = (name) => `mods/git-panel/icons/${name}.svg`;
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie): the folder
// watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const DIFF = ["--no-ext-diff", "--no-textconv", "--no-color"];
const ROW = 26, DROW = 20, LIMIT = 500;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// The focused terminal's folder. A focused mod pane (the Editor, this panel as a pane) has no
// folder of its own, so it keeps the last one rather than jumping to the space's folder.
let last = null;
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane?.mod && !pane.cwd && last && last.space === space?.id) return last;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  last = { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id ?? null };
  return last;
}
const key = () => { const { cwd, on } = location(); return JSON.stringify({ cwd, on }); };

// Network commands never stop to ask for a password: they fail instead, and say why.
const net = (args, timeout = 180000) => ({ cmd: "env", args: ["GIT_TERMINAL_PROMPT=0", "git", ...args], timeout });
// `git apply` reads the patch from stdin, so this works on another machine too (no temp file).
const apply = (patch, flags) => ({ cmd: "sh", args: ["-c", 'p=$1; shift; printf "%s" "$p" | git apply --whitespace=nowarn "$@" -', "sh", patch, ...flags] });

const PROMPT = `Write a git commit message for the changes below.
Match the style of this repository's recent subjects (listed first) when they have one.
Output only the message: a subject line under 72 characters, then optionally a blank line and a short body. No code fences, no quotes, no preamble.`;

function store(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }

export default class GitPanel extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.data = null; this.sel = null; this.diff = null; this.picker = null;
    this.confirm = null; this.busy = null; this.error = null; this.hover = null; this.size = null;
    this.amend = false; this.amendText = null; this.msg = ""; this.filterText = "";
    this.collapsed = store("collapsed", { stashes: true });
    this.editor = false;
    this.message = TextareaState.new({ placeholder: "Message (⌘Enter to commit)" });
    this.message.set_auto_grow(1, 8);
    this.message.on("change", (_e, cx) => {
      const had = Boolean(this.msg.trim());
      this.msg = this.message.value();
      if (had !== Boolean(this.msg.trim())) cx.notify();
    });
    this.message.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.message.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.filter = InputState.new({ placeholder: "Switch to or create a branch" });
    this.filter.on("change", (_e, cx) => { this.filterText = this.filter.value(); cx.notify(); });
    this.filter.on("submit", (_e, cx) => { const first = this.options()[0]; if (first) this.choose(first, cx); });
    if (checking()) return;
    cx.spawn(async (cx) => { this.editor = await editorInstalled(); cx.notify(); });
    this.refresh(cx);
    cx.timer.every(15000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "commit") this.commit(cx, false);
        else if (c === "commit-push") this.commit(cx, true);
        else if (c === "stage-all") this.stageAll(cx);
        else if (c === "fetch") this.sync("fetch", cx);
        else if (c === "pull") this.sync("pull", cx);
        else if (c === "push") this.sync("push", cx);
        else if (c === "branch") this.openPicker(cx);
        else if (c === "message") this.message.focus();
        else this.refresh(cx);
        cx.notify();
      }
    });
  }

  // ---------- reading ----------

  read(args) { return exec("git", [...READ, ...args], { cwd: this.root, on: this.on }); }

  reset(context) {
    this.context = context; this.root = null; this.on = null; this.data = null; this.notRepo = false;
    this.sel = null; this.diff = null; this.picker = null; this.confirm = null; this.error = null;
    this.watched = null; this.amend = false;
    if (this.msg) { this.msg = ""; this.message.set_value(""); }
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) this.reset(context);
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.root) {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
          if (key() !== context) return;
          if (top.code !== 0) { this.notRepo = true; this.cwd = cwd; this.on = on; return; }
          this.root = top.stdout.trim(); this.on = on; this.notRepo = false;
        }
        const [status, unstagedStat, stagedStat, log, stashes, remotes, op] = await Promise.all([
          this.read(["status", "--porcelain=v2", "--branch", "--show-stash", "-z", "--untracked-files=all"]),
          this.read(["diff", "--numstat", "-z"]),
          this.read(["diff", "--cached", "--numstat", "-z", "-M"]),
          this.read(["log", "-n", "40", `--format=${LOG_FORMAT}`]),
          this.read(["stash", "list", "--format=%gd%x1f%s%x1f%cr"]),
          this.read(["remote"]),
          exec("sh", ["-c", 'g=$(git rev-parse --git-dir) || exit 0; for f in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do [ -e "$g/$f" ] && echo "$f"; done; exit 0'], { cwd: this.root, on: this.on }),
        ]);
        if (key() !== context) return;
        if (status.code !== 0) throw new Error(status.stderr.trim());
        const s = parseStatus(status.stdout);
        const ops = op.stdout.split("\n").filter(Boolean);
        this.data = {
          ...s,
          stats: { unstaged: parseNumstat(unstagedStat.stdout), staged: parseNumstat(stagedStat.stdout) },
          log: log.code === 0 ? parseLog(log.stdout) : [],
          stashes: stashes.code === 0 ? parseStashes(stashes.stdout) : [],
          remotes: remotes.stdout.split("\n").filter(Boolean),
          op: ops.includes("rebase-merge") || ops.includes("rebase-apply") ? "rebase" : ops.includes("MERGE_HEAD") ? "merge" : ops.includes("CHERRY_PICK_HEAD") ? "cherry-pick" : ops.includes("REVERT_HEAD") ? "revert" : null,
        };
        this.watch(this.root, cx);
        await this.followSelection(context);
      } catch (e) { if (key() === context) this.error = { title: "Couldn't read the repository", text: String(e?.message ?? e) }; }
      finally {
        this.loading = false; cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  /** After a refresh: keep showing the selected file, in whichever list it's in now. */
  async followSelection(context) {
    const sel = this.sel;
    if (!sel || !["staged", "unstaged", "untracked", "conflict"].includes(sel.area)) return;
    const where = this.find(sel.path);
    const same = where.find((w) => w.area === sel.area) ?? where[0];
    if (!same) { this.sel = null; this.diff = null; return; }
    this.sel = { ...sel, area: same.area, orig: same.orig ?? null };
    await this.loadDiff(this.sel, context);
  }

  find(path) {
    const d = this.data, out = [];
    if (!d) return out;
    for (const f of d.conflicts) if (f.path === path) out.push({ area: "conflict", ...f });
    for (const f of d.unstaged) if (f.path === path) out.push({ area: f.untracked ? "untracked" : "unstaged", ...f });
    for (const f of d.staged) if (f.path === path) out.push({ area: "staged", ...f });
    return out;
  }

  async loadDiff(sel, context) {
    let parsed;
    try {
      if (sel.area === "untracked") {
        const text = await readTextFile(`${this.root}/${sel.path}`, { on: this.on }).catch(() => null);
        parsed = text === null ? note("Can't show this file (too large or unreadable)")
          : text.includes("\0") ? note("Binary file") : addedDiff(sel.path, text);
      } else {
        const args = sel.area === "staged" ? ["diff", "--cached", ...DIFF, "-M", "--", sel.path, ...(sel.orig ? [sel.orig] : [])]
          : sel.area === "commit" ? ["show", ...DIFF, "-M", "--format=", sel.ref]
          : sel.area === "stash" ? ["stash", "show", "-p", ...DIFF, "--include-untracked", sel.ref]
          : ["diff", ...DIFF, "--", sel.path];
        const r = await this.read(args);
        if (r.code !== 0) throw new Error(r.stderr.trim());
        parsed = parseDiff(r.stdout);
        if (!parsed.rows.length) parsed = note(sel.area === "staged" || sel.area === "unstaged" ? "No text changes (mode or whitespace only)" : "No changes");
      }
    } catch (e) { parsed = note(`Can't show this diff: ${e?.message ?? e}`); }
    if (key() !== context || this.sel !== sel && !(this.sel && this.sel.path === sel.path && this.sel.area === sel.area && this.sel.ref === sel.ref)) return;
    parsed.width = Math.max(300, ...parsed.rows.slice(0, 4000).map((r) => (r.text.length + 1) * 7 + 90));
    this.diff = parsed;
  }

  select(sel, cx) {
    const same = this.sel && this.sel.area === sel.area && this.sel.path === sel.path && this.sel.ref === sel.ref;
    this.confirm = null;
    if (same) { this.sel = null; this.diff = null; cx.notify(); return; }
    this.sel = sel; this.diff = null;
    const context = this.context;
    cx.spawn(async (cx) => { await this.loadDiff(sel, context); cx.notify(); });
    cx.notify();
  }

  // ---------- acting ----------

  /** Runs steps in order: git argument arrays, {cmd, args, timeout}, or async functions. */
  act(label, steps, cx, { done, success } = {}) {
    if (this.busy || !this.root) return;
    const context = this.context, root = this.root, on = this.on;
    this.busy = label; this.error = null; this.confirm = null;
    cx.spawn(async (cx) => {
      try {
        for (const step of steps) {
          if (typeof step === "function") { await step(); continue; }
          const { cmd, args, timeout } = Array.isArray(step) ? { cmd: "git", args: step } : step;
          const r = await exec(cmd, args, { cwd: root, on, timeout: timeout ?? 120000 });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `${cmd} exited with ${r.code}`);
        }
        if (key() === context) done?.();
        if (success) notify({ title: success, level: "success", timeout: 3000 });
      } catch (e) {
        if (key() === context) this.error = { title: `${label} failed`, text: String(e?.message ?? e) };
      } finally {
        this.busy = null; this.refresh(cx); cx.notify();
      }
    });
    cx.notify();
  }

  ask(id, text, yes, run, cx) { this.confirm = { id, text, yes, run }; cx.notify(); }

  stage(paths, cx) { this.act("Stage", [["add", "--", ...paths]], cx); }
  unstage(files, cx) {
    const paths = files.flatMap((f) => (f.orig ? [f.path, f.orig] : [f.path]));
    this.act("Unstage", [this.data?.branch.oid ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-q", "--", ...paths]], cx);
  }
  discard(file, cx) {
    this.act("Discard", [file.untracked ? ["clean", "-f", "-q", "--", file.path] : ["restore", "--worktree", "--", file.path]], cx);
  }
  stageAll(cx) { this.act("Stage all", [["add", "-A"]], cx); }
  unstageAll(cx) { this.act("Unstage all", [this.data?.branch.oid ? ["reset", "-q"] : ["rm", "--cached", "-r", "-q", "."]], cx); }
  discardAll(cx) {
    const d = this.data, untracked = d.unstaged.filter((f) => f.untracked).map((f) => f.path);
    const steps = [];
    if (d.unstaged.some((f) => !f.untracked)) steps.push(["restore", "--worktree", "--", "."]);
    for (let i = 0; i < untracked.length; i += 200) steps.push(["clean", "-f", "-q", "--", ...untracked.slice(i, i + 200)]);
    this.act("Discard all", steps, cx);
  }

  hunk(index, how, cx) {
    const h = this.diff?.hunks[index];
    if (!h) return;
    const flags = how === "stage" ? ["--cached"] : how === "unstage" ? ["--cached", "--reverse"] : ["--reverse"];
    this.act(how === "stage" ? "Stage hunk" : how === "unstage" ? "Unstage hunk" : "Discard hunk", [apply(hunkPatch(h), flags)], cx);
  }

  commit(cx, push) {
    const d = this.data;
    if (!d || this.busy) return;
    const plan = commitPlan({ staged: d.staged.length, unstaged: d.unstaged.length, amend: this.amend, message: this.msg });
    if (!plan.ok) { this.error = { title: "Not committed", text: plan.why }; cx.notify(); return; }
    const msg = this.msg.trim(), steps = [];
    if (plan.stageAll) steps.push(["add", "-A"]);
    steps.push({ cmd: "git", args: ["commit", ...(this.amend ? ["--amend"] : []), ...(msg ? ["-m", msg] : ["--no-edit"])], timeout: 300000 });
    if (push) steps.push(this.pushStep());
    this.act(push ? "Commit & push" : plan.label, steps, cx, {
      done: () => { this.msg = ""; this.message.set_value(""); this.amend = false; this.amendText = null; },
      success: push ? "Committed and pushed" : null,
    });
  }

  pushStep() {
    const d = this.data;
    if (d.branch.upstream) return net(["push"]);
    const remote = d.remotes.includes("origin") ? "origin" : d.remotes[0];
    return net(["push", "-u", remote, "HEAD"]);
  }

  sync(what, cx) {
    const d = this.data;
    if (!d) return;
    if (what === "fetch") this.act("Fetch", [net(["fetch", "--all", "--prune"])], cx);
    else if (what === "pull") {
      if (!d.branch.upstream) { this.error = { title: "Can't pull", text: "This branch has no upstream. Push it first." }; cx.notify(); return; }
      this.act("Pull", [net(["pull", "--no-edit"])], cx, { success: "Pulled" });
    } else {
      if (!d.remotes.length) { this.error = { title: "Can't push", text: "This repository has no remote." }; cx.notify(); return; }
      if (!d.branch.head) { this.error = { title: "Can't push", text: "HEAD is detached. Switch to a branch first." }; cx.notify(); return; }
      this.act(d.branch.upstream ? "Push" : "Publish branch", [this.pushStep()], cx, { success: d.branch.upstream ? "Pushed" : `Published ${d.branch.head}` });
    }
  }

  toggleAmend(cx) {
    this.amend = !this.amend;
    if (this.amend && !this.msg.trim()) {
      cx.spawn(async (cx) => {
        const r = await this.read(["log", "-1", "--format=%B"]);
        if (r.code === 0 && this.amend && !this.msg.trim()) {
          this.amendText = r.stdout.trim(); this.msg = this.amendText; this.message.set_value(this.amendText);
        }
        cx.notify();
      });
    } else if (!this.amend && this.amendText !== null && this.msg === this.amendText) {
      this.msg = ""; this.message.set_value(""); this.amendText = null;
    }
    cx.notify();
  }

  generate(cx) {
    if (this.writing || !this.root) return;
    this.writing = true; this.error = null;
    const context = this.context;
    const script = `
      recent=$(git log -12 --format=%s 2>/dev/null)
      d=$(git diff --cached --no-color --no-ext-diff | head -c 60000)
      if [ -z "$d" ]; then d=$(git diff --no-color --no-ext-diff | head -c 60000); fi
      new=$(git ls-files --others --exclude-standard | head -50)
      printf '%s\\n\\nRecent subjects:\\n%s\\n\\nNew files:\\n%s\\n\\nDiff:\\n%s\\n' "$1" "$recent" "$new" "$d" | claude -p --model haiku`;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", script, "sh", PROMPT], { cwd: this.root, on: this.on, timeout: 120000 });
        if (key() !== context) return;
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "claude exited with an error");
        const text = r.stdout.trim().replace(/^```\w*\n?|\n?```$/g, "").trim();
        if (text) { this.msg = text; this.message.set_value(text); }
      } catch (e) {
        if (key() === context) this.error = { title: "Couldn't write a message", text: `${e?.message ?? e}\nThis uses the claude CLI (claude -p --model haiku).` };
      } finally { this.writing = false; cx.notify(); }
    });
    cx.notify();
  }

  conflict(file, how, cx) {
    const steps = how === "resolved" ? [["add", "--", file.path]] : [["checkout", `--${how}`, "--", file.path], ["add", "--", file.path]];
    this.act(how === "resolved" ? "Mark resolved" : `Take ${how}`, steps, cx);
  }

  operation(how, cx) {
    const op = this.data?.op;
    if (!op) return;
    this.act(`${op[0].toUpperCase()}${op.slice(1)} ${how}`, [["-c", "core.editor=true", op, `--${how}`]], cx);
  }

  undoCommit(cx) {
    let message = "";
    this.act("Undo commit", [
      async () => { const r = await this.read(["log", "-1", "--format=%B"]); message = r.stdout.trim(); },
      ["reset", "--soft", "HEAD~1"],
    ], cx, { done: () => { if (!this.msg.trim() && message) { this.msg = message; this.message.set_value(message); } } });
  }

  stash(how, ref, cx) {
    if (how === "push") this.act("Stash", [["stash", "push", "--include-untracked"]], cx, { success: "Changes stashed" });
    else this.act(how === "apply" ? "Apply stash" : how === "pop" ? "Pop stash" : "Drop stash", [["stash", how, ref]], cx);
    if (how !== "apply" && this.sel?.area === "stash") { this.sel = null; this.diff = null; }
  }

  open(path) {
    openInEditor({ file: `${this.root}/${path}`, root: this.root, machine: this.on });
  }

  // ---------- branches ----------

  openPicker(cx) {
    if (!this.root) return;
    if (this.picker) { this.picker = null; cx.notify(); return; }
    this.picker = { local: [], remote: [], loading: true };
    this.filterText = ""; this.filter.set_value(""); this.filter.focus();
    cx.spawn(async (cx) => {
      const r = await this.read(["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(upstream:short)%00%(committerdate:relative)%00%(HEAD)", "refs/heads", "refs/remotes"]);
      if (this.picker) this.picker = { ...parseBranches(r.stdout), loading: false };
      cx.notify();
    });
    cx.notify();
  }

  options() {
    const p = this.picker;
    if (!p) return [];
    const raw = this.filterText.trim(), f = raw.toLowerCase(), match = (n) => !f || n.toLowerCase().includes(f);
    const out = [];
    if (raw && validBranch(raw) && !p.local.some((b) => b.name === raw)) out.push({ kind: "create", name: raw });
    for (const b of p.local) if (match(b.name)) out.push({ kind: "local", ...b });
    for (const b of p.remote) {
      const tail = b.name.slice(b.name.indexOf("/") + 1);
      if (match(b.name) && !p.local.some((l) => l.name === tail)) out.push({ kind: "remote", ...b, tail });
    }
    return out.slice(0, 200);
  }

  choose(o, cx) {
    this.picker = null;
    if (o.kind === "local" && o.current) { cx.notify(); return; }
    const args = o.kind === "create" ? ["switch", "-c", o.name] : o.kind === "remote" ? ["switch", "--track", o.name] : ["switch", o.name];
    this.act(o.kind === "create" ? `Create ${o.name}` : `Switch to ${o.kind === "remote" ? o.tail : o.name}`, [args], cx);
  }

  // ---------- drawing ----------

  icon(id, name, tip, onClick, t, opts = {}) {
    const off = Boolean(opts.disabled || this.busy && !opts.always);
    return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(opts.color ?? t.muted).tooltip(tip)
      .when(!off, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(opts.color ?? t.foreground)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
      .when(off, (e) => e.opacity(0.4))
      .child(svg(ICON(name)).size(opts.size ?? 14));
  }

  button(id, label, onClick, t, { kind = "plain", disabled = false, tip } = {}) {
    const off = disabled || Boolean(this.busy);
    const bg = kind === "primary" ? (off ? t.raised : t.solid) : kind === "danger" ? t.ansi1 + "22" : t.raised;
    const fg = kind === "primary" ? (off ? t.dim : t.solid_foreground) : kind === "danger" ? t.ansi1 : t.foreground;
    return div().id(id).h(24).px(9).flex_none().flex().items_center().rounded(6).bg(bg).text_color(fg).text_size(11.5)
      .when(Boolean(tip), (e) => e.tooltip(tip))
      .when(!off, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
      .child(label);
  }

  confirmRow(c, t, height = ROW) {
    return h_flex().h(height).flex_none().px(8).gap(6).items_center().rounded(6).bg(t.ansi1 + "14")
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(c.text))
      .child(this.button(`${c.id}-no`, "Cancel", (cx) => { this.confirm = null; cx.notify(); }, t))
      .child(this.button(`${c.id}-yes`, c.yes, (cx) => { this.confirm = null; c.run(cx); }, t, { kind: "danger" }));
  }

  header(t) {
    const d = this.data, b = d?.branch;
    const name = !d ? (this.notRepo ? "No repository" : "Git") : b.head ?? (b.oid ? `detached at ${b.oid.slice(0, 7)}` : "no commits");
    const busy = this.busy || this.writing;
    return h_flex().h(40).flex_none().px(8).gap(2).items_center().border_b(1).border_color(t.border)
      .child(h_flex().id("gp-branch").h(28).min_w(0).px(6).gap(6).items_center().rounded(6)
        .when(Boolean(d), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openPicker(cx)).tooltip("Switch or create a branch"))
        .child(svg(ICON("branch")).size(14).text_color(t.muted))
        .child(div().min_w(0).truncate().font_semibold().text_size(13).child(name))
        .when(Boolean(d), (e) => e.child(svg(ICON("chevron-down")).size(11).text_color(t.dim))))
      .child(div().flex_1())
      .when(Boolean(busy), (e) => e.child(h_flex().min_w(0).gap(5).px(4).items_center().text_size(11).text_color(t.dim)
        .child(div().frames(SPIN, 90).child(SPIN[0])).child(div().truncate().child(this.writing ? "Writing message…" : `${this.busy}…`))))
      .when(Boolean(d) && !busy, (e) => e
        .child(this.icon("gp-fetch", "fetch", "Fetch from all remotes", (cx) => this.sync("fetch", cx), t, { disabled: !d.remotes.length }))
        .child(this.counted("gp-pull", "pull", b.behind, b.upstream ? `Pull from ${b.upstream}` : "No upstream to pull from", (cx) => this.sync("pull", cx), t, !b.upstream))
        .child(this.counted("gp-push", "push", b.ahead, !d.remotes.length ? "No remote" : b.upstream ? `Push to ${b.upstream}` : "Publish this branch", (cx) => this.sync("push", cx), t, !d.remotes.length || !b.head, !b.upstream && d.remotes.length > 0)));
  }

  counted(id, icon, n, tip, onClick, t, disabled, publish) {
    return h_flex().id(id).h(24).px(5).gap(3).flex_none().items_center().rounded(5).tooltip(tip)
      .text_color(n > 0 || publish ? t.foreground : t.muted).text_size(11)
      .when(!disabled && !this.busy, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
      .when(disabled, (e) => e.opacity(0.4))
      .child(svg(ICON(icon)).size(14))
      .when(n > 0, (e) => e.child(String(n)))
      .when(Boolean(publish), (e) => e.child("Publish"));
  }

  picker_(t) {
    const p = this.picker, opts = this.options();
    return v_flex().id("gp-picker").absolute().top(38).left(8).right(8).max_h(340).rounded(8).border_1().border_color(t.input)
      .bg(t.popover).overflow_hidden().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().h(34).flex_none().px(10).flex().items_center().border_b(1).border_color(t.border).child(Input.new(this.filter).w_full().text_size(12.5)))
      .child(v_flex().id("gp-picker-list").max_h(300).overflow_y_scrollbar().p(4)
        .when(p.loading, (e) => e.child(div().p(8).text_size(12).text_color(t.dim).child("Loading branches…")))
        .when(!p.loading && !opts.length, (e) => e.child(div().p(8).text_size(12).text_color(t.dim).child(this.filterText.trim() ? "Not a valid branch name" : "No branches")))
        .children(opts.map((o, i) => h_flex().id(`gp-opt-${i}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .when(i === 0 && Boolean(this.filterText.trim()), (e) => e.bg(t.selected))
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.choose(o, cx))
          .child(svg(ICON(o.kind === "create" ? "plus" : o.kind === "local" && o.current ? "check" : "branch")).size(13).text_color(o.kind === "remote" ? t.dim : t.muted))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(o.kind === "remote" ? t.muted : t.foreground)
            .child(o.kind === "create" ? `Create branch “${o.name}”` : o.name))
          .when(Boolean(o.when) && o.kind !== "create", (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(o.when))))));
  }

  banners(t) {
    const d = this.data, out = [];
    if (this.error) {
      out.push(h_flex().flex_none().mx(8).mt(8).p(8).gap(8).items_start().rounded(8).bg(t.ansi1 + "18").border_1().border_color(t.ansi1 + "40")
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(12).font_semibold().text_color(t.ansi1).child(this.error.title))
          .child(div().id("gp-error").max_h(120).overflow_y_scrollbar().text_size(11.5).text_color(t.foreground).font_family(settings().font_family ?? "JetBrains Mono").child(this.error.text.slice(0, 4000))))
        .child(this.icon("gp-error-x", "close", "Dismiss", (cx) => { this.error = null; cx.notify(); }, t, { always: true, size: 12 })));
    }
    if (d?.op) {
      const label = { rebase: "Rebasing", merge: "Merging", "cherry-pick": "Cherry-picking", revert: "Reverting" }[d.op];
      out.push(h_flex().flex_none().mx(8).mt(8).px(10).h(36).gap(6).items_center().rounded(8).bg(t.ansi3 + "18").border_1().border_color(t.ansi3 + "40")
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.ansi3).child(d.conflicts.length ? `${label}: ${d.conflicts.length} conflict${d.conflicts.length > 1 ? "s" : ""} to resolve` : `${label}: ready to continue`))
        .child(this.button("gp-op-abort", "Abort", (cx) => this.ask("gp-op-abort", `Abort the ${d.op}? Its changes are dropped.`, "Abort", (cx) => this.operation("abort", cx), cx), t, { kind: "danger" }))
        .child(this.button("gp-op-continue", "Continue", (cx) => this.operation("continue", cx), t, { kind: "primary", disabled: d.conflicts.length > 0 })));
      if (this.confirm?.id === "gp-op-abort") out.push(div().mx(8).mt(4).child(this.confirmRow(this.confirm, t)));
    }
    return out;
  }

  commitBox(t) {
    const d = this.data;
    const plan = commitPlan({ staged: d.staged.length, unstaged: d.unstaged.length + d.conflicts.length, amend: this.amend, message: this.msg });
    const can = plan.ok && !this.busy && !d.conflicts.length;
    return v_flex().flex_none().p(8).gap(6).border_b(1).border_color(t.border)
      .child(div().id("gp-message").w_full().px(8).py(6).rounded(8).border_1().border_color(this.typing ? t.accent : t.border).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.message).w_full().text_size(12.5).text_color(t.foreground)))
      .child(h_flex().gap(4).items_center()
        .child(h_flex().id("gp-amend").h(24).px(6).gap(5).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(d.branch.oid ? "Add to the last commit instead of making a new one" : "No commit to amend yet")
          .when(Boolean(d.branch.oid), (e) => e.on_click((_e, cx) => this.toggleAmend(cx)))
          .child(div().size(13).flex().items_center().justify_center().rounded(3).border_1().border_color(this.amend ? t.accent : t.input).bg(this.amend ? t.accent : t.background)
            .when(this.amend, (e) => e.child(svg(ICON("check")).size(10).text_color(t.accent_foreground))))
          .child(div().text_size(11.5).text_color(this.amend ? t.foreground : t.muted).child("Amend")))
        .child(this.icon("gp-generate", "sparkle", "Write a message with Claude (claude -p, haiku)", (cx) => this.generate(cx), t, { disabled: this.writing || !(d.staged.length + d.unstaged.length) }))
        .child(div().flex_1())
        .child(this.icon("gp-commit-push", "push", d.remotes.length ? `${plan.ok ? plan.label : "Commit"} and push` : "No remote to push to", (cx) => this.commit(cx, true), t, { disabled: !can || !d.remotes.length || !d.branch.head }))
        .child(this.button("gp-commit", plan.ok ? plan.label : "Commit", (cx) => this.commit(cx, false), t, { kind: "primary", disabled: !can, tip: d.conflicts.length ? "Resolve conflicts first" : plan.ok ? "⌘Enter" : plan.why })));
  }

  section(id, title, count, t, actions = []) {
    const open = !this.collapsed[id];
    return h_flex().id(`gp-sec-${id}`).h(ROW).flex_none().pl(4).pr(4).gap(4).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.collapsed = { ...this.collapsed, [id]: open }; save("collapsed", this.collapsed); cx.notify(); })
      .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(12).text_color(t.dim))
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(title.toUpperCase()))
      .child(div().px(5).rounded(8).bg(t.raised).text_size(10).text_color(t.muted).child(String(count)))
      .child(div().flex_1())
      .children(actions);
  }

  fileRow(area, f, t) {
    const id = `gp-${area}-${f.path}`, sel = this.sel?.area === area && this.sel?.path === f.path;
    if (this.confirm?.id === id) return this.confirmRow(this.confirm, t);
    const { dir, name } = splitPath(f.path), stat = (area === "staged" ? this.data.stats.staged : this.data.stats.unstaged)[f.path];
    const color = f.code === "A" || f.code === "U" ? t.ansi2 : f.code === "D" ? t.ansi1 : f.code === "!" ? t.ansi1 : f.code === "R" ? t.ansi4 : t.ansi3;
    const hovered = this.hover === id;
    const actions = [];
    if (hovered || sel) {
      if (this.editor && f.code !== "D") actions.push(this.icon(`${id}-open`, "file", "Open in Editor", () => this.open(f.path), t, { always: true, size: 13 }));
      if (area === "unstaged" || area === "untracked") {
        actions.push(this.icon(`${id}-discard`, "discard", f.untracked ? "Delete this new file" : "Discard changes", (cx) =>
          this.ask(id, f.untracked ? `Delete ${name}? It isn't in git.` : `Discard changes to ${name}?`, f.untracked ? "Delete" : "Discard", (cx) => this.discard(f, cx), cx), t, { size: 13 }));
        actions.push(this.icon(`${id}-stage`, "plus", "Stage", (cx) => this.stage([f.path], cx), t));
      } else if (area === "staged") actions.push(this.icon(`${id}-unstage`, "minus", "Unstage", (cx) => this.unstage([f], cx), t));
      else if (area === "conflict") actions.push(this.icon(`${id}-resolve`, "check", "Mark resolved (stage)", (cx) => this.conflict(f, "resolved", cx), t));
    }
    return h_flex().id(id).h(ROW).flex_none().pl(22).pr(4).gap(6).items_center().rounded(6).cursor_pointer()
      .when(sel, (e) => e.bg(t.selected)).hover((s) => s.bg(sel ? t.selected : t.hover))
      .on_hover((h, cx) => { if (h) { if (this.hover !== id) { this.hover = id; cx.notify(); } } else if (this.hover === id) { this.hover = null; cx.notify(); } })
      .on_click((_e, cx) => this.select({ area, path: f.path, orig: f.orig ?? null }, cx))
      .when(f.code !== "D", (e) => e.drag_paths([`${this.root}/${f.path}`], { on: this.on }))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().flex_none().max_w(220).truncate().text_size(12.5).text_color(f.code === "D" ? t.muted : t.foreground).when(f.code === "D", (e) => e.line_through()).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(f.orig ? `${f.orig} →` : dir)))
      .children(actions)
      .when(!hovered && !sel && Boolean(stat) && !stat.binary, (e) => e
        .when(stat.add > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.ansi2).child(`+${stat.add}`)))
        .when(stat.del > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.ansi1).child(`−${stat.del}`))))
      .child(div().w(14).flex_none().text_center().text_size(11).font_semibold().text_color(color).child(f.code));
  }

  lists(t) {
    const d = this.data, rows = [];
    const add = (r) => rows.push(r);
    const files = (area, list) => {
      list.slice(0, LIMIT).forEach((f) => add(this.fileRow(f.untracked ? "untracked" : area, f, t)));
      if (list.length > LIMIT) add(div().h(ROW).pl(22).flex().items_center().text_size(11).text_color(t.dim).child(`and ${list.length - LIMIT} more`));
    };
    if (d.conflicts.length) {
      add(this.section("conflicts", "Merge conflicts", d.conflicts.length, t));
      if (!this.collapsed.conflicts) files("conflict", d.conflicts);
    }
    if (d.staged.length) {
      add(this.section("staged", "Staged", d.staged.length, t, [this.icon("gp-unstage-all", "minus", "Unstage all", (cx) => this.unstageAll(cx), t)]));
      if (!this.collapsed.staged) files("staged", d.staged);
    }
    const changes = d.unstaged.length;
    if (this.confirm?.id === "gp-discard-all") add(this.confirmRow(this.confirm, t));
    else add(this.section("changes", "Changes", changes, t, changes ? [
      this.icon("gp-discard-all", "discard", "Discard all changes", (cx) => this.ask("gp-discard-all", `Discard all ${changes} change${changes > 1 ? "s" : ""}? New files are deleted.`, "Discard all", (cx) => this.discardAll(cx), cx), t, { size: 13 }),
      this.icon("gp-stage-all", "plus", "Stage all", (cx) => this.stageAll(cx), t),
    ] : []));
    if (!this.collapsed.changes) {
      if (changes) files("unstaged", d.unstaged);
      else add(div().h(ROW).pl(22).flex().items_center().text_size(12).text_color(t.dim).child(d.staged.length ? "Everything is staged" : "No changes"));
    }
    add(this.section("stashes", "Stashes", d.stashes.length, t, [
      this.icon("gp-stash", "stash", "Stash all changes (including new files)", (cx) => this.stash("push", null, cx), t, { disabled: !(d.staged.length + d.unstaged.length), size: 13 }),
    ]));
    if (!this.collapsed.stashes) for (const s of d.stashes) add(this.stashRow(s, t));
    add(this.section("history", "Commits", d.log.length, t));
    if (!this.collapsed.history) d.log.forEach((c, i) => add(this.commitRow(c, i, t)));
    return rows;
  }

  stashRow(s, t) {
    const id = `gp-stash-${s.ref}`, sel = this.sel?.area === "stash" && this.sel.ref === s.ref;
    if (this.confirm?.id === id) return this.confirmRow(this.confirm, t);
    const hovered = this.hover === id;
    return h_flex().id(id).h(ROW).flex_none().pl(22).pr(4).gap(6).items_center().rounded(6).cursor_pointer()
      .when(sel, (e) => e.bg(t.selected)).hover((st) => st.bg(sel ? t.selected : t.hover))
      .on_hover((h, cx) => { if (h) { if (this.hover !== id) { this.hover = id; cx.notify(); } } else if (this.hover === id) { this.hover = null; cx.notify(); } })
      .on_click((_e, cx) => this.select({ area: "stash", ref: s.ref, path: s.ref, title: s.subject }, cx))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(s.subject))
      .when(!hovered && !sel, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(s.when)))
      .when(hovered || sel, (e) => e
        .child(this.button(`${id}-apply`, "Apply", (cx) => this.stash("apply", s.ref, cx), t, { tip: "Apply and keep the stash" }))
        .child(this.button(`${id}-pop`, "Pop", (cx) => this.stash("pop", s.ref, cx), t, { tip: "Apply and drop the stash" }))
        .child(this.icon(`${id}-drop`, "close", "Drop this stash", (cx) => this.ask(id, `Drop “${s.subject}”?`, "Drop", (cx) => this.stash("drop", s.ref, cx), cx), t, { size: 12 })));
  }

  commitRow(c, i, t) {
    const d = this.data, id = `gp-commit-${c.sha}`, sel = this.sel?.area === "commit" && this.sel.ref === c.sha;
    if (this.confirm?.id === id) return this.confirmRow(this.confirm, t);
    const hovered = this.hover === id;
    // Undo only the newest commit, and only while it isn't on the upstream yet.
    const undoable = i === 0 && d.log.length > 1 && !d.op && (!d.branch.upstream || d.branch.ahead > 0);
    return h_flex().id(id).h(ROW).flex_none().pl(22).pr(4).gap(6).items_center().rounded(6).cursor_pointer()
      .when(sel, (e) => e.bg(t.selected)).hover((s) => s.bg(sel ? t.selected : t.hover))
      .on_hover((h, cx) => { if (h) { if (this.hover !== id) { this.hover = id; cx.notify(); } } else if (this.hover === id) { this.hover = null; cx.notify(); } })
      .on_click((_e, cx) => this.select({ area: "commit", ref: c.sha, path: c.sha, title: c.subject }, cx))
      .child(div().flex_none().text_size(11).text_color(t.dim).font_family(settings().font_family ?? "JetBrains Mono").child(c.short))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(c.merge ? t.muted : t.foreground).child(c.subject))
      .when(!(hovered && undoable), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(c.when.replace(/ ago$/, ""))))
      .when(hovered && undoable, (e) => e.child(this.button(`${id}-undo`, "Undo", (cx) => this.ask(id, "Undo the last commit? Its changes stay staged.", "Undo", (cx) => this.undoCommit(cx), cx), t, { tip: "git reset --soft HEAD~1" })));
  }

  diffHeader(t) {
    const s = this.sel, d = this.data;
    const f = ["staged", "unstaged", "untracked", "conflict"].includes(s.area) ? this.find(s.path).find((x) => x.area === s.area) : null;
    const { dir, name } = s.area === "commit" || s.area === "stash" ? { dir: "", name: s.title } : splitPath(s.path);
    const label = { staged: "Staged", unstaged: "Changes", untracked: "New file", conflict: "Conflict", commit: s.ref.slice(0, 7), stash: s.ref }[s.area];
    const actions = [];
    if (f) {
      if (this.editor && f.code !== "D") actions.push(this.icon("gp-d-open", "file", "Open in Editor", () => this.open(f.path), t, { always: true, size: 13 }));
      if (s.area === "unstaged" || s.area === "untracked") {
        actions.push(this.icon("gp-d-discard", "discard", f.untracked ? "Delete this new file" : "Discard changes", (cx) =>
          this.ask("gp-d", f.untracked ? `Delete ${name}?` : `Discard changes to ${name}?`, f.untracked ? "Delete" : "Discard", (cx) => this.discard(f, cx), cx), t, { size: 13 }));
        actions.push(this.icon("gp-d-stage", "plus", "Stage file", (cx) => this.stage([f.path], cx), t));
      } else if (s.area === "staged") actions.push(this.icon("gp-d-unstage", "minus", "Unstage file", (cx) => this.unstage([f], cx), t));
      else if (s.area === "conflict") {
        actions.push(this.button("gp-d-ours", "Ours", (cx) => this.conflict(f, "ours", cx), t, { tip: "Take our version of the whole file" }));
        actions.push(this.button("gp-d-theirs", "Theirs", (cx) => this.conflict(f, "theirs", cx), t, { tip: "Take their version of the whole file" }));
        actions.push(this.icon("gp-d-resolve", "check", "Mark resolved (stage)", (cx) => this.conflict(f, "resolved", cx), t));
      }
    }
    if (this.confirm?.id === "gp-d") return div().flex_none().px(6).py(3).border_t(1).border_color(t.border).child(this.confirmRow(this.confirm, t));
    return h_flex().h(34).flex_none().px(8).gap(4).items_center().border_t(1).border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().flex_none().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(label))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center().px(4)
        .child(div().flex_none().max_w(200).truncate().text_size(12.5).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir)))
      .children(actions)
      .child(this.icon("gp-d-close", "close", "Close", (cx) => { this.sel = null; this.diff = null; this.confirm = null; cx.notify(); }, t, { always: true, size: 12 }));
  }

  diffRow(row, i, t, area) {
    if (row.kind === "file") return h_flex().w_full().h(DROW).flex_none().px(10).items_center().bg(t.raised).font_semibold().text_color(t.foreground).child(div().truncate().child(row.text));
    if (row.kind === "@") {
      const cid = `gp-hunk-${row.hunk}`;
      if (row.hunk !== undefined && this.confirm?.id === cid) return div().w_full().flex_none().child(this.confirmRow(this.confirm, t, DROW));
      const acts = [];
      if (row.hunk !== undefined && area === "unstaged") {
        acts.push(this.hunkButton(`${cid}-stage`, "Stage", (cx) => this.hunk(row.hunk, "stage", cx), t));
        acts.push(this.hunkButton(`${cid}-discard`, "Discard", (cx) => this.ask(cid, "Discard this hunk?", "Discard", (cx) => this.hunk(row.hunk, "discard", cx), cx), t));
      } else if (row.hunk !== undefined && area === "staged") acts.push(this.hunkButton(`${cid}-unstage`, "Unstage", (cx) => this.hunk(row.hunk, "unstage", cx), t));
      return h_flex().w_full().h(DROW).flex_none().pl(6).gap(4).items_center().bg(t.raised).text_color(t.dim)
        .children(acts).child(div().pl(4).truncate().child(row.text));
    }
    const num = (n) => div().w(32).flex_none().text_right().text_color(t.dim).child(n === undefined ? "" : String(n));
    return h_flex().w_full().h(DROW).flex_none().gap(6)
      .when(row.kind === "+", (e) => e.bg(t.ansi2 + "18")).when(row.kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(num(row.old)).child(num(row.number))
      .child(div().w(10).flex_none().text_color(row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : t.dim).child(row.kind === " " ? "" : row.kind))
      .child(div().flex_1().min_w(0).truncate().text_color(row.kind ? t.foreground : t.dim).child(row.text));
  }

  hunkButton(id, label, onClick, t) {
    return div().id(id).h(16).px(6).flex_none().flex().items_center().rounded(4).border_1().border_color(t.border).bg(t.background).text_size(10).text_color(t.muted)
      .when(!this.busy, (e) => e.cursor_pointer().hover((s) => s.text_color(t.foreground).border_color(t.input)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
      .child(label);
  }

  diffBody(t) {
    const rows = this.diff?.rows ?? [], area = this.sel.area;
    return div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
      .when(!this.diff, (e) => e.child(div().p(12).text_color(t.dim).child("Loading…")))
      .when(Boolean(this.diff), (e) => e
        .child(div().id("gp-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diff.width).h_full().child(v_virtual_list("gp-diff", rows.length + (this.diff.truncated ? 1 : 0), DROW, (i) => String(i),
            (range) => {
              const out = [];
              for (let i = range.start; i < range.end; i++) out.push(i < rows.length ? this.diffRow(rows[i], i, t, area) : div().h(DROW).px(12).text_color(t.dim).child("Diff cut short here (too long to show)"));
              return out;
            }).size_full())))
        .child(Scrollbar.vertical("gp-diff").viewport_from_layout().absolute().inset_0()));
  }

  render(cx) {
    if (key() !== this.context && !checking()) this.refresh(cx);
    const t = theme(), d = this.data;
    const root = v_flex().id("git-panel").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_key_down((e, cx) => {
        if (e.key === "enter" && (e.modifiers.platform || e.modifiers.control) && this.typing) { this.commit(cx, Boolean(e.modifiers.shift)); cx.stop_propagation(); }
        else if (e.key === "escape" && this.picker) { this.picker = null; cx.stop_propagation(); cx.notify(); }
        else if (e.key === "escape" && this.confirm) { this.confirm = null; cx.stop_propagation(); cx.notify(); }
      })
      .child(this.header(t))
      .children(this.banners(t));
    if (!d) {
      const empty = this.notRepo ? "Not a git repository" : this.error ? "" : this.context && location().cwd ? "Loading…" : "No folder";
      return root.child(v_flex().p(14).gap(10).text_size(12.5).text_color(t.dim).child(empty)
        .when(this.notRepo && !this.on, (e) => e.child(this.button("gp-init", "Initialize repository", (cx) => this.init_(cx), t, { kind: "primary", tip: `git init in ${this.cwd}` }))));
    }
    const rows = this.lists(t);
    const height = this.size?.height ?? 600;
    const listMax = this.sel ? Math.max(ROW * 3 + 12, Math.floor(height * 0.4)) : null;
    const listContent = rows.length * ROW + 12;
    return root
      .child(this.commitBox(t))
      .child(div().flex_1().min_h(ROW * 2).when(Boolean(this.sel), (e) => e.max_h(Math.min(listContent, listMax))).relative()
        .child(v_flex().id("gp-list").absolute().inset_0().overflow_y_scroll().p(4).children(rows))
        .child(Scrollbar.vertical("gp-list").absolute().inset_0()))
      .when(Boolean(this.sel), (e) => e.child(this.diffHeader(t)).child(this.diffBody(t)))
      .when(Boolean(this.picker), (e) => e.child(this.picker_(t)));
  }

  init_(cx) {
    const cwd = this.cwd, context = this.context;
    this.busy = "Initialize";
    cx.spawn(async (cx) => {
      const r = await exec("git", ["init"], { cwd });
      this.busy = null;
      if (r.code !== 0) this.error = { title: "git init failed", text: r.stderr.trim() };
      if (key() === context) { this.root = null; this.notRepo = false; }
      this.refresh(cx); cx.notify();
    });
    cx.notify();
  }
}

function note(text) { return { rows: [{ kind: "", text }], hunks: [], truncated: false }; }
