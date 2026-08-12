// Issue #11 release-gate benchmark:
// - Runs the same provider/model/prompt/tool catalog through the legacy
//   single-stage mode, the temporary layered rollback mode, and the new
//   deterministic default mode.
// - Covers simple no-tool, one read-only tool, TTL-valid repeated read-only,
//   long-conversation, and a generically named installed plugin after reload.
// - Never prints or persists API keys / authorization headers.
//
// Usage (start the server with SECOPS_AGENT_ROUTING_MODE=<mode>):
//   npm run benchmark:agent -- --mode deterministic --scenario all --runs 5 --json
// Compare modes by saving --json output per mode and reviewing the summary.

const SCENARIOS = {
  simple: {
    id: "simple-no-tools-v2",
    build: () => ({
      messages: [{ role: "user", content: "Reply with a concise acknowledgement. Do not call tools." }],
      enabledTools: [],
      permissionMode: "deny"
    }),
    expect: { modelRequestCount: 1 }
  },
  "read-tool": {
    id: "read-only-tool-v2",
    build: () => ({
      messages: [{
        role: "user",
        content: "Use the threat.intel.lookup tool to look up IOC 198.51.100.23. Call the tool exactly once."
      }],
      enabledTools: ["threat.intel.lookup"],
      permissionMode: "auto"
    }),
    expect: { modelRequestCount: 1, toolHandlerCalls: 1 }
  },
  "cached-read": {
    id: "ttl-repeated-read-only-v2",
    build: () => ({
      messages: [{
        role: "user",
        content: "Use the threat.intel.lookup tool to look up IOC 198.51.100.23. Call the tool exactly once."
      }],
      enabledTools: ["threat.intel.lookup"],
      permissionMode: "auto"
    }),
    expect: { modelRequestCount: 1, toolHandlerCalls: 1 }
  },
  "long-context": {
    id: "long-conversation-v2",
    build: () => {
      const messages = [];
      for (let index = 0; index < 12; index += 1) {
        messages.push({ role: "user", content: `Context fact ${index}: the investigation concerns sample-${index}.` });
        messages.push({ role: "assistant", content: `Acknowledged fact ${index}.` });
      }
      messages.push({ role: "user", content: "Reply with a concise acknowledgement. Do not call tools." });
      return { messages, enabledTools: [], permissionMode: "deny" };
    },
    expect: { modelRequestCount: 1 }
  },
  "plugin-reload": {
    id: "generic-plugin-after-reload-v2",
    build: () => undefined,
    expect: { modelRequestCount: 1 }
  }
};

const MODES = ["single", "layered", "deterministic"];

const options = parseOptions(process.argv.slice(2));
const authHeaders = (() => {
  const token = process.env.SECOPS_API_TOKEN?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
})();

try {
  const report = await runBenchmark(options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Agent benchmark failed: ${redact(message)}\n`);
  process.exitCode = 1;
}

async function runBenchmark({ baseUrl, runs, mode, scenario }) {
  const scenarioIds = scenario === "all" ? Object.keys(SCENARIOS) : [scenario];
  const scenarios = {};
  for (const scenarioId of scenarioIds) {
    if (!SCENARIOS[scenarioId]) {
      throw new Error(`Unknown scenario: ${scenarioId}. Expected one of ${Object.keys(SCENARIOS).join(", ")}`);
    }
    scenarios[scenarioId] = await runScenario(baseUrl, scenarioId, runs);
  }
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    mode,
    baseUrl,
    runs,
    scenarios
  };
}

async function runScenario(baseUrl, scenarioId, runs) {
  const definition = SCENARIOS[scenarioId];
  if (scenarioId === "plugin-reload") {
    return runPluginReloadScenario(baseUrl);
  }
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const run = await executeRun(baseUrl, definition.build());
    samples.push(runMetrics(run));
  }
  const summary = summarizeSamples(samples);
  summary.expectation = definition.expect;
  return {
    status: "completed",
    samples,
    summary
  };
}

async function runPluginReloadScenario(baseUrl) {
  const reloadResponse = await fetch(`${baseUrl}/api/plugins/reload`, {
    method: "POST",
    headers: authHeaders
  });
  if (!reloadResponse.ok) {
    return {
      status: "error",
      error: `Plugin reload returned HTTP ${reloadResponse.status}`
    };
  }
  const toolsResponse = await fetch(`${baseUrl}/api/tools`, { headers: authHeaders });
  if (!toolsResponse.ok) {
    return { status: "error", error: `GET /api/tools returned HTTP ${toolsResponse.status}` };
  }
  const toolsResult = await toolsResponse.json();
  const tools = Array.isArray(toolsResult.tools) ? toolsResult.tools : [];
  const pluginsResponse = await fetch(`${baseUrl}/api/plugins`, { headers: authHeaders });
  if (!pluginsResponse.ok) {
    return { status: "error", error: `GET /api/plugins returned HTTP ${pluginsResponse.status}` };
  }
  const pluginsResult = await pluginsResponse.json();
  const pluginIds = (Array.isArray(pluginsResult.plugins) ? pluginsResult.plugins : []).map((plugin) => plugin.id);
  if (pluginIds.length === 0) {
    return {
      status: "skipped",
      error: "No plugin installed; install a generically named plugin and rerun."
    };
  }
  const candidate = tools.find((tool) => (
    tool.mcpCompatible === true
    && tool.toolClass !== "action"
    && tool.deferLoading === true
    && pluginIds.some((pluginId) => (
      Array.isArray(tool.tags) && tool.tags.includes(pluginId)
      || (typeof tool.id === "string" && tool.id.startsWith(`${pluginId}.`))
    ))
  ));
  if (!candidate) {
    return {
      status: "skipped",
      error: "No deferred non-action tool from an installed plugin found; install a generically named plugin and rerun."
    };
  }
  const prompt = `Use the ${candidate.name} tool (${candidate.id}) to ${candidate.description}. Call the tool once if it applies.`;
  const run = await executeRun(baseUrl, {
    messages: [{ role: "user", content: prompt }],
    enabledTools: [candidate.id],
    permissionMode: "auto"
  });
  const metrics = runMetrics(run);
  const routed = Array.isArray(run.routing?.selectedToolIds)
    ? run.routing.selectedToolIds.includes(candidate.id)
    : false;
  return {
    status: "completed",
    tool: { id: candidate.id, name: candidate.name },
    routed,
    run: metrics,
    summary: {
      ...summarizeSamples([metrics]),
      routed,
      expectation: { modelRequestCount: 1, routed }
    }
  };
}

async function executeRun(baseUrl, request) {
  const observedStartedAt = performance.now();
  const headers = { "content-type": "application/json", ...authHeaders };
  const response = await fetch(`${baseUrl}/api/agent/run`, {
    method: "POST",
    headers,
    body: JSON.stringify(request)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from agent run endpoint`);
  }
  const run = await response.json();
  if (!run || typeof run !== "object" || !run.metrics || run.metrics.schemaVersion !== 1) {
    throw new Error("Agent run response does not contain metrics schema version 1");
  }
  return {
    ...run,
    clientObservedDurationMs: round(performance.now() - observedStartedAt)
  };
}

function runMetrics(run) {
  const metrics = run.metrics;
  return {
    status: run.status,
    mode: metrics.mode,
    clientObservedDurationMs: run.clientObservedDurationMs,
    totalDurationMs: metrics.totalDurationMs,
    localOrchestrationDurationMs: metrics.localOrchestrationDurationMs,
    localRoutingDurationMs: metrics.localRoutingDurationMs,
    timeToFirstTextMs: metrics.text?.timeToFirstTextMs,
    modelRequestCount: metrics.model?.requestCount,
    modelRetryCount: metrics.model?.retryCount,
    modelTotalDurationMs: metrics.model?.totalDurationMs,
    inputTokens: tokenTotal(metrics, "inputTokens"),
    outputTokens: tokenTotal(metrics, "outputTokens"),
    reasoningTokens: tokenTotal(metrics, "reasoningTokens"),
    toolCallCount: metrics.tools?.callCount,
    toolHandlerCallCount: metrics.tools?.handlerCallCount,
    toolTotalDurationMs: metrics.tools?.totalDurationMs,
    cacheHits: metrics.cache?.hits,
    cacheMisses: metrics.cache?.misses,
    cacheBypasses: metrics.cache?.bypasses,
    cacheEvictions: metrics.cache?.evictions,
    cacheExpiredEntries: metrics.cache?.expiredEntries,
    cacheInvalidatedEntries: metrics.cache?.invalidatedEntries,
    cacheAvoidedToolDurationMs: metrics.cache?.avoidedToolDurationMs,
    persistenceOperationCount: metrics.persistence?.operationCount,
    persistenceDurationMs: metrics.persistence?.totalDurationMs,
    persistenceFailureCount: metrics.persistence?.failureCount,
    contextBudget: metrics.contextBudget
      ? {
          maxInputTokens: metrics.contextBudget.maxInputTokens,
          reservedOutputTokens: metrics.contextBudget.reservedOutputTokens,
          withinBudget: metrics.contextBudget.requests.every((request) => request.withinBudget),
          summarizedMessages: metrics.contextBudget.requests.reduce(
            (total, request) => total + request.summarizedMessages,
            0
          ),
          droppedMessages: metrics.contextBudget.requests.reduce(
            (total, request) => total + request.droppedMessages,
            0
          )
        }
      : undefined,
    routing: {
      mode: run.routing?.mode,
      selectedToolIds: run.routing?.selectedToolIds,
      confidence: run.routing?.confidence,
      additionalModelStage: run.routing?.additionalModelStage
    }
  };
}

function tokenTotal(metrics, key) {
  const requests = Array.isArray(metrics.model?.requests) ? metrics.model.requests : [];
  const total = requests.reduce((sum, request) => {
    const value = request.usage?.[key];
    return value === undefined ? sum : sum + value;
  }, 0);
  return requests.some((request) => request.usage?.[key] !== undefined) ? total : undefined;
}

function summarizeSamples(samples) {
  return {
    sampleCount: samples.length,
    completedRuns: samples.filter((sample) => sample.status === "completed").length,
    clientObservedDurationMs: distribution(samples.map((sample) => sample.clientObservedDurationMs)),
    totalDurationMs: distribution(samples.map((sample) => sample.totalDurationMs)),
    timeToFirstTextMs: distribution(samples.flatMap((sample) => (
      sample.timeToFirstTextMs === undefined ? [] : [sample.timeToFirstTextMs]
    ))),
    modelRequestCount: distribution(samples.flatMap((sample) => (
      sample.modelRequestCount === undefined ? [] : [sample.modelRequestCount]
    ))),
    modelRetryCount: distribution(samples.flatMap((sample) => (
      sample.modelRetryCount === undefined ? [] : [sample.modelRetryCount]
    ))),
    toolCallCount: distribution(samples.map((sample) => sample.toolCallCount)),
    toolHandlerCallCount: distribution(samples.map((sample) => sample.toolHandlerCallCount)),
    toolTotalDurationMs: distribution(samples.map((sample) => sample.toolTotalDurationMs)),
    cacheHits: sum(samples.map((sample) => sample.cacheHits)),
    cacheMisses: sum(samples.map((sample) => sample.cacheMisses)),
    cacheBypasses: sum(samples.map((sample) => sample.cacheBypasses)),
    cacheAvoidedToolDurationMs: distribution(samples.map((sample) => sample.cacheAvoidedToolDurationMs)),
    inputTokens: distribution(samples.flatMap((sample) => (
      sample.inputTokens === undefined ? [] : [sample.inputTokens]
    ))),
    outputTokens: distribution(samples.flatMap((sample) => (
      sample.outputTokens === undefined ? [] : [sample.outputTokens]
    ))),
    persistenceFailureCount: sum(samples.map((sample) => sample.persistenceFailureCount)),
    contextBudget: samples.every((sample) => sample.contextBudget !== undefined)
      ? {
          withinBudget: samples.every((sample) => sample.contextBudget.withinBudget),
          summarizedMessages: distribution(samples.map((sample) => sample.contextBudget.summarizedMessages)),
          droppedMessages: distribution(samples.map((sample) => sample.contextBudget.droppedMessages))
        }
      : undefined
  };
}

function distribution(values) {
  if (values.length === 0) {
    return { median: null, p95: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint];
  const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
  return { median: round(median), p95: round(p95) };
}

function sum(values) {
  return values.reduce((total, value) => total + (value ?? 0), 0);
}

function formatReport(report) {
  const lines = [
    `Agent benchmark schema v${report.schemaVersion}`,
    `Mode: ${report.mode}`,
    `Base URL: ${report.baseUrl}`,
    `Runs per scenario: ${report.runs}`,
    `Generated: ${report.generatedAt}`,
    ""
  ];
  for (const [scenarioId, result] of Object.entries(report.scenarios)) {
    lines.push(`## ${scenarioId}`);
    if (result.status !== "completed") {
      lines.push(`  status: ${result.status}${result.error ? ` (${result.error})` : ""}`);
      lines.push("");
      continue;
    }
    if (scenarioId === "plugin-reload") {
      lines.push(`  tool: ${result.tool.id} (${result.tool.name})`);
      lines.push(`  routed after reload: ${result.routed}`);
    }
    const summary = result.summary;
    lines.push(formatDistribution("Client observed", summary.clientObservedDurationMs, "ms"));
    lines.push(formatDistribution("Server total", summary.totalDurationMs, "ms"));
    lines.push(formatDistribution("First text", summary.timeToFirstTextMs, "ms"));
    lines.push(formatDistribution("Model requests", summary.modelRequestCount, ""));
    lines.push(formatDistribution("Tool handler calls", summary.toolHandlerCallCount, ""));
    lines.push(formatDistribution("Tool duration", summary.toolTotalDurationMs, "ms"));
    lines.push(`Cache: hits ${summary.cacheHits}, misses ${summary.cacheMisses}, bypasses ${summary.cacheBypasses}`);
    lines.push(formatDistribution("Input tokens", summary.inputTokens, ""));
    lines.push(formatDistribution("Output tokens", summary.outputTokens, ""));
    if (summary.contextBudget) {
      lines.push(`Context budget: withinBudget=${summary.contextBudget.withinBudget}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function formatDistribution(label, value, unit) {
  const suffix = unit ? ` ${unit}` : "";
  return value.median === null
    ? `${label}: unavailable`
    : `${label}: median ${value.median}${suffix}, p95 ${value.p95}${suffix}`;
}

function parseOptions(args) {
  let baseUrl = process.env.SECOPS_BENCHMARK_BASE_URL?.trim() || "http://127.0.0.1:4317";
  let runs = 3;
  let json = false;
  let mode = "deterministic";
  let scenario = "all";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--base-url") {
      baseUrl = requiredValue(args, ++index, argument);
      continue;
    }
    if (argument === "--runs") {
      runs = Number(requiredValue(args, ++index, argument));
      continue;
    }
    if (argument === "--mode") {
      mode = requiredValue(args, ++index, argument);
      if (!MODES.includes(mode)) {
        throw new Error(`--mode must be one of ${MODES.join(", ")}`);
      }
      continue;
    }
    if (argument === "--scenario") {
      scenario = requiredValue(args, ++index, argument);
      continue;
    }
    if (argument === "--help") {
      process.stdout.write(
        "Usage: npm run benchmark:agent -- [--base-url URL] [--runs N] [--mode single|layered|deterministic] "
        + "[--scenario all|simple|read-tool|cached-read|long-context|plugin-reload] [--json]\n"
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) {
    throw new Error("--runs must be an integer between 1 and 20");
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), runs, json, mode, scenario };
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function redact(value) {
  const secrets = [process.env.SECOPS_API_TOKEN].filter(Boolean);
  return secrets.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value);
}

function round(value) {
  return Math.round(value * 100) / 100;
}
