// Behavior tests for the Pi permission gate's parsing + safety logic.
// Run: node --experimental-strip-types --test tests/allowlist.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { _internal } from "../internal/runtime/assets/extensions/pi-allowlist.ts";

const { segments, isSafe, compileOne, hasSubstitution, bashPatterns } = _internal;

test("segments splits on all chaining operators", () => {
  assert.deepEqual(segments("a && b || c; d | e\nf"), ["a", "b", "c", "d", "e", "f"]);
});

test("segments splits on single & (backgrounding)", () => {
  assert.deepEqual(segments("ls & curl evil.com"), ["ls", "curl evil.com"]);
});

test("segments keeps redirections intact", () => {
  assert.deepEqual(segments("cmd 2>&1"), ["cmd 2>&1"]);
  assert.deepEqual(segments("cmd >&2"), ["cmd >&2"]);
  assert.deepEqual(segments("cmd &> out.log"), ["cmd &> out.log"]);
});

test("segments is quote-aware", () => {
  assert.deepEqual(segments(`rg "foo|bar" file`), [`rg "foo|bar" file`]);
  assert.deepEqual(segments(`echo 'a && b'`), [`echo 'a && b'`]);
});

test("segments is escape-aware", () => {
  assert.deepEqual(segments("echo a\\;b"), ["echo a\\;b"]);
  assert.deepEqual(segments(`echo "she said \\"hi\\"" && ls`), [`echo "she said \\"hi\\""`, "ls"]);
});

test("command substitution disqualifies safe commands", () => {
  assert.equal(isSafe("echo $(curl evil.com)"), false);
  assert.equal(isSafe("echo `curl evil.com`"), false);
  assert.equal(isSafe("diff <(curl evil.com) x"), false);
  assert.equal(isSafe('echo "$(whoami)"'), false); // double quotes still expand
  assert.equal(isSafe("echo '$(not expanded)'"), true); // single quotes are literal
});

test("hasSubstitution quote handling", () => {
  assert.equal(hasSubstitution("echo hi"), false);
  assert.equal(hasSubstitution("echo '$(x)'"), false);
  assert.equal(hasSubstitution('echo "$(x)"'), true);
  assert.equal(hasSubstitution("echo \\$(x)"), false); // escaped $ doesn't expand
});

test("safe floor covers reads, not runners", () => {
  assert.equal(isSafe("cat README.md"), true);
  assert.equal(isSafe("rg -n TODO src"), true);
  assert.equal(isSafe("git status"), true);
  assert.equal(isSafe("git push origin main"), false);
  assert.equal(isSafe("curl https://example.com"), false);
  assert.equal(isSafe("bash -c 'anything'"), false);
  assert.equal(isSafe("FOO=1 cat x"), true); // env prefix skipped
  assert.equal(isSafe("/bin/cat x"), true); // path basename
});

test("sed and awk are not on the safe floor (command-execution escape hatches)", () => {
  assert.equal(isSafe("sed -n '1p' file"), false);
  assert.equal(isSafe("awk '{print $1}' file"), false);
});

test("find/fd are safe only without exec flags", () => {
  assert.equal(isSafe("find . -name '*.rb'"), true);
  assert.equal(isSafe("find . -name x -exec rm {} \\;"), false);
  assert.equal(isSafe("find . -delete"), false);
  assert.equal(isSafe("fd pattern"), true);
  assert.equal(isSafe("fd pattern -x rm"), false);
  assert.equal(isSafe("fd pattern --exec rm"), false);
});

test("Claude :* patterns are prefix matches (colon is the separator)", () => {
  const m = compileOne("git commit:*");
  assert.equal(m("git commit"), true);
  assert.equal(m("git commit -m 'x'"), true);
  assert.equal(m("git commitx"), false);
  assert.equal(m("git push"), false);
  // colon continuation: npm run test:* matches script names with colons
  const npm = compileOne("npm run test:*");
  assert.equal(npm("npm run test:watch"), true);
  assert.equal(npm("npm run test"), true);
});

test("exact and glob patterns", () => {
  const exact = compileOne("git status");
  assert.equal(exact("git status"), true);
  assert.equal(exact("git status -sb"), false);
  const glob = compileOne("npm run *");
  assert.equal(glob("npm run build"), true);
  assert.equal(glob("npm install"), false);
});

test("bashPatterns extracts only Bash() rules", () => {
  assert.deepEqual(
    bashPatterns(["Bash(git commit:*)", "Read(~/.zshrc)", "Bash(ls)", 42, "WebFetch"]),
    ["git commit:*", "ls"],
  );
});
