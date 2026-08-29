#!/usr/bin/env node

import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyRemotes,
  commitRelationship,
  currentBranch,
  currentHead,
  inspectCeiling,
  inspectTag,
  isAncestor,
  isClean,
  isOfficialPaseoOriginUrl,
  listRemotes,
  mergeBase,
  objectExists,
  resolveCommit,
} from "./git.mjs";
import {
  INTEGRATION_BRANCH,
  MANIFEST_RELATIVE_PATH,
  isFullSha,
  normalizeSha,
  parseManifestSource,
  sortErrors,
  stableTagName,
  isStableTagName,
} from "./manifest.mjs";

const UNAVAILABLE_COMMANDS = new Set(["build", "install", "rollback"]);
const FORBIDDEN_OPTIONS = new Set([
  "--force",
  "--skip",
  "--auto-stash",
  "--reset",
  "--rebase",
  "--force-push",
]);
const INTEGRATE_KINDS = new Set(["feature", "pull-request"]);

export class CliError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function resolveRepoRoot(scriptPath = fileURLToPath(import.meta.url)) {
  let dir = dirname(scriptPath);
  while (true) {
    const manifestPath = join(dir, MANIFEST_RELATIVE_PATH);
    try {
      lstatSync(manifestPath);
      return realpathSync(dir);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        throw new CliError(
          "REPO_NOT_FOUND",
          "Could not resolve repo root from the script location",
        );
      }
      dir = parent;
    }
  }
}

function readInstalledVersion(resolvedTarget, home) {
  const paseoHome = join(home, ".paseo");
  if (resolvedTarget === paseoHome || resolvedTarget.startsWith(paseoHome + sep)) {
    return null;
  }

  let dir = dirname(resolvedTarget);
  for (let depth = 0; depth < 6; depth += 1) {
    if (dir === paseoHome || dir.startsWith(paseoHome + sep)) {
      return null;
    }
    const packagePath = join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      if (
        typeof pkg.version === "string" &&
        (pkg.name === "paseo" ||
          (typeof pkg.name === "string" && pkg.name.startsWith("@getpaseo/")))
      ) {
        return pkg.version;
      }
    } catch {
      // Keep walking; missing or unreadable package.json is not a version source.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function inspectInstalledPaseo(home) {
  const installedPath = join(home, ".local", "bin", "paseo");
  const absent = {
    present: false,
    path: installedPath,
    symlink: false,
    target: null,
    resolvedTarget: null,
    version: null,
  };
  let stat;
  try {
    stat = lstatSync(installedPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return absent;
    throw new CliError("INSTALLED_INSPECT_FAILED", `failed to inspect ${installedPath}`);
  }

  const installed = {
    present: true,
    path: installedPath,
    symlink: stat.isSymbolicLink(),
    target: null,
    resolvedTarget: null,
    version: null,
  };
  if (installed.symlink) {
    installed.target = readlinkSync(installedPath);
    try {
      installed.resolvedTarget = realpathSync(installedPath);
    } catch {
      installed.resolvedTarget = null;
    }
  }
  if (installed.resolvedTarget) {
    installed.version = readInstalledVersion(installed.resolvedTarget, home);
  }
  return installed;
}

function loadManifest(repoRoot) {
  const path = join(repoRoot, MANIFEST_RELATIVE_PATH);
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return {
      path: MANIFEST_RELATIVE_PATH,
      parsed: false,
      valid: false,
      value: null,
      errors: [{ path: "", message: "manifest file is missing" }],
    };
  }
  const parsed = parseManifestSource(source);
  return { path: MANIFEST_RELATIVE_PATH, ...parsed };
}

function ancestryReport(repoRoot, sha, head) {
  const exists = isFullSha(sha) && objectExists(repoRoot, sha);
  return {
    exists,
    ancestorOfHead: exists && isAncestor(repoRoot, sha, head),
  };
}

function asObject(value) {
  return value && typeof value === "object" ? value : null;
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function shaFromValue(value) {
  return typeof value === "string" ? normalizeSha(value) : "";
}

function shaFromObject(parent, key) {
  return parent && typeof parent[key] === "string" ? normalizeSha(parent[key]) : "";
}

function stringFromObject(parent, key) {
  return parent && typeof parent[key] === "string" ? parent[key] : "";
}

function inspectAncestry(repoRoot, sha, head) {
  return isFullSha(sha)
    ? ancestryReport(repoRoot, sha, head)
    : { exists: false, ancestorOfHead: false };
}

function pushAncestryError(errors, path, ancestry, sha) {
  if (!isFullSha(sha)) return;
  if (!ancestry.exists) {
    errors.push({ path, message: "is not a Git commit object" });
    return;
  }
  if (!ancestry.ancestorOfHead) {
    errors.push({ path, message: "is not an ancestor of HEAD" });
  }
}

function baselineTagReport(repoRoot, tag, commit) {
  const inspected = inspectTag(repoRoot, tag);
  const tagMatchesCommit =
    inspected.tagCommit !== null && isFullSha(commit) && inspected.tagCommit === commit;
  return {
    tagExists: inspected.tagExists,
    tagCommit: inspected.tagCommit,
    tagMatchesCommit,
  };
}

function pushTagResolutionErrors(errors, tag, tagReport, commit) {
  if (tag === "") return;
  if (!tagReport.tagExists) {
    errors.push({
      path: "officialStableBaseline.tag",
      message: "does not exist locally",
    });
    return;
  }
  if (tagReport.tagCommit === null) {
    errors.push({
      path: "officialStableBaseline.tag",
      message: "does not dereference to a commit",
    });
    return;
  }
  if (isFullSha(commit) && !tagReport.tagMatchesCommit) {
    errors.push({
      path: "officialStableBaseline.commit",
      message: "does not match officialStableBaseline.tag",
    });
  }
}

function statusBaseline(raw, repoRoot, head) {
  const source = raw ? asObject(raw.officialStableBaseline) : null;
  if (!source) return null;
  const commit = shaFromValue(source.commit);
  const tag = stringOrEmpty(source.tag);
  const ancestry = inspectAncestry(repoRoot, commit, head);
  const tagReport = baselineTagReport(repoRoot, tag, commit);
  return {
    tag,
    commit,
    exists: ancestry.exists,
    ancestorOfHead: ancestry.ancestorOfHead,
    tagExists: tagReport.tagExists,
    tagCommit: tagReport.tagCommit,
    tagMatchesCommit: tagReport.tagMatchesCommit,
  };
}

function statusCeiling(raw, repoRoot, head) {
  const source = raw ? asObject(raw.effectiveUpstreamCeiling) : null;
  if (!source) return null;
  const commit = shaFromValue(source.commit);
  const inspected = inspectCeiling(repoRoot, commit, head);
  return {
    remote: stringOrEmpty(source.remote),
    ref: stringOrEmpty(source.ref),
    commit,
    exists: inspected.exists,
    ancestorOfHead: inspected.ancestorOfHead,
    onOfficialMainLine: inspected.onOfficialMainLine,
    isOfficialMainTip: inspected.isOfficialMainTip,
    officialMainTip: inspected.officialMainTip,
    expectedCommit: inspected.expectedCommit,
    matchesExpectedCommit: inspected.matchesExpectedCommit,
  };
}

function statusFeature(feature, repoRoot, head) {
  if (!feature || typeof feature !== "object") return null;
  const headSha = shaFromValue(feature.head);
  const ancestry = inspectAncestry(repoRoot, headSha, head);
  return {
    number: integerOrNull(feature.number),
    owner: stringOrEmpty(feature.owner),
    repo: stringOrEmpty(feature.repo),
    ref: stringOrEmpty(feature.ref),
    head: headSha,
    role: stringOrEmpty(feature.role),
    status: stringOrEmpty(feature.status),
    open: booleanOrNull(feature.open),
    url: stringOrEmpty(feature.url),
    exists: ancestry.exists,
    ancestorOfHead: ancestry.ancestorOfHead,
  };
}

function statusFeatures(raw, repoRoot, head) {
  const features = [];
  if (!raw || !Array.isArray(raw.features)) return features;
  for (const feature of raw.features) {
    const mapped = statusFeature(feature, repoRoot, head);
    if (mapped) features.push(mapped);
  }
  return features;
}

function verifyBaseline(raw, repoRoot, head, schemaErrors) {
  const source = raw ? raw.officialStableBaseline : null;
  const commit = shaFromObject(source, "commit");
  const tag = stringFromObject(source, "tag");
  const ancestry = inspectAncestry(repoRoot, commit, head);
  const tagReport = baselineTagReport(repoRoot, tag, commit);
  pushAncestryError(schemaErrors, "officialStableBaseline.commit", ancestry, commit);
  pushTagResolutionErrors(schemaErrors, tag, tagReport, commit);
  return {
    tag,
    commit,
    exists: ancestry.exists,
    ancestorOfHead: ancestry.ancestorOfHead,
  };
}

function pushCeilingProofErrors(schemaErrors, ceiling) {
  if (ceiling.officialMainTip === null) {
    schemaErrors.push({
      path: "effectiveUpstreamCeiling.commit",
      message: "origin/main is missing",
    });
    return;
  }
  if (ceiling.expectedCommit === null) {
    schemaErrors.push({
      path: "effectiveUpstreamCeiling.commit",
      message: "no official-main ancestor of HEAD can be proven",
    });
    return;
  }
  if (!ceiling.onOfficialMainLine) {
    schemaErrors.push({
      path: "effectiveUpstreamCeiling.commit",
      message: "is not on the official main line",
    });
  }
  if (!ceiling.matchesExpectedCommit) {
    schemaErrors.push({
      path: "effectiveUpstreamCeiling.commit",
      message: "is not the newest official-main first-parent ancestor of HEAD",
    });
  }
  if (ceiling.isOfficialMainTip && !ceiling.officialMainTipIsAncestorOfHead) {
    schemaErrors.push({
      path: "effectiveUpstreamCeiling.commit",
      message: "claims origin/main tip, but that tip is not an ancestor of HEAD",
    });
  }
}

function verifyOfficialOrigin(repoRoot, schemaErrors) {
  const remotes = listRemotes(repoRoot);
  const origin = remotes.find((remote) => remote.name === "origin");
  if (origin && isOfficialPaseoOriginUrl(origin.url)) return;
  schemaErrors.push({
    path: "origin",
    message: "must be the official getpaseo/paseo remote (https or ssh)",
  });
}

function verifyCeiling(raw, repoRoot, head, schemaErrors) {
  const source = raw ? raw.effectiveUpstreamCeiling : null;
  const commit = shaFromObject(source, "commit");
  const ceiling = inspectCeiling(repoRoot, commit, head);
  pushAncestryError(schemaErrors, "effectiveUpstreamCeiling.commit", ceiling, commit);
  pushCeilingProofErrors(schemaErrors, ceiling);
  return {
    remote: stringFromObject(source, "remote"),
    ref: stringFromObject(source, "ref"),
    commit,
    exists: ceiling.exists,
    ancestorOfHead: ceiling.ancestorOfHead,
    onOfficialMainLine: ceiling.onOfficialMainLine,
    isOfficialMainTip: ceiling.isOfficialMainTip,
    officialMainTipIsAncestorOfHead: ceiling.officialMainTipIsAncestorOfHead,
    officialMainTip: ceiling.officialMainTip,
    expectedCommit: ceiling.expectedCommit,
    matchesExpectedCommit: ceiling.matchesExpectedCommit,
  };
}

function verifyFeature(feature, index, repoRoot, head, schemaErrors) {
  if (!feature || typeof feature !== "object") return null;
  const headSha = shaFromValue(feature.head);
  const ancestry = inspectAncestry(repoRoot, headSha, head);
  pushAncestryError(schemaErrors, `features.${index}.head`, ancestry, headSha);
  return {
    number: integerOrNull(feature.number),
    head: headSha,
    role: stringOrEmpty(feature.role),
    exists: ancestry.exists,
    ancestorOfHead: ancestry.ancestorOfHead,
  };
}

function verifyFeatures(raw, repoRoot, head, schemaErrors) {
  const features = [];
  if (!raw || !Array.isArray(raw.features)) return features;
  raw.features.forEach((feature, index) => {
    const mapped = verifyFeature(feature, index, repoRoot, head, schemaErrors);
    if (mapped) features.push(mapped);
  });
  return features;
}

function verifyBranch(raw, branch, schemaErrors) {
  const manifestBranch = raw && typeof raw.branch === "string" ? raw.branch : "";
  const matches = branch === manifestBranch && manifestBranch === INTEGRATION_BRANCH;
  if (!matches) {
    schemaErrors.push({
      path: "branch",
      message: `current branch ${branch} must match manifest branch ${INTEGRATION_BRANCH}`,
    });
  }
  return {
    current: branch,
    manifest: manifestBranch,
    matches,
  };
}

function requireIntegrationBranch(branch) {
  if (branch !== INTEGRATION_BRANCH) {
    throw new CliError(
      "WRONG_BRANCH",
      `current branch must be ${INTEGRATION_BRANCH}, got ${branch}`,
    );
  }
}

function requireCleanTree(clean) {
  if (!clean) {
    throw new CliError("DIRTY_TREE", "working tree is dirty");
  }
}

function requireOfficialOrigin(repoRoot) {
  const remotes = listRemotes(repoRoot);
  const origin = remotes.find((remote) => remote.name === "origin");
  if (!origin || !isOfficialPaseoOriginUrl(origin.url)) {
    throw new CliError(
      "INVALID_ORIGIN",
      "origin must be the official getpaseo/paseo remote (https or ssh)",
    );
  }
  return origin;
}

function requireStableTagCommit(repoRoot, tag) {
  const name = stableTagName(tag);
  const inspected = inspectTag(repoRoot, name);
  if (!inspected.tagExists) {
    throw new CliError("INVALID_TAG", `stable tag refs/tags/${name} does not exist`);
  }
  if (inspected.tagCommit === null) {
    throw new CliError(
      "INVALID_TAG",
      `stable tag refs/tags/${name} does not dereference to a commit`,
    );
  }
  return { tag: name, commit: inspected.tagCommit };
}

function statusPayload(repoRoot, home) {
  const branch = currentBranch(repoRoot);
  const head = currentHead(repoRoot);
  const clean = isClean(repoRoot);
  const remotes = classifyRemotes(listRemotes(repoRoot));
  const manifest = loadManifest(repoRoot);
  const raw = manifest.value;

  return {
    ok: true,
    command: "status",
    repoRoot,
    branch,
    head,
    clean,
    dirty: !clean,
    remotes,
    manifest: {
      path: manifest.path,
      parsed: manifest.parsed,
      valid: manifest.valid,
      errors: manifest.errors,
    },
    baseline: statusBaseline(raw, repoRoot, head),
    ceiling: statusCeiling(raw, repoRoot, head),
    features: statusFeatures(raw, repoRoot, head),
    installed: inspectInstalledPaseo(home),
  };
}

function verifyManifestPayload(repoRoot) {
  const branch = currentBranch(repoRoot);
  const head = currentHead(repoRoot);
  const manifest = loadManifest(repoRoot);
  const raw = manifest.value;
  const schemaErrors = [...manifest.errors];
  verifyOfficialOrigin(repoRoot, schemaErrors);
  const baseline = verifyBaseline(raw, repoRoot, head, schemaErrors);
  const ceiling = verifyCeiling(raw, repoRoot, head, schemaErrors);
  const features = verifyFeatures(raw, repoRoot, head, schemaErrors);
  const branchInfo = verifyBranch(raw, branch, schemaErrors);
  const valid = schemaErrors.length === 0;

  return {
    ok: valid,
    command: "verify-manifest",
    head,
    branch: branchInfo,
    schema: {
      valid,
      errors: sortErrors(schemaErrors),
    },
    baseline,
    ceiling,
    features,
  };
}

function requireValidManifest(repoRoot) {
  const manifest = loadManifest(repoRoot);
  if (!manifest.valid) {
    const first = manifest.errors[0];
    const detail = first
      ? `${first.path ? `${first.path}: ` : ""}${first.message}`
      : "invalid manifest";
    throw new CliError("INVALID_MANIFEST", detail, { errors: manifest.errors });
  }
  return manifest.value;
}

function preflightUpdatePayload(repoRoot, tag) {
  if (!tag) {
    throw new CliError("MISSING_ARGUMENT", "preflight-update requires --tag <tag>");
  }
  if (!isStableTagName(tag)) {
    throw new CliError("INVALID_TAG", "tag must be a stable vX.Y.Z release");
  }

  const branch = currentBranch(repoRoot);
  requireIntegrationBranch(branch);
  requireCleanTree(isClean(repoRoot));
  requireOfficialOrigin(repoRoot);

  const manifest = requireValidManifest(repoRoot);
  const proposed = requireStableTagCommit(repoRoot, tag);
  const baselineCommit = normalizeSha(manifest.officialStableBaseline.commit);
  const proposedTag = proposed.tag;
  const proposedCommit = proposed.commit;
  const featureHeads = manifest.features.map((feature) => {
    const head = normalizeSha(feature.head);
    return {
      number: feature.number,
      head,
      role: feature.role,
      ancestorOfProposed:
        objectExists(repoRoot, head) && isAncestor(repoRoot, head, proposedCommit),
    };
  });

  return {
    ok: true,
    command: "preflight-update",
    tag: proposedTag,
    proposed: { tag: proposedTag, commit: proposedCommit },
    baseline: {
      tag: manifest.officialStableBaseline.tag,
      commit: baselineCommit,
    },
    relationship: commitRelationship(repoRoot, baselineCommit, proposedCommit),
    featureHeads,
  };
}

function preflightIntegratePayload(repoRoot, ref, kind) {
  if (!ref) {
    throw new CliError("MISSING_ARGUMENT", "preflight-integrate requires --ref <ref-or-sha>");
  }
  const resolvedKind = kind ?? "feature";
  if (!INTEGRATE_KINDS.has(resolvedKind)) {
    throw new CliError("INVALID_KIND", '--kind must be "feature" or "pull-request"');
  }

  const branch = currentBranch(repoRoot);
  requireIntegrationBranch(branch);
  requireCleanTree(isClean(repoRoot));

  const sha = resolveCommit(repoRoot, ref);
  const head = currentHead(repoRoot);
  const base = mergeBase(repoRoot, head, sha);

  return {
    ok: true,
    command: "preflight-integrate",
    kind: resolvedKind,
    ref,
    sha,
    mergeBase: base,
    alreadyIncluded: base === sha,
    candidateContainsHead: base === head,
  };
}

function parseArgv(argv) {
  const flags = {
    json: false,
    tag: null,
    ref: null,
    kind: null,
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--tag" || arg === "--ref" || arg === "--kind") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError("MISSING_ARGUMENT", `${arg} requires a value`);
      }
      flags[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (FORBIDDEN_OPTIONS.has(arg)) {
      throw new CliError("FORBIDDEN_OPTION", `${arg} is not allowed`);
    }
    if (arg.startsWith("--")) {
      throw new CliError("UNKNOWN_OPTION", `unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length > 1) {
    throw new CliError(
      "UNKNOWN_COMMAND",
      `unexpected arguments: ${positionals.slice(1).join(" ")}`,
    );
  }

  return { command: positionals[0] ?? "", flags };
}

function formatErrors(errors) {
  if (!errors || errors.length === 0) return "none";
  return errors
    .map((error) => (error.path ? `${error.path}: ${error.message}` : error.message))
    .join("\n  ");
}

function formatRemote(remote) {
  if (!remote) return "(none)";
  return `${remote.name} ${remote.url}`;
}

function ancestryLabel(isAncestorOfHead) {
  return isAncestorOfHead ? "ancestor of HEAD" : "not ancestor of HEAD";
}

function tagResolutionLabel(baseline) {
  if (!baseline.tagExists) return "tag missing";
  if (baseline.tagMatchesCommit) return "tag matches commit";
  return "tag does not match commit";
}

function formatBaselineLine(baseline) {
  if (!baseline) return "(none)";
  const line = `${baseline.tag} ${baseline.commit} ${ancestryLabel(baseline.ancestorOfHead)}`;
  if (!Object.hasOwn(baseline, "tagExists")) return line;
  return `${line} ${tagResolutionLabel(baseline)}`;
}

function formatCeilingLine(ceiling) {
  if (!ceiling) return "(none)";
  return `${ceiling.remote}/${ceiling.ref} ${ceiling.commit} ${ancestryLabel(ceiling.ancestorOfHead)}`;
}

function formatInstalledLine(installed) {
  if (!installed.present) return "(none)";
  if (installed.symlink) return `${installed.path} -> ${installed.target}`;
  return installed.path;
}

function formatFeatureLines(features, render) {
  if (features.length === 0) return "  (none)";
  return features.map(render).join("\n");
}

function formatHuman(payload) {
  if (payload.command === "status") {
    const personal =
      payload.remotes.personal.length === 0
        ? "(none)"
        : payload.remotes.personal.map(formatRemote).join("\n  ");
    return (
      [
        `branch: ${payload.branch}`,
        `head: ${payload.head}`,
        `tree: ${payload.clean ? "clean" : "dirty"}`,
        `official remote: ${formatRemote(payload.remotes.official)}`,
        `personal remote: ${personal}`,
        `manifest: ${payload.manifest.valid ? "valid" : "invalid"}`,
        `manifest errors: ${formatErrors(payload.manifest.errors)}`,
        `baseline: ${formatBaselineLine(payload.baseline)}`,
        `ceiling: ${formatCeilingLine(payload.ceiling)}`,
        "features:",
        formatFeatureLines(
          payload.features,
          (feature) =>
            `  #${feature.number} ${feature.role} ${feature.head} ${ancestryLabel(feature.ancestorOfHead)}`,
        ),
        `installed: ${formatInstalledLine(payload.installed)}`,
        payload.installed.version ? `cli version: ${payload.installed.version}` : null,
      ]
        .filter((line) => line !== null)
        .join("\n") + "\n"
    );
  }

  if (payload.command === "verify-manifest") {
    return (
      [
        `verify-manifest: ${payload.ok ? "ok" : "invalid"}`,
        `head: ${payload.head}`,
        `branch current: ${payload.branch.current}`,
        `branch manifest: ${payload.branch.manifest}`,
        `branch matches: ${payload.branch.matches ? "yes" : "no"}`,
        `schema: ${payload.schema.valid ? "valid" : "invalid"}`,
        `errors: ${formatErrors(payload.schema.errors)}`,
        `baseline: ${formatBaselineLine(payload.baseline)}`,
        `ceiling: ${formatCeilingLine(payload.ceiling)}`,
        "features:",
        formatFeatureLines(
          payload.features,
          (feature) =>
            `  #${feature.number} ${feature.head} ${ancestryLabel(feature.ancestorOfHead)}`,
        ),
      ].join("\n") + "\n"
    );
  }

  if (payload.command === "preflight-update") {
    return (
      [
        "preflight-update: ok",
        `tag: ${payload.tag}`,
        `proposed: ${payload.proposed.commit}`,
        `baseline: ${payload.baseline.tag} ${payload.baseline.commit}`,
        `relationship: ${payload.relationship}`,
        "feature heads:",
        formatFeatureLines(payload.featureHeads, (feature) => {
          const relation = feature.ancestorOfProposed
            ? "ancestor of proposed"
            : "not ancestor of proposed";
          return `  #${feature.number} ${feature.head} ${relation}`;
        }),
      ].join("\n") + "\n"
    );
  }

  if (payload.command === "preflight-integrate") {
    return (
      [
        "preflight-integrate: ok",
        `kind: ${payload.kind}`,
        `ref: ${payload.ref}`,
        `sha: ${payload.sha}`,
        `mergeBase: ${payload.mergeBase}`,
        `alreadyIncluded: ${payload.alreadyIncluded ? "yes" : "no"}`,
        `candidateContainsHead: ${payload.candidateContainsHead ? "yes" : "no"}`,
      ].join("\n") + "\n"
    );
  }

  return `${payload.command}: ok\n`;
}

function writeJson(stdout, payload) {
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function resolveIo(options) {
  return {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    env: options.env ?? process.env,
    scriptPath: options.scriptPath ?? fileURLToPath(import.meta.url),
  };
}

function requireHome(env) {
  const home = typeof env.HOME === "string" && env.HOME !== "" ? env.HOME : "";
  if (home === "") {
    throw new CliError("MISSING_HOME", "HOME is required");
  }
  return home;
}

function requireKnownCommand(command) {
  if (command === "") {
    throw new CliError(
      "UNKNOWN_COMMAND",
      "usage: integration.mjs status|verify-manifest|preflight-update|preflight-integrate",
    );
  }
  if (UNAVAILABLE_COMMANDS.has(command)) {
    throw new CliError("COMMAND_UNAVAILABLE", `${command} is not available yet`);
  }
  if (
    command !== "status" &&
    command !== "verify-manifest" &&
    command !== "preflight-update" &&
    command !== "preflight-integrate"
  ) {
    throw new CliError("UNKNOWN_COMMAND", `unknown command: ${command}`);
  }
}

function commandPayload(command, repoRoot, home, flags) {
  if (command === "status") return statusPayload(repoRoot, home);
  if (command === "verify-manifest") return verifyManifestPayload(repoRoot);
  if (command === "preflight-update") return preflightUpdatePayload(repoRoot, flags.tag);
  return preflightIntegratePayload(repoRoot, flags.ref, flags.kind);
}

function writeSuccess(stdout, payload, json) {
  if (json) {
    writeJson(stdout, payload);
  } else {
    stdout.write(formatHuman(payload));
  }
  return payload.ok ? 0 : 1;
}

export function main(argv, options = {}) {
  const { stdout, stderr, env, scriptPath } = resolveIo(options);

  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    return writeFailure(error, argv[0] ?? "", Boolean(argv.includes("--json")), stdout, stderr);
  }

  const { command, flags } = parsed;
  try {
    requireKnownCommand(command);
    const repoRoot = resolveRepoRoot(scriptPath);
    const home = requireHome(env);
    const payload = commandPayload(command, repoRoot, home, flags);
    return writeSuccess(stdout, payload, flags.json);
  } catch (error) {
    return writeFailure(error, command, flags.json, stdout, stderr);
  }
}

function writeFailure(error, command, json, stdout, stderr) {
  const code = typeof error.code === "string" ? error.code : "ERROR";
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`${message}\n`);
  if (json) {
    writeJson(stdout, {
      ok: false,
      command,
      error: { code, message },
    });
  }
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
