import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isOfficialPaseoOriginUrl, parseFetchRemoteLine } from "./git.mjs";
import { parseManifestSource, validateManifest } from "./manifest.mjs";

const SCRIPT_NAME = "integration.mjs";
const SKILL_SCRIPTS_DEST = join(".agents", "skills", "paseo-integration-maintenance", "scripts");

function git(cwd, args, home) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function copySkillScripts(repoRoot) {
  const dest = join(repoRoot, SKILL_SCRIPTS_DEST);
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(import.meta.dirname)) {
    if (!name.endsWith(".mjs") || name.endsWith(".test.mjs")) continue;
    copyFileSync(join(import.meta.dirname, name), join(dest, name));
  }
}

function defaultGates() {
  return {
    required: ["exact-sha", "verify-ancestry", "build", "install", "rollback"],
    futureStages: ["build", "install", "rollback"],
  };
}

function writeManifest(repoRoot, overrides = {}) {
  const manifest = {
    schemaVersion: 1,
    branch: "integration/dev",
    officialStableBaseline: overrides.officialStableBaseline,
    effectiveUpstreamCeiling: overrides.effectiveUpstreamCeiling,
    features: overrides.features ?? [],
    verificationGates: overrides.verificationGates ?? defaultGates(),
  };
  if (overrides.schemaVersion !== undefined) manifest.schemaVersion = overrides.schemaVersion;
  if (overrides.branch !== undefined) manifest.branch = overrides.branch;
  mkdirSync(join(repoRoot, ".paseo-integration"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".paseo-integration", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), "paseo-integration-cli-"));
  const home = mkdtempSync(join(tmpdir(), "paseo-integration-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "paseo-integration-cwd-"));

  git(root, ["init", "-b", "integration/dev"], home);
  git(root, ["config", "user.name", "Test"], home);
  git(root, ["config", "user.email", "test@example.com"], home);
  git(root, ["config", "commit.gpgsign", "false"], home);
  git(root, ["config", "tag.gpgsign", "false"], home);

  writeFileSync(join(root, "README"), "baseline\n");
  git(root, ["add", "README"], home);
  git(root, ["commit", "-m", "baseline"], home);
  const baseline = git(root, ["rev-parse", "HEAD"], home);
  git(root, ["tag", "-a", "v1.0.0", "-m", "v1.0.0"], home);

  writeFileSync(join(root, "README"), "ceiling\n");
  git(root, ["add", "README"], home);
  git(root, ["commit", "-m", "ceiling"], home);
  const ceiling = git(root, ["rev-parse", "HEAD"], home);
  git(root, ["tag", "-a", "v1.1.0", "-m", "v1.1.0"], home);

  writeFileSync(join(root, "feature.txt"), "feature\n");
  git(root, ["add", "feature.txt"], home);
  git(root, ["commit", "-m", "feature"], home);
  const feature = git(root, ["rev-parse", "HEAD"], home);

  git(root, ["remote", "add", "origin", "https://github.com/getpaseo/paseo.git"], home);
  git(root, ["remote", "add", "sungchul2", "https://github.com/sungchul2/paseo.git"], home);
  git(root, ["update-ref", "refs/remotes/origin/main", ceiling], home);

  copySkillScripts(root);
  writeManifest(root, {
    officialStableBaseline: { tag: "v1.0.0", commit: baseline },
    effectiveUpstreamCeiling: { remote: "origin", ref: "main", commit: ceiling },
    features: [
      {
        number: 1,
        owner: "alice",
        repo: "paseo",
        ref: "feat/x",
        head: feature,
        role: "owned",
        status: "open",
        open: true,
        url: "https://github.com/getpaseo/paseo/pull/1",
      },
    ],
  });
  git(root, ["add", ".agents", ".paseo-integration"], home);
  git(root, ["commit", "-m", "pins"], home);
  const head = git(root, ["rev-parse", "HEAD"], home);

  return {
    root: realpathSync(root),
    home: realpathSync(home),
    cwd: realpathSync(cwd),
    baseline,
    ceiling,
    feature,
    head,
  };
}

function closeRepo(repo) {
  rmSync(repo.root, { force: true, recursive: true });
  rmSync(repo.home, { force: true, recursive: true });
  rmSync(repo.cwd, { force: true, recursive: true });
}

function runCli(repo, args) {
  const script = join(repo.root, SKILL_SCRIPTS_DEST, SCRIPT_NAME);
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: repo.home,
      PASEO_HOME: join(repo.home, ".paseo"),
    },
  });
}

function runJson(repo, args) {
  const result = runCli(repo, [...args, "--json"]);
  let payload = null;
  if (result.stdout.trim() !== "") {
    payload = JSON.parse(result.stdout);
  }
  return { ...result, payload };
}

function withRepo(fn) {
  const repo = createRepo();
  try {
    return fn(repo);
  } finally {
    closeRepo(repo);
  }
}

test("accepts equivalent official getpaseo/paseo remote spellings", () => {
  for (const url of [
    "https://github.com/getpaseo/paseo.git",
    "https://github.com/getpaseo/paseo",
    "git@github.com:getpaseo/paseo.git",
    "git@github.com:getpaseo/paseo",
    "ssh://git@github.com/getpaseo/paseo.git",
    "ssh://git@github.com/getpaseo/paseo",
  ]) {
    assert.equal(isOfficialPaseoOriginUrl(url), true, url);
  }
  for (const url of [
    "http://github.com/getpaseo/paseo.git",
    "git://github.com/getpaseo/paseo.git",
    "https://user:token@github.com/getpaseo/paseo.git",
    "https://github.com/sungchul2/paseo.git",
  ]) {
    assert.equal(isOfficialPaseoOriginUrl(url), false, url);
  }
});

test("parses git remote -v fetch lines with optional decorations", () => {
  assert.deepEqual(
    parseFetchRemoteLine("origin\thttps://github.com/getpaseo/paseo.git (fetch) [blob:none]"),
    { name: "origin", url: "https://github.com/getpaseo/paseo.git" },
  );
  assert.deepEqual(parseFetchRemoteLine("origin\thttps://github.com/getpaseo/paseo.git (fetch)"), {
    name: "origin",
    url: "https://github.com/getpaseo/paseo.git",
  });
  assert.equal(parseFetchRemoteLine("origin\thttps://github.com/getpaseo/paseo.git (push)"), null);
  assert.equal(
    parseFetchRemoteLine("origin\thttps://github.com/getpaseo/paseo.git (push) [blob:none]"),
    null,
  );
});

test("validates a complete manifest schema", () => {
  const parsed = parseManifestSource(
    JSON.stringify({
      schemaVersion: 1,
      branch: "integration/dev",
      officialStableBaseline: {
        tag: "v0.6.1",
        commit: "20d7efc46a316f5a274b9943a5c43b0322269825",
      },
      effectiveUpstreamCeiling: {
        remote: "origin",
        ref: "main",
        commit: "ed628ff82e1777f6a46f5f8963db6b4ac3ee2ce3",
      },
      features: [],
      verificationGates: defaultGates(),
    }),
  );
  assert.equal(parsed.parsed, true);
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.errors, []);
});

test("rejects ceiling remote and ref values the verifier does not inspect", () => {
  const parsed = validateManifest({
    schemaVersion: 1,
    branch: "integration/dev",
    officialStableBaseline: {
      tag: "v0.6.1",
      commit: "20d7efc46a316f5a274b9943a5c43b0322269825",
    },
    effectiveUpstreamCeiling: {
      remote: "upstream",
      ref: "master",
      commit: "ed628ff82e1777f6a46f5f8963db6b4ac3ee2ce3",
    },
    features: [],
    verificationGates: defaultGates(),
  });
  assert.equal(parsed.valid, false);
  assert.equal(
    parsed.errors.some(
      (error) =>
        error.path === "effectiveUpstreamCeiling.remote" && error.message === 'must be "origin"',
    ),
    true,
  );
  assert.equal(
    parsed.errors.some(
      (error) =>
        error.path === "effectiveUpstreamCeiling.ref" && error.message === 'must be "main"',
    ),
    true,
  );
});

test("rejects invalid schema and short SHAs", () => {
  const invalidSchema = validateManifest({
    schemaVersion: "1",
    branch: "integration/dev",
    officialStableBaseline: {
      tag: "v0.6.1",
      commit: "20d7efc46a316f5a274b9943a5c43b0322269825",
    },
    effectiveUpstreamCeiling: {
      remote: "origin",
      ref: "main",
      commit: "ed628ff82e1777f6a46f5f8963db6b4ac3ee2ce3",
    },
    features: [],
    verificationGates: defaultGates(),
  });
  assert.equal(invalidSchema.valid, false);
  assert.equal(
    invalidSchema.errors.some((error) => error.path === "schemaVersion"),
    true,
  );

  const shortSha = validateManifest({
    schemaVersion: 1,
    branch: "integration/dev",
    officialStableBaseline: {
      tag: "v0.6.1",
      commit: "20d7efc46a316f5a274b9943a5c43b032226982",
    },
    effectiveUpstreamCeiling: {
      remote: "origin",
      ref: "main",
      commit: "ed628ff82e1777f6a46f5f8963db6b4ac3ee2ce3",
    },
    features: [],
    verificationGates: defaultGates(),
  });
  assert.equal(shortSha.valid, false);
  assert.equal(
    shortSha.errors.some(
      (error) => error.path === "officialStableBaseline.commit" && error.message.includes("40-hex"),
    ),
    true,
  );
});

test("verify-manifest accepts a valid repo pin set", () => {
  withRepo((repo) => {
    const result = runJson(repo, ["verify-manifest"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.command, "verify-manifest");
    assert.equal(result.payload.schema.valid, true);
    assert.deepEqual(result.payload.schema.errors, []);
    assert.equal(result.payload.baseline.commit, repo.baseline);
    assert.equal(result.payload.baseline.ancestorOfHead, true);
    assert.deepEqual(Object.keys(result.payload.baseline), [
      "tag",
      "commit",
      "exists",
      "ancestorOfHead",
    ]);
    assert.deepEqual(Object.keys(result.payload.ceiling), [
      "remote",
      "ref",
      "commit",
      "exists",
      "ancestorOfHead",
      "onOfficialMainLine",
      "isOfficialMainTip",
      "officialMainTipIsAncestorOfHead",
      "officialMainTip",
      "expectedCommit",
      "matchesExpectedCommit",
    ]);
    assert.equal(result.payload.ceiling.commit, repo.ceiling);
    assert.equal(result.payload.ceiling.ancestorOfHead, true);
    assert.equal(result.payload.ceiling.remote, "origin");
    assert.equal(result.payload.ceiling.ref, "main");
    assert.equal(result.payload.ceiling.onOfficialMainLine, true);
    assert.equal(result.payload.ceiling.isOfficialMainTip, true);
    assert.equal(result.payload.ceiling.officialMainTipIsAncestorOfHead, true);
    assert.equal(result.payload.ceiling.officialMainTip, repo.ceiling);
    assert.equal(result.payload.ceiling.expectedCommit, repo.ceiling);
    assert.equal(result.payload.ceiling.matchesExpectedCommit, true);
    assert.equal(result.payload.features[0].head, repo.feature);
    assert.equal(result.payload.features[0].ancestorOfHead, true);
  });
});

test("verify-manifest fails on an invalid full SHA in the copied manifest", () => {
  withRepo((repo) => {
    writeManifest(repo.root, {
      officialStableBaseline: { tag: "v1.0.0", commit: "g".repeat(40) },
      effectiveUpstreamCeiling: {
        remote: "origin",
        ref: "main",
        commit: repo.ceiling,
      },
      features: [
        {
          number: 1,
          owner: "alice",
          repo: "paseo",
          ref: "feat/x",
          head: repo.feature,
          role: "owned",
          status: "open",
          open: true,
          url: "https://github.com/getpaseo/paseo/pull/1",
        },
      ],
    });
    const result = runJson(repo, ["verify-manifest"]);
    assert.notEqual(result.status, 0);
    assert.equal(result.payload.ok, false);
    assert.equal(
      result.payload.schema.errors.some((error) => error.path === "officialStableBaseline.commit"),
      true,
    );
  });
});

test("verify-manifest fails when the stable baseline tag is missing locally", () => {
  withRepo((repo) => {
    writeManifest(repo.root, {
      officialStableBaseline: { tag: "v9.9.9", commit: repo.baseline },
      effectiveUpstreamCeiling: {
        remote: "origin",
        ref: "main",
        commit: repo.ceiling,
      },
    });

    const status = runJson(repo, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.payload.baseline.tag, "v9.9.9");
    assert.equal(status.payload.baseline.commit, repo.baseline);
    assert.equal(status.payload.baseline.exists, true);
    assert.equal(status.payload.baseline.ancestorOfHead, true);
    assert.equal(status.payload.baseline.tagExists, false);
    assert.equal(status.payload.baseline.tagCommit, null);
    assert.equal(status.payload.baseline.tagMatchesCommit, false);

    const result = runJson(repo, ["verify-manifest"]);
    assert.notEqual(result.status, 0);
    assert.equal(result.payload.ok, false);
    assert.deepEqual(
      result.payload.schema.errors.filter((error) =>
        error.path.startsWith("officialStableBaseline"),
      ),
      [{ path: "officialStableBaseline.tag", message: "does not exist locally" }],
    );
  });
});

test("verify-manifest fails when the stable tag peels to a different commit", () => {
  withRepo((repo) => {
    writeManifest(repo.root, {
      officialStableBaseline: { tag: "v1.0.0", commit: repo.ceiling },
      effectiveUpstreamCeiling: {
        remote: "origin",
        ref: "main",
        commit: repo.ceiling,
      },
    });

    const status = runJson(repo, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.payload.baseline.tag, "v1.0.0");
    assert.equal(status.payload.baseline.commit, repo.ceiling);
    assert.equal(status.payload.baseline.exists, true);
    assert.equal(status.payload.baseline.ancestorOfHead, true);
    assert.equal(status.payload.baseline.tagExists, true);
    assert.equal(status.payload.baseline.tagCommit, repo.baseline);
    assert.equal(status.payload.baseline.tagMatchesCommit, false);

    const result = runJson(repo, ["verify-manifest"]);
    assert.notEqual(result.status, 0);
    assert.equal(result.payload.ok, false);
    assert.deepEqual(
      result.payload.schema.errors.filter((error) =>
        error.path.startsWith("officialStableBaseline"),
      ),
      [
        {
          path: "officialStableBaseline.commit",
          message: "does not match officialStableBaseline.tag",
        },
      ],
    );
  });
});

test("status and verify-manifest peel an annotated stable tag to its commit", () => {
  withRepo((repo) => {
    const tagObject = git(repo.root, ["rev-parse", "v1.0.0"], repo.home);
    const tagCommit = git(repo.root, ["rev-parse", "v1.0.0^{commit}"], repo.home);
    assert.notEqual(tagObject, tagCommit);
    assert.equal(tagCommit, repo.baseline);

    const status = runJson(repo, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(Object.keys(status.payload.baseline), [
      "tag",
      "commit",
      "exists",
      "ancestorOfHead",
      "tagExists",
      "tagCommit",
      "tagMatchesCommit",
    ]);
    assert.equal(status.payload.baseline.tag, "v1.0.0");
    assert.equal(status.payload.baseline.commit, repo.baseline);
    assert.equal(status.payload.baseline.tagExists, true);
    assert.equal(status.payload.baseline.tagCommit, tagCommit);
    assert.notEqual(status.payload.baseline.tagCommit, tagObject);
    assert.equal(status.payload.baseline.tagMatchesCommit, true);

    const verify = runJson(repo, ["verify-manifest"]);
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(verify.payload.ok, true);
    assert.deepEqual(verify.payload.schema.errors, []);
    assert.deepEqual(Object.keys(verify.payload.baseline), [
      "tag",
      "commit",
      "exists",
      "ancestorOfHead",
    ]);
    assert.equal(verify.payload.baseline.tag, "v1.0.0");
    assert.equal(verify.payload.baseline.commit, tagCommit);
  });
});

test("preflight-update dereferences an annotated tag to its commit", () => {
  withRepo((repo) => {
    const tagObject = git(repo.root, ["rev-parse", "v1.1.0"], repo.home);
    const tagCommit = git(repo.root, ["rev-parse", "v1.1.0^{commit}"], repo.home);
    assert.notEqual(tagObject, tagCommit);
    assert.equal(tagCommit, repo.ceiling);

    const result = runJson(repo, ["preflight-update", "--tag", "v1.1.0"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.proposed.commit, tagCommit);
    assert.notEqual(result.payload.proposed.commit, tagObject);
    assert.equal(result.payload.relationship, "descendant");
    assert.equal(result.payload.featureHeads[0].ancestorOfProposed, false);
  });
});

test("preflight refuses a dirty tree while status still reports it", () => {
  withRepo((repo) => {
    writeFileSync(join(repo.root, "dirty.txt"), "dirty\n");

    const status = runJson(repo, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.payload.ok, true);
    assert.equal(status.payload.clean, false);
    assert.equal(status.payload.dirty, true);

    const update = runJson(repo, ["preflight-update", "--tag", "v1.1.0"]);
    assert.notEqual(update.status, 0);
    assert.equal(update.payload.ok, false);
    assert.equal(update.payload.error.code, "DIRTY_TREE");
    assert.match(update.stderr, /dirty/i);

    const integrate = runJson(repo, ["preflight-integrate", "--ref", repo.feature]);
    assert.notEqual(integrate.status, 0);
    assert.equal(integrate.payload.error.code, "DIRTY_TREE");
  });
});

test("preflight refuses the wrong branch", () => {
  withRepo((repo) => {
    git(repo.root, ["checkout", "-b", "feat/other"], repo.home);

    const update = runJson(repo, ["preflight-update", "--tag", "v1.1.0"]);
    assert.notEqual(update.status, 0);
    assert.equal(update.payload.error.code, "WRONG_BRANCH");
    assert.match(update.stderr, /integration\/dev/);

    const integrate = runJson(repo, ["preflight-integrate", "--ref", repo.feature]);
    assert.notEqual(integrate.status, 0);
    assert.equal(integrate.payload.error.code, "WRONG_BRANCH");
  });
});

test("preflight-integrate reports an already-included ref", () => {
  withRepo((repo) => {
    const included = runJson(repo, [
      "preflight-integrate",
      "--ref",
      repo.head,
      "--kind",
      "pull-request",
    ]);
    assert.equal(included.status, 0, included.stderr);
    assert.deepEqual(Object.keys(included.payload), [
      "ok",
      "command",
      "kind",
      "ref",
      "sha",
      "mergeBase",
      "alreadyIncluded",
      "candidateContainsHead",
    ]);
    assert.equal(included.payload.ok, true);
    assert.equal(included.payload.kind, "pull-request");
    assert.equal(included.payload.sha, repo.head);
    assert.equal(included.payload.mergeBase, repo.head);
    assert.equal(included.payload.alreadyIncluded, true);
    assert.equal(included.payload.candidateContainsHead, true);

    git(repo.root, ["checkout", "-b", "feat/side"], repo.home);
    writeFileSync(join(repo.root, "side.txt"), "side\n");
    git(repo.root, ["add", "side.txt"], repo.home);
    git(repo.root, ["commit", "-m", "side"], repo.home);
    const side = git(repo.root, ["rev-parse", "HEAD"], repo.home);
    git(repo.root, ["checkout", "integration/dev"], repo.home);

    const pending = runJson(repo, ["preflight-integrate", "--ref", side]);
    assert.equal(pending.status, 0, pending.stderr);
    assert.equal(pending.payload.sha, side);
    assert.equal(pending.payload.alreadyIncluded, false);
    assert.equal(pending.payload.candidateContainsHead, true);
    assert.equal(pending.payload.mergeBase, repo.head);
    assert.equal(pending.payload.kind, "feature");
  });
});

test("status JSON shape is deterministic and ignores caller cwd", () => {
  withRepo((repo) => {
    mkdirSync(join(repo.cwd, ".paseo-integration"), { recursive: true });
    writeFileSync(join(repo.cwd, ".paseo-integration", "manifest.json"), '{"decoy":true}\n');

    const first = runJson(repo, ["status"]);
    const second = runJson(repo, ["status"]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.match(first.stdout, /"command": "status"/);
    assert.equal(/\d{4}-\d{2}-\d{2}T/.test(first.stdout), false);
    assert.deepEqual(Object.keys(first.payload), [
      "ok",
      "command",
      "repoRoot",
      "branch",
      "head",
      "clean",
      "dirty",
      "remotes",
      "manifest",
      "baseline",
      "ceiling",
      "features",
      "installed",
    ]);
    assert.equal(first.payload.repoRoot, repo.root);
    assert.equal(first.payload.branch, "integration/dev");
    assert.equal(first.payload.head, repo.head);
    assert.equal(first.payload.clean, true);
    assert.deepEqual(Object.keys(first.payload.baseline), [
      "tag",
      "commit",
      "exists",
      "ancestorOfHead",
      "tagExists",
      "tagCommit",
      "tagMatchesCommit",
    ]);
    assert.equal(first.payload.baseline.tagExists, true);
    assert.equal(first.payload.baseline.tagCommit, repo.baseline);
    assert.equal(first.payload.baseline.tagMatchesCommit, true);
    assert.deepEqual(Object.keys(first.payload.ceiling), [
      "remote",
      "ref",
      "commit",
      "exists",
      "ancestorOfHead",
      "onOfficialMainLine",
      "isOfficialMainTip",
      "officialMainTip",
      "expectedCommit",
      "matchesExpectedCommit",
    ]);
    assert.equal(first.payload.ceiling.officialMainTip, repo.ceiling);
    assert.equal(first.payload.ceiling.expectedCommit, repo.ceiling);
    assert.equal(first.payload.ceiling.matchesExpectedCommit, true);
    assert.equal(first.payload.manifest.valid, true);
    assert.equal(first.payload.remotes.official.name, "origin");
    assert.equal(first.payload.remotes.official.url, "https://github.com/getpaseo/paseo.git");
    assert.equal(first.payload.remotes.personal[0].name, "sungchul2");
    assert.equal(first.payload.installed.present, false);
    assert.equal(first.payload.installed.path, join(repo.home, ".local", "bin", "paseo"));
    assert.equal(first.payload.installed.version, null);
  });
});

test("status classifies official origin when remote -v has partial-clone decorations", () => {
  withRepo((repo) => {
    git(repo.root, ["config", "remote.origin.promisor", "true"], repo.home);
    git(repo.root, ["config", "remote.origin.partialclonefilter", "blob:none"], repo.home);
    assert.match(git(repo.root, ["remote", "-v"], repo.home), /\(fetch\) \[blob:none\]/);

    const result = runJson(repo, ["status"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.payload.remotes.official.name, "origin");
    assert.equal(result.payload.remotes.official.url, "https://github.com/getpaseo/paseo.git");
  });
});

test("unknown commands refuse with a nonzero status", () => {
  withRepo((repo) => {
    const result = runJson(repo, ["merge"]);
    assert.notEqual(result.status, 0);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.command, "merge");
    assert.equal(result.payload.error.code, "UNKNOWN_COMMAND");
    assert.match(result.stderr, /unknown command: merge/);
    assert.deepEqual(Object.keys(result.payload), ["ok", "command", "error"]);
    assert.deepEqual(Object.keys(result.payload.error), ["code", "message"]);
  });
});

test("build, install, and rollback remain unavailable", () => {
  withRepo((repo) => {
    for (const command of ["build", "install", "rollback"]) {
      const result = runJson(repo, [command]);
      assert.notEqual(result.status, 0, command);
      assert.equal(result.payload.ok, false);
      assert.equal(result.payload.command, command);
      assert.equal(result.payload.error.code, "COMMAND_UNAVAILABLE");
      assert.match(result.stderr, new RegExp(`${command} is not available yet`));
    }
  });
});

test("preflight-update refuses a branch that impersonates a missing stable tag", () => {
  withRepo((repo) => {
    git(repo.root, ["branch", "v1.2.3"], repo.home);
    const branchTip = git(repo.root, ["rev-parse", "--verify", "refs/heads/v1.2.3"], repo.home);
    const generic = git(repo.root, ["rev-parse", "--verify", "v1.2.3^{commit}"], repo.home);
    assert.equal(generic, branchTip);

    const result = runJson(repo, ["preflight-update", "--tag", "v1.2.3"]);
    assert.notEqual(result.status, 0);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error.code, "INVALID_TAG");
    assert.match(result.stderr, /refs\/tags\/v1\.2\.3/);
    assert.equal(Object.hasOwn(result.payload, "proposed"), false);
  });
});

test("status and verify-manifest prove the current positive official-main ceiling", () => {
  withRepo((repo) => {
    const status = runJson(repo, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.payload.ceiling.commit, repo.ceiling);
    assert.equal(status.payload.ceiling.officialMainTip, repo.ceiling);
    assert.equal(status.payload.ceiling.expectedCommit, repo.ceiling);
    assert.equal(status.payload.ceiling.matchesExpectedCommit, true);
    assert.equal(status.payload.ceiling.onOfficialMainLine, true);

    const verify = runJson(repo, ["verify-manifest"]);
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(verify.payload.ok, true);
    assert.deepEqual(verify.payload.schema.errors, []);
    assert.equal(verify.payload.ceiling.commit, repo.ceiling);
    assert.equal(verify.payload.ceiling.officialMainTip, repo.ceiling);
    assert.equal(verify.payload.ceiling.expectedCommit, repo.ceiling);
    assert.equal(verify.payload.ceiling.matchesExpectedCommit, true);
  });
});

test("verify-manifest fails when origin/main is missing", () => {
  withRepo((repo) => {
    git(repo.root, ["update-ref", "-d", "refs/remotes/origin/main"], repo.home);

    const status = runJson(repo, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.payload.ceiling.officialMainTip, null);
    assert.equal(status.payload.ceiling.expectedCommit, null);
    assert.equal(status.payload.ceiling.matchesExpectedCommit, false);

    const result = runJson(repo, ["verify-manifest"]);
    assert.notEqual(result.status, 0);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.ceiling.officialMainTip, null);
    assert.equal(result.payload.ceiling.expectedCommit, null);
    assert.equal(result.payload.ceiling.matchesExpectedCommit, false);
    assert.deepEqual(
      result.payload.schema.errors.filter(
        (error) => error.path === "effectiveUpstreamCeiling.commit",
      ),
      [{ path: "effectiveUpstreamCeiling.commit", message: "origin/main is missing" }],
    );
  });
});

test("verify-manifest fails when a newer origin/main first-parent is already in HEAD", () => {
  withRepo((repo) => {
    git(repo.root, ["update-ref", "refs/remotes/origin/main", repo.feature], repo.home);

    const status = runJson(repo, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.payload.ceiling.commit, repo.ceiling);
    assert.equal(status.payload.ceiling.officialMainTip, repo.feature);
    assert.equal(status.payload.ceiling.expectedCommit, repo.feature);
    assert.equal(status.payload.ceiling.matchesExpectedCommit, false);
    assert.equal(status.payload.ceiling.onOfficialMainLine, true);

    const result = runJson(repo, ["verify-manifest"]);
    assert.notEqual(result.status, 0);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.ceiling.expectedCommit, repo.feature);
    assert.equal(result.payload.ceiling.matchesExpectedCommit, false);
    assert.deepEqual(
      result.payload.schema.errors.filter(
        (error) => error.path === "effectiveUpstreamCeiling.commit",
      ),
      [
        {
          path: "effectiveUpstreamCeiling.commit",
          message: "is not the newest official-main first-parent ancestor of HEAD",
        },
      ],
    );
  });
});

test("verify-manifest fails when the pinned ceiling is a side-branch commit", () => {
  withRepo((repo) => {
    writeManifest(repo.root, {
      officialStableBaseline: { tag: "v1.0.0", commit: repo.baseline },
      effectiveUpstreamCeiling: {
        remote: "origin",
        ref: "main",
        commit: repo.feature,
      },
    });

    const status = runJson(repo, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.payload.ceiling.commit, repo.feature);
    assert.equal(status.payload.ceiling.officialMainTip, repo.ceiling);
    assert.equal(status.payload.ceiling.expectedCommit, repo.ceiling);
    assert.equal(status.payload.ceiling.onOfficialMainLine, false);
    assert.equal(status.payload.ceiling.matchesExpectedCommit, false);

    const result = runJson(repo, ["verify-manifest"]);
    assert.notEqual(result.status, 0);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.ceiling.onOfficialMainLine, false);
    assert.equal(result.payload.ceiling.matchesExpectedCommit, false);
    assert.deepEqual(
      result.payload.schema.errors.filter(
        (error) => error.path === "effectiveUpstreamCeiling.commit",
      ),
      [
        {
          path: "effectiveUpstreamCeiling.commit",
          message: "is not on the official main line",
        },
        {
          path: "effectiveUpstreamCeiling.commit",
          message: "is not the newest official-main first-parent ancestor of HEAD",
        },
      ],
    );
  });
});

test("verify-manifest fails when official origin is absent or invalid", () => {
  withRepo((repo) => {
    git(repo.root, ["remote", "remove", "origin"], repo.home);
    const missing = runJson(repo, ["verify-manifest"]);
    assert.notEqual(missing.status, 0);
    assert.equal(missing.payload.ok, false);
    assert.equal(
      missing.payload.schema.errors.some(
        (error) =>
          error.path === "origin" &&
          error.message === "must be the official getpaseo/paseo remote (https or ssh)",
      ),
      true,
    );
  });
  withRepo((repo) => {
    git(
      repo.root,
      ["remote", "set-url", "origin", "https://github.com/sungchul2/paseo.git"],
      repo.home,
    );
    const invalid = runJson(repo, ["verify-manifest"]);
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.payload.ok, false);
    assert.equal(
      invalid.payload.schema.errors.some(
        (error) =>
          error.path === "origin" &&
          error.message === "must be the official getpaseo/paseo remote (https or ssh)",
      ),
      true,
    );
  });
});
