// node --test: git.js against real git output in a throwaway repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { parseStatus, parseNumstat, parseBranches, parseLog, parseStashes, parseDiff, hunkPatch, addedDiff, validBranch, commitPlan, LOG_FORMAT } from "../mods/git-panel/git.js";

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-panel-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q", "-b", "main");
  const write = (f, text) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };
  return { dir, git, write };
}

const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

test("status: staged, unstaged, untracked, renamed and a path with spaces", () => {
  const { git, write } = repo();
  write("a.txt", "a\n"); write("b.txt", "b\n"); write("old name.txt", "x\n".repeat(20));
  git("add", "-A"); git("commit", "-q", "-m", "first");
  write("a.txt", "a2\n"); git("add", "a.txt");          // staged
  write("a.txt", "a3\n");                                // and unstaged on top
  write("b.txt", "b2\n");                                // unstaged only
  git("mv", "old name.txt", "new name.txt");             // staged rename
  write("dir/new.txt", "n\n");                           // untracked
  const s = parseStatus(git("status", "--porcelain=v2", "--branch", "--show-stash", "-z", "--untracked-files=all"));
  assert.equal(s.branch.head, "main");
  assert.ok(s.branch.oid);
  assert.deepEqual(s.staged.map((f) => [f.path, f.code, f.orig]).sort(), [["a.txt", "M", null], ["new name.txt", "R", "old name.txt"]]);
  assert.deepEqual(s.unstaged.map((f) => [f.path, f.code, Boolean(f.untracked)]).sort(), [["a.txt", "M", false], ["b.txt", "M", false], ["dir/new.txt", "U", true]]);
  assert.equal(s.conflicts.length, 0);
});

test("status: a repository with no commits yet", () => {
  const { git, write } = repo();
  write("a.txt", "a\n"); git("add", "a.txt");
  const s = parseStatus(git("status", "--porcelain=v2", "--branch", "-z"));
  assert.equal(s.branch.oid, null);
  assert.equal(s.branch.head, "main");
  assert.deepEqual(s.staged.map((f) => f.code), ["A"]);
});

test("status: merge conflicts", () => {
  const { git, write } = repo();
  write("c.txt", "base\n"); git("add", "-A"); git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "other"); write("c.txt", "theirs\n"); git("commit", "-qam", "theirs");
  git("switch", "-q", "main"); write("c.txt", "ours\n"); git("commit", "-qam", "ours");
  spawnSync("git", ["merge", "other"], { cwd: git("rev-parse", "--show-toplevel").trim() });
  const s = parseStatus(git("status", "--porcelain=v2", "-z"));
  assert.deepEqual(s.conflicts.map((f) => [f.path, f.how]), [["c.txt", "UU"]]);
});

test("numstat: counts, binary and renames", () => {
  const { git, write, dir } = repo();
  write("a.txt", lines(3)); write("r.txt", lines(30)); fs.writeFileSync(path.join(dir, "bin"), Buffer.from([0, 1, 2]));
  git("add", "-A"); git("commit", "-q", "-m", "c");
  write("a.txt", lines(5)); fs.writeFileSync(path.join(dir, "bin"), Buffer.from([0, 9, 9]));
  git("mv", "r.txt", "moved.txt"); git("add", "-A");
  const stats = parseNumstat(git("diff", "--cached", "--numstat", "-z", "-M"));
  assert.deepEqual(stats["a.txt"], { add: 2, del: 0, binary: false });
  assert.equal(stats.bin.binary, true);
  assert.deepEqual(stats["moved.txt"], { add: 0, del: 0, binary: false });
});

test("a single hunk applies on its own: stage, unstage, discard", () => {
  const { git, write, dir } = repo();
  write("f.txt", lines(40)); git("add", "-A"); git("commit", "-q", "-m", "c");
  write("f.txt", lines(40, (i) => (i === 2 || i === 35 ? `changed ${i}` : `line ${i}`)));
  const d = parseDiff(git("diff", "--no-color", "--", "f.txt"));
  assert.equal(d.hunks.length, 2);
  const run = (patch, flags) => { const r = spawnSync("git", ["apply", "--whitespace=nowarn", ...flags, "-"], { cwd: dir, input: patch }); assert.equal(r.status, 0, String(r.stderr)); };

  run(hunkPatch(d.hunks[1]), ["--cached"]);               // stage the second hunk only
  assert.match(git("diff", "--cached"), /changed 35/);
  assert.doesNotMatch(git("diff", "--cached"), /changed 2/);
  assert.match(git("diff"), /changed 2/);

  const staged = parseDiff(git("diff", "--cached", "--no-color", "--", "f.txt"));
  run(hunkPatch(staged.hunks[0]), ["--cached", "--reverse"]);  // unstage it again
  assert.equal(git("diff", "--cached"), "");

  run(hunkPatch(d.hunks[0]), ["--reverse"]);               // discard the first hunk from the file
  const text = fs.readFileSync(path.join(dir, "f.txt"), "utf8");
  assert.match(text, /^line 1\nline 2\n/);
  assert.match(text, /changed 35/);
});

test("diff rows: numbers, hunk links, file headers and tabs", () => {
  const d = parseDiff([
    "diff --git a/x.js b/x.js", "index 1..2 100644", "--- a/x.js", "+++ b/x.js",
    "@@ -10,3 +10,3 @@ function f() {", " keep", "-\told", "+\tnew", " keep",
    "diff --git a/y.js b/y.js", "--- a/y.js", "+++ b/y.js", "@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file",
  ].join("\n"));
  assert.deepEqual(d.rows.map((r) => r.kind), ["file", "@", " ", "-", "+", " ", "file", "@", "-", "+", ""]);
  assert.deepEqual([d.rows[2].old, d.rows[2].number, d.rows[3].old, d.rows[4].number, d.rows[5].number], [10, 10, 11, 11, 12]);
  assert.equal(d.rows[3].text, "    old");
  assert.deepEqual(d.hunks.map((h) => h.file), ["x.js", "y.js"]);
  assert.equal(d.rows[7].hunk, 1);
  assert.ok(hunkPatch(d.hunks[1]).endsWith("+b\n\\ No newline at end of file\n"));
  assert.ok(hunkPatch(d.hunks[1]).startsWith("diff --git a/y.js b/y.js\n--- a/y.js\n+++ b/y.js\n@@ -1 +1 @@\n"));
});

test("new files show as all added", () => {
  const d = addedDiff("n.txt", "a\nb\n");
  assert.deepEqual(d.rows.map((r) => [r.kind, r.number ?? null, r.text]), [["file", null, "n.txt"], ["@", null, "@@ -0,0 +1,2 @@ new file"], ["+", 1, "a"], ["+", 2, "b"]]);
});

test("branches, log and stashes", () => {
  const { git, write } = repo();
  write("a", "1\n"); git("add", "-A"); git("commit", "-q", "-m", "one");
  git("branch", "feature/x");
  write("a", "2\n"); git("stash", "push", "-q", "-m", "wip thing");
  const b = parseBranches(git("for-each-ref", "--format=%(refname)%00%(upstream:short)%00%(committerdate:relative)%00%(HEAD)", "refs/heads", "refs/remotes"));
  assert.deepEqual(b.local.map((x) => [x.name, x.current]).sort(), [["feature/x", false], ["main", true]]);
  const log = parseLog(git("log", `--format=${LOG_FORMAT}`));
  assert.equal(log[0].subject, "one");
  assert.equal(log[0].merge, false);
  const st = parseStashes(git("stash", "list", "--format=%gd%x1f%s%x1f%cr"));
  assert.equal(st[0].ref, "stash@{0}");
  assert.match(st[0].subject, /wip thing/);
});

test("branch names", () => {
  for (const ok of ["main", "feature/x", "fix-12", "v1.2"]) assert.ok(validBranch(ok), ok);
  for (const bad of ["", "a b", "a..b", "-x", "x/", "x.lock", "a~1", "a:b", "@", "x//y"]) assert.ok(!validBranch(bad), bad);
});

test("commit button: smart commit when nothing is staged", () => {
  assert.deepEqual(commitPlan({ staged: 2, unstaged: 1, amend: false, message: "m" }), { ok: true, stageAll: false, label: "Commit" });
  assert.deepEqual(commitPlan({ staged: 0, unstaged: 3, amend: false, message: "m" }), { ok: true, stageAll: true, label: "Commit all" });
  assert.equal(commitPlan({ staged: 1, unstaged: 0, amend: false, message: " " }).ok, false);
  assert.deepEqual(commitPlan({ staged: 0, unstaged: 0, amend: true, message: "" }), { ok: true, stageAll: false, label: "Amend" });
  assert.equal(commitPlan({ staged: 0, unstaged: 0, amend: false, message: "m" }).why, "Nothing to commit");
});
