const SCENARIO = {
  id: "simple-no-tools-v1",
  prompt: "Reply with a concise acknowledgement. Do not call tools.",
  enabledTools: [],
  permissionMode: "deny"
};

const options = parseOptions(process.argv.slice(2));

try {
  const report = await runBenchmark(options);
  process.stdout.write(options.json ? `${JSON.stringify(report)}\n` : formatReport(report));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Agent benchmark failed: ${redact(message)}\n`);
  process.exitCode = 1;
}

async function runBenchmark({ baseUrl, runs }) {
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    samples.push(await executeRun(baseUrl));
  }
  const first = samples[0];
  if (!first) {
    throw new Error("Benchmark requires at least one run");
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scenario: {
      id: SCENARIO.id,
      runs,
      request: {
        prompt: SCENARIO.prompt,
        enabledTools: SCENARIO.enabledTools,
        permissionMode: SCENARIO.permissionMode
      }
    },
    environment: {
      provider: first.provider,
      model: first.model
    },
    samples: samples.map((run) => ({
      runId: run.id,
      status: run.status,
      clientObservedDurationMs: run.clientObservedDurationMs,
      metrics: run.metrics
    })),
    summary: {
      completedRuns: samples.filter((run) => run.status === "completed").length,
      clientObservedDurationMs: distribution(samples.map((run) => run.clientObservedDurationMs)),
      serverTotalDurationMs: distribution(samples.map((run) => run.metrics.totalDurationMs)),
      totalDurationMs: distribution(samples.map((run) => run.metrics.totalDurationMs)),
      localOrchestrationDurationMs: distribution(samples.map((run) => run.metrics.localOrchestrationDurationMs)),
      localRoutingDurationMs: distribution(samples.map((run) => run.metrics.localRoutingDurationMs)),
      timeToFirstTextMs: distribution(samples.flatMap((run) => (
        run.metrics.text.timeToFirstTextMs === undefined ? [] : [run.metrics.text.timeToFirstTextMs]
      ))),
      modelRequestCount: distribution(samples.flatMap((run) => (
        run.metrics.model.requestCount === undefined ? [] : [run.metrics.model.requestCount]
      ))),
      provider: {
        totalDurationMs: distribution(samples.flatMap((run) => modelMetricValues(run, "totalDurationMs"))),
        requestCount: distribution(samples.flatMap((run) => modelMetricValues(run, "requestCount"))),
        retryCount: distribution(samples.flatMap((run) => modelMetricValues(run, "retryCount"))),
        phases: {
          triage: phaseSummary(samples, "triage"),
          deep: phaseSummary(samples, "deep"),
          single: phaseSummary(samples, "single")
        },
        finishReasons: countValues(samples.flatMap((run) => modelRequests(run)
          .flatMap((request) => request.finishReason === undefined ? [] : [request.finishReason])))
      },
      tools: {
        callCount: distribution(samples.map((run) => run.metrics.tools.callCount)),
        totalDurationMs: distribution(samples.map((run) => run.metrics.tools.totalDurationMs))
      },
      cache: {
        hits: distribution(samples.map((run) => run.metrics.cache.hits)),
        misses: distribution(samples.map((run) => run.metrics.cache.misses)),
        bypasses: distribution(samples.map((run) => run.metrics.cache.bypasses))
      },
      persistence: {
        operationCount: distribution(samples.map((run) => run.metrics.persistence.operationCount)),
        totalDurationMs: distribution(samples.map((run) => run.metrics.persistence.totalDurationMs)),
        failureCount: distribution(samples.map((run) => run.metrics.persistence.failureCount))
      },
      tokens: {
        input: distribution(samples.flatMap((run) => tokenValues(run, "inputTokens"))),
        output: distribution(samples.flatMap((run) => tokenValues(run, "outputTokens"))),
        cacheRead: distribution(samples.flatMap((run) => tokenValues(run, "cacheReadTokens"))),
        cacheWrite: distribution(samples.flatMap((run) => tokenValues(run, "cacheWriteTokens"))),
        reasoning: distribution(samples.flatMap((run) => tokenValues(run, "reasoningTokens")))
      },
      inputTokens: distribution(samples.flatMap((run) => tokenValues(run, "inputTokens"))),
      outputTokens: distribution(samples.flatMap((run) => tokenValues(run, "outputTokens")))
    }
  };
}

async function executeRun(baseUrl) {
  const observedStartedAt = performance.now();
  const headers = { "content-type": "application/json" };
  const token = process.env.SECOPS_API_TOKEN?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${baseUrl}/api/agent/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      messages: [{ role: "user", content: SCENARIO.prompt }],
      enabledTools: SCENARIO.enabledTools,
      permissionMode: SCENARIO.permissionMode
    })
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

function modelMetricValues(run, key) {
  const value = run.metrics.model[key];
  return typeof value === "number" ? [value] : [];
}

function modelRequests(run) {
  return Array.isArray(run.metrics.model.requests) ? run.metrics.model.requests : [];
}

function phaseSummary(samples, phase) {
  const requestsByRun = samples.map((run) => modelRequests(run).filter((request) => request.phase === phase));
  return {
    requestCount: distribution(requestsByRun.map((requests) => requests.length)),
    durationMs: distribution(requestsByRun.map((requests) => (
      requests.reduce((total, request) => total + request.durationMs, 0)
    ))),
    exposedToolCount: distribution(requestsByRun.flatMap((requests) => (
      requests.map((request) => request.exposedToolCount)
    ))),
    finishReasons: countValues(requestsByRun.flatMap((requests) => requests
      .flatMap((request) => request.finishReason === undefined ? [] : [request.finishReason])))
  };
}

function countValues(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function tokenValues(run, key) {
  const requests = modelRequests(run);
  const total = requests.reduce((sum, request) => {
    const value = request.usage?.[key];
    return value === undefined ? sum : sum + value;
  }, 0);
  return requests.some((request) => request.usage?.[key] !== undefined) ? [total] : [];
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

function formatReport(report) {
  const lines = [
    `Agent benchmark schema v${report.schemaVersion}`,
    `Scenario: ${report.scenario.id} (${report.scenario.runs} run(s))`,
    `Provider/model: ${report.environment.provider}/${report.environment.model}`,
    `Completed: ${report.summary.completedRuns}/${report.scenario.runs}`,
    formatDistribution("Client observed", report.summary.clientObservedDurationMs, "ms"),
    formatDistribution("Server total", report.summary.serverTotalDurationMs, "ms"),
    formatDistribution("Local orchestration", report.summary.localOrchestrationDurationMs, "ms"),
    formatDistribution("Local routing", report.summary.localRoutingDurationMs, "ms"),
    formatDistribution("First text", report.summary.timeToFirstTextMs, "ms"),
    formatDistribution("Provider duration", report.summary.provider.totalDurationMs, "ms"),
    formatDistribution("Provider requests", report.summary.provider.requestCount, ""),
    formatDistribution("Provider retries", report.summary.provider.retryCount, ""),
    formatDistribution("Tool calls", report.summary.tools.callCount, ""),
    formatDistribution("Persistence operations", report.summary.persistence.operationCount, ""),
    formatDistribution("Input tokens", report.summary.tokens.input, ""),
    formatDistribution("Output tokens", report.summary.tokens.output, "")
  ];
  return `${lines.join("\n")}\n`;
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
    if (argument === "--help") {
      process.stdout.write("Usage: npm run benchmark:agent -- [--base-url URL] [--runs N] [--json]\n");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > 100) {
    throw new Error("--runs must be an integer between 1 and 100");
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), runs, json };
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
