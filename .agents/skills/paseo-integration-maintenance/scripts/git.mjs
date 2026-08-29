import { spawnSync } from "node:child_process";

export function gitError(message, details = {}) {
  const error = new Error(message);
  error.code = "GIT_ERROR";
  error.details = details;
  return error;
}

export function runGit(repoRoot, args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) {
    throw gitError(`failed to spawn git: ${result.error.message}`, { args });
  }
  return result;
}

export function gitText(repoRoot, args) {
  const result = runGit(repoRoot, args);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw gitError(detail || `git ${args[0]} failed`, { args, status: result.status });
  }
  return result.stdout.trim();
}

export function currentBranch(repoRoot) {
  return gitText(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function currentHead(repoRoot) {
  return gitText(repoRoot, ["rev-parse", "HEAD"]);
}

export function isClean(repoRoot) {
  return gitText(repoRoot, ["status", "--porcelain=v1", "-uall"]) === "";
}

export function resolveCommit(repoRoot, ref) {
  return gitText(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
}

export function inspectTag(repoRoot, tag) {
  if (typeof tag !== "string" || tag === "") {
    return { tagExists: false, tagCommit: null };
  }
  const name = tag.replace(/^refs\/tags\//, "");
  const tagRef = `refs/tags/${name}`;
  const existsResult = runGit(repoRoot, ["rev-parse", "--verify", "--end-of-options", tagRef]);
  if (existsResult.status !== 0) {
    return { tagExists: false, tagCommit: null };
  }
  const peelResult = runGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${tagRef}^{commit}`,
  ]);
  if (peelResult.status !== 0) {
    return { tagExists: true, tagCommit: null };
  }
  return { tagExists: true, tagCommit: peelResult.stdout.trim() };
}

export function objectExists(repoRoot, sha) {
  const result = runGit(repoRoot, ["cat-file", "-e", `${sha}^{commit}`]);
  return result.status === 0;
}

export function isAncestor(repoRoot, ancestor, descendant) {
  const result = runGit(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const detail = (result.stderr || result.stdout).trim();
  throw gitError(detail || "git merge-base --is-ancestor failed", {
    args: ["merge-base", "--is-ancestor", ancestor, descendant],
    status: result.status,
  });
}

export function mergeBase(repoRoot, left, right) {
  return gitText(repoRoot, ["merge-base", left, right]);
}

export function commitRelationship(repoRoot, baseline, proposed) {
  if (baseline === proposed) return "same";
  const proposedIsAncestor = isAncestor(repoRoot, proposed, baseline);
  const baselineIsAncestor = isAncestor(repoRoot, baseline, proposed);
  if (proposedIsAncestor) return "ancestor";
  if (baselineIsAncestor) return "descendant";
  return "diverged";
}

export function normalizeRemoteUrl(url) {
  let value = String(url).trim();
  const scp = /^git@([^:]+):(.+)$/i.exec(value);
  if (scp) {
    value = `${scp[1]}/${scp[2]}`;
  } else {
    try {
      const parsed = new URL(value);
      value = `${parsed.hostname}/${parsed.pathname.replace(/^\/+/, "")}`;
    } catch {
      value = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
    }
  }
  return value
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

function officialRepoPath(pathname) {
  return (
    pathname
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .toLowerCase() === "getpaseo/paseo"
  );
}

export function isOfficialPaseoOriginUrl(url) {
  const value = String(url).trim();
  const scp = /^git@([^:]+):(.+)$/i.exec(value);
  if (scp) {
    return scp[1].toLowerCase() === "github.com" && officialRepoPath(scp[2]);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.hostname.toLowerCase() !== "github.com") return false;
  if (parsed.port !== "" || parsed.search !== "" || parsed.hash !== "") return false;
  if (!officialRepoPath(parsed.pathname)) return false;

  const protocol = parsed.protocol.toLowerCase();
  if (protocol === "https:") {
    return parsed.username === "" && parsed.password === "";
  }
  if (protocol === "ssh:") {
    return parsed.username.toLowerCase() === "git" && parsed.password === "";
  }
  return false;
}

export function redactRemoteUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.username !== "" || parsed.password !== "") {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
  } catch {
    // scp-style remotes have no embeddable token
  }
  return url;
}

export function parseFetchRemoteLine(line) {
  const match = /^(\S+)\s+(\S+)\s+\(fetch\)(?:\s+.*)?$/.exec(String(line));
  if (!match) return null;
  return { name: match[1], url: match[2] };
}

export function listRemotes(repoRoot) {
  const text = gitText(repoRoot, ["remote", "-v"]);
  const byName = new Map();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const parsed = parseFetchRemoteLine(line);
    if (!parsed) continue;
    byName.set(parsed.name, parsed.url);
  }
  return [...byName.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, url]) => ({ name, url }));
}

export function classifyRemotes(remotes) {
  const officialMatches = remotes.filter((remote) => isOfficialPaseoOriginUrl(remote.url));
  const personal = remotes
    .filter((remote) => !isOfficialPaseoOriginUrl(remote.url))
    .map((remote) => ({ name: remote.name, url: redactRemoteUrl(remote.url) }));
  const preferredOfficial =
    officialMatches.find((remote) => remote.name === "origin") ?? officialMatches[0] ?? null;
  return {
    official: preferredOfficial
      ? { name: preferredOfficial.name, url: redactRemoteUrl(preferredOfficial.url) }
      : null,
    personal,
  };
}

const OFFICIAL_MAIN_REF = "refs/remotes/origin/main";
const COMMIT_SHA = /^[0-9a-f]{40}$/;

function isCommitSha(value) {
  return typeof value === "string" && COMMIT_SHA.test(value);
}

function gitLines(repoRoot, args) {
  const text = gitText(repoRoot, args);
  return text === "" ? [] : text.split("\n");
}

function resolveOfficialMainTip(repoRoot) {
  const result = runGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${OFFICIAL_MAIN_REF}^{commit}`,
  ]);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function newestSharedCommit(ordered, allowed) {
  for (const commit of ordered) {
    if (allowed.has(commit)) return commit;
  }
  return null;
}

export function inspectCeiling(repoRoot, ceilingCommit, head) {
  const exists = isCommitSha(ceilingCommit) && objectExists(repoRoot, ceilingCommit);
  const ancestorOfHead = exists && isAncestor(repoRoot, ceilingCommit, head);
  const officialMainTip = resolveOfficialMainTip(repoRoot);
  if (officialMainTip === null) {
    return {
      exists,
      ancestorOfHead,
      officialMainTip: null,
      onOfficialMainLine: false,
      officialMainTipIsAncestorOfHead: false,
      isOfficialMainTip: false,
      expectedCommit: null,
      matchesExpectedCommit: false,
    };
  }

  const firstParents = gitLines(repoRoot, [
    "rev-list",
    "--first-parent",
    "--end-of-options",
    OFFICIAL_MAIN_REF,
  ]);
  const headAncestors = new Set(gitLines(repoRoot, ["rev-list", "--end-of-options", head]));
  const expectedCommit = newestSharedCommit(firstParents, headAncestors);
  return {
    exists,
    ancestorOfHead,
    officialMainTip,
    onOfficialMainLine: exists && firstParents.includes(ceilingCommit),
    officialMainTipIsAncestorOfHead: headAncestors.has(officialMainTip),
    isOfficialMainTip: ceilingCommit === officialMainTip,
    expectedCommit,
    matchesExpectedCommit: expectedCommit !== null && ceilingCommit === expectedCommit,
  };
}
