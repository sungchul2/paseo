import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nodeRequire = createRequire(import.meta.url);

function findWorktreeRoot(startDir: string): string {
  let directory = startDir;
  for (;;) {
    if (existsSync(path.join(directory, "packages", "client", "package.json"))) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error("Could not find the Paseo worktree root (packages/client/package.json)");
    }
    directory = parent;
  }
}

/**
 * plugin-process.ts imports `@getpaseo/client` via the package `default` export
 * (`./dist/index.js`). Source vitest does not compile that dist. Build only the
 * worktree protocol (if missing) and client artifacts; do not symlink this
 * worktree onto live integration-dev package node_modules.
 */
export function requireWorktreeClientDist(): string {
  const worktreeRoot = findWorktreeRoot(path.dirname(fileURLToPath(import.meta.url)));
  const protocolDist = path.join(worktreeRoot, "packages", "protocol", "dist", "messages.js");
  const clientDist = path.join(worktreeRoot, "packages", "client", "dist", "index.js");
  const setup = [
    `From worktree root: ${worktreeRoot}`,
    "Build only these worktree artifacts (do not symlink live integration-dev deps):",
    "  npx tsc -p packages/protocol/tsconfig.json --incremental false",
    "  npx tsc -p packages/client/tsconfig.json --incremental false",
    "Then from packages/server:",
    "  npm exec --no -- vitest run src/server/plugins/plugin-delivery-offer-ipc.posix.test.ts --maxWorkers=1",
  ].join("\n");

  if (!existsSync(protocolDist)) {
    throw new Error(`Missing worktree protocol dist (${protocolDist}).\n${setup}`);
  }
  if (!existsSync(clientDist)) {
    throw new Error(`Missing worktree client dist (${clientDist}).\n${setup}`);
  }

  let resolved: string;
  try {
    resolved = nodeRequire.resolve("@getpaseo/client");
  } catch (error) {
    throw new Error(
      `@getpaseo/client did not resolve. plugin-process loads dist, not source.\n${setup}`,
      { cause: error },
    );
  }

  const expectedPrefix = path.join(worktreeRoot, "packages", "client") + path.sep;
  if (!resolved.startsWith(expectedPrefix) || !resolved.includes(`${path.sep}dist${path.sep}`)) {
    throw new Error(
      `@getpaseo/client resolved to ${resolved}; expected ${clientDist}. Do not point this worktree at live integration-dev client via symlink.\n${setup}`,
    );
  }

  const source = readFileSync(resolved, "utf8");
  if (!source.includes("agentDeliveryOffer")) {
    throw new Error(
      `${resolved} does not contain agentDeliveryOffer. Rebuild this worktree's client dist.\n${setup}`,
    );
  }
  return resolved;
}
