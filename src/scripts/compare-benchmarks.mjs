// Issue #11 release-gate comparison:
// Merges --json outputs from the same scenario set run under the legacy
// single-stage, temporary layered, and new deterministic modes, then reports
// the acceptance ratios and one-model-call checks.
//
// Usage:
//   npm run benchmark:agent -- --mode single --scenario all --runs 5 --json > benchmark-single.json
//   npm run benchmark:agent -- --mode layered --scenario all --runs 5 --json > benchmark-layered.json
//   npm run benchmark:agent -- --mode deterministic --scenario all --runs 5 --json > benchmark-deterministic.json
//   node scripts/compare-benchmarks.mjs benchmark-single.json benchmark-layered.json benchmark-deterministic.json

import { readFileSync } from "node:fs";

const [singlePath, layeredPath, deterministicPath] = process.argv.slice(2);
if (!singlePath || !layeredPath || !deterministicPath) {
  process.stderr.write(
    "Usage: node scripts/compare-benchmarks.mjs <single.json> <layered.json> <deterministic.json>\n"
  );
  process.exit(1);
}

const single = readJson(singlePath);
const layered = readJson(layeredPath);
const deterministic = readJson(deterministicPath);
const modes = { single, layered, deterministic };

const scenarioIds = Object.keys(deterministic.scenarios ?? {});
const blockedReasons = [];
const scenarioComparison = {};

for (const scenarioId of scenarioIds) {
  const byMode = {};
  for (const [mode, report] of Object.entries(modes)) {
    const result = report.scenarios?.[scenarioId];
    byMode[mode] = result?.status === "completed" ? result.summary : { status: result?.status ?? "missing" };
  }
  scenarioComparison[scenarioId] = byMode;
}

const singleBase = single.scenarios?.simple?.summary;
const layeredBase = layered.scenarios?.simple?.summary;
const deterministicBase = deterministic.scenarios?.simple?.summary;

function ratioMetric(label, key) {
  const singleValue = median(singleBase?.[key]);
  const layeredValue = median(layeredBase?.[key]);
  const deterministicValue = median(deterministicBase?.[key]);
  return {
    label,
    single: singleValue,
    layered: layeredValue,
    deterministic: deterministicValue,
    deterministicVsSingle: ratio(deterministicValue, singleValue),
    deterministicVsLayered: ratio(deterministicValue, layeredValue)
  };
}

const timeToFirstText = ratioMetric("timeToFirstTextMs", "timeToFirstTextMs");
const totalDuration = ratioMetric("totalDurationMs", "totalDurationMs");

const simpleDeterministicRequestCount = median(deterministic.scenarios?.simple?.summary?.modelRequestCount);
if (simpleDeterministicRequestCount !== 1) {
  blockedReasons.push(
    `Simple no-tool deterministic request made ${simpleDeterministicRequestCount} model call(s); expected 1.`
  );
}
if (timeToFirstText.deterministicVsSingle !== null && timeToFirstText.deterministicVsSingle > 1.2) {
  blockedReasons.push(
    `Deterministic median time to first text is ${timeToFirstText.deterministicVsSingle}x legacy single-stage; gate requires <= 1.2x.`
  );
}
if (totalDuration.deterministicVsSingle !== null && totalDuration.deterministicVsSingle > 1.25) {
  blockedReasons.push(
    `Deterministic median total duration is ${totalDuration.deterministicVsSingle}x legacy single-stage; gate requires <= 1.25x.`
  );
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sources: { single: singlePath, layered: layeredPath, deterministic: deterministicPath },
  scenarios: scenarioComparison,
  releaseGate: {
    timeToFirstTextMs: timeToFirstText,
    totalDurationMs: totalDuration,
    simpleDeterministicModelRequestCount: simpleDeterministicRequestCount,
    passed: blockedReasons.length === 0,
    blockedReasons
  }
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    process.stderr.write(`Failed to read ${filePath}: ${error.message}\n`);
    process.exit(1);
  }
}

function median(value) {
  return value?.median ?? null;
}

function ratio(deterministicValue, baselineValue) {
  if (typeof deterministicValue !== "number" || typeof baselineValue !== "number" || baselineValue === 0) {
    return null;
  }
  return Math.round((deterministicValue / baselineValue) * 100) / 100;
}
