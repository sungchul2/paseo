const FULL_SHA = /^[0-9a-f]{40}$/;
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const FEATURE_ROLES = new Set(["owned", "external"]);
const REQUIRED_GATES = new Set(["exact-sha", "verify-ancestry"]);

const TOP_KEYS = [
  "schemaVersion",
  "branch",
  "officialStableBaseline",
  "effectiveUpstreamCeiling",
  "features",
  "verificationGates",
];
const BASELINE_KEYS = ["tag", "commit"];
const CEILING_KEYS = ["remote", "ref", "commit"];
const FEATURE_KEYS = ["number", "owner", "repo", "ref", "head", "role", "status", "open", "url"];
const GATE_KEYS = ["required", "futureStages"];

export const INTEGRATION_BRANCH = "integration/dev";
export const MANIFEST_RELATIVE_PATH = ".paseo-integration/manifest.json";
export const OFFICIAL_CEILING_REMOTE = "origin";
export const OFFICIAL_CEILING_REF = "main";

export function isFullSha(value) {
  return typeof value === "string" && FULL_SHA.test(value);
}

export function normalizeSha(value) {
  return value.toLowerCase();
}

export function isStableTagName(tag) {
  const name = String(tag).replace(/^refs\/tags\//, "");
  return STABLE_TAG.test(name);
}

export function stableTagName(tag) {
  return String(tag).replace(/^refs\/tags\//, "");
}

function unexpectedKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function missingKeys(value, allowed) {
  return allowed.filter((key) => !Object.hasOwn(value, key));
}

function objectAt(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `${path} must be an object`;
  }
  return null;
}

function pushError(errors, path, message) {
  errors.push({ path, message });
}

function validateExactKeys(errors, value, path, allowed) {
  for (const key of missingKeys(value, allowed)) {
    pushError(errors, path ? `${path}.${key}` : key, "is required");
  }
  for (const key of unexpectedKeys(value, allowed)) {
    pushError(errors, path ? `${path}.${key}` : key, "is not allowed");
  }
}

function validateNonEmptyString(errors, value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    pushError(errors, path, "must be a non-empty string");
    return null;
  }
  return value;
}

function validateFullSha(errors, value, path) {
  if (!isFullSha(value)) {
    pushError(errors, path, "must be a full 40-hex SHA");
    return null;
  }
  return normalizeSha(value);
}

function validateBaseline(errors, value) {
  if (objectAt(value, "officialStableBaseline")) {
    pushError(errors, "officialStableBaseline", "must be an object");
    return;
  }
  validateExactKeys(errors, value, "officialStableBaseline", BASELINE_KEYS);
  if (typeof value.tag === "string") {
    if (!isStableTagName(value.tag)) {
      pushError(errors, "officialStableBaseline.tag", "must be a stable tag of the form vX.Y.Z");
    }
  } else if (Object.hasOwn(value, "tag")) {
    pushError(errors, "officialStableBaseline.tag", "must be a stable tag of the form vX.Y.Z");
  }
  if (Object.hasOwn(value, "commit")) {
    validateFullSha(errors, value.commit, "officialStableBaseline.commit");
  }
}

function validateCeiling(errors, value) {
  if (objectAt(value, "effectiveUpstreamCeiling")) {
    pushError(errors, "effectiveUpstreamCeiling", "must be an object");
    return;
  }
  validateExactKeys(errors, value, "effectiveUpstreamCeiling", CEILING_KEYS);
  if (Object.hasOwn(value, "remote")) {
    const remote = validateNonEmptyString(errors, value.remote, "effectiveUpstreamCeiling.remote");
    if (remote !== null && remote !== OFFICIAL_CEILING_REMOTE) {
      pushError(errors, "effectiveUpstreamCeiling.remote", `must be "${OFFICIAL_CEILING_REMOTE}"`);
    }
  }
  if (Object.hasOwn(value, "ref")) {
    const ref = validateNonEmptyString(errors, value.ref, "effectiveUpstreamCeiling.ref");
    if (ref !== null && ref !== OFFICIAL_CEILING_REF) {
      pushError(errors, "effectiveUpstreamCeiling.ref", `must be "${OFFICIAL_CEILING_REF}"`);
    }
  }
  if (Object.hasOwn(value, "commit")) {
    validateFullSha(errors, value.commit, "effectiveUpstreamCeiling.commit");
  }
}

function validateFeature(errors, value, index) {
  const path = `features.${index}`;
  const typeError = objectAt(value, path);
  if (typeError) {
    pushError(errors, path, "must be an object");
    return;
  }
  validateExactKeys(errors, value, path, FEATURE_KEYS);
  if (Object.hasOwn(value, "number") && (!Number.isInteger(value.number) || value.number < 1)) {
    pushError(errors, `${path}.number`, "must be a positive integer");
  }
  if (Object.hasOwn(value, "owner")) {
    validateNonEmptyString(errors, value.owner, `${path}.owner`);
  }
  if (Object.hasOwn(value, "repo")) {
    validateNonEmptyString(errors, value.repo, `${path}.repo`);
  }
  if (Object.hasOwn(value, "ref")) {
    validateNonEmptyString(errors, value.ref, `${path}.ref`);
  }
  if (Object.hasOwn(value, "head")) {
    validateFullSha(errors, value.head, `${path}.head`);
  }
  if (Object.hasOwn(value, "role") && !FEATURE_ROLES.has(value.role)) {
    pushError(errors, `${path}.role`, 'must be "owned" or "external"');
  }
  if (Object.hasOwn(value, "status")) {
    validateNonEmptyString(errors, value.status, `${path}.status`);
  }
  if (Object.hasOwn(value, "open") && typeof value.open !== "boolean") {
    pushError(errors, `${path}.open`, "must be a boolean");
  }
  if (Object.hasOwn(value, "url")) {
    validateNonEmptyString(errors, value.url, `${path}.url`);
  }
}

function validateGates(errors, value) {
  const typeError = objectAt(value, "verificationGates");
  if (typeError) {
    pushError(errors, "verificationGates", "must be an object");
    return;
  }
  validateExactKeys(errors, value, "verificationGates", GATE_KEYS);
  for (const key of GATE_KEYS) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    if (
      !Array.isArray(value[key]) ||
      value[key].some((item) => typeof item !== "string" || item === "")
    ) {
      pushError(errors, `verificationGates.${key}`, "must be an array of non-empty strings");
    }
  }
  if (Array.isArray(value.required)) {
    for (const gate of REQUIRED_GATES) {
      if (!value.required.includes(gate)) {
        pushError(errors, "verificationGates.required", `must include "${gate}"`);
      }
    }
  }
}

export function validateManifest(value) {
  const errors = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: [{ path: "", message: "manifest must be an object" }] };
  }

  validateExactKeys(errors, value, "", TOP_KEYS);

  if (Object.hasOwn(value, "schemaVersion") && value.schemaVersion !== 1) {
    pushError(errors, "schemaVersion", "must be 1");
  }
  if (Object.hasOwn(value, "branch") && value.branch !== INTEGRATION_BRANCH) {
    pushError(errors, "branch", `must be "${INTEGRATION_BRANCH}"`);
  }
  if (Object.hasOwn(value, "officialStableBaseline")) {
    validateBaseline(errors, value.officialStableBaseline);
  }
  if (Object.hasOwn(value, "effectiveUpstreamCeiling")) {
    validateCeiling(errors, value.effectiveUpstreamCeiling);
  }
  if (Object.hasOwn(value, "features")) {
    if (!Array.isArray(value.features)) {
      pushError(errors, "features", "must be an array");
    } else {
      value.features.forEach((feature, index) => validateFeature(errors, feature, index));
    }
  }
  if (Object.hasOwn(value, "verificationGates")) {
    validateGates(errors, value.verificationGates);
  }

  return { valid: errors.length === 0, errors: sortErrors(errors) };
}

export function sortErrors(errors) {
  return [...errors].sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    if (left.message < right.message) return -1;
    if (left.message > right.message) return 1;
    return 0;
  });
}

export function parseManifestSource(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return {
      parsed: false,
      valid: false,
      value: null,
      errors: [{ path: "", message: "manifest is not valid JSON" }],
    };
  }
  const { valid, errors } = validateManifest(value);
  return { parsed: true, valid, value, errors };
}
