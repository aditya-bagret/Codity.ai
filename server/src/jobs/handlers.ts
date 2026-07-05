import type { Job } from "../types";

/**
 * Handler execution context. `log` and `progress` persist to job_logs /
 * jobs.progress so the dashboard can stream execution output. `signal` aborts
 * when the job's timeout elapses — long-running handlers should observe it.
 */
export interface JobContext {
  job: Job;
  payload: Record<string, unknown>;
  signal: AbortSignal;
  log: (level: "debug" | "info" | "warn" | "error", message: string) => Promise<void>;
  progress: (percent: number) => Promise<void>;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

export interface JobTypeDefinition {
  type: string;
  description: string;
  samplePayload: Record<string, unknown>;
  handler: JobHandler;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function num(payload: Record<string, unknown>, key: string, fallback: number): number {
  const v = payload[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Built-in demo handlers. A real deployment would register domain handlers
 * here; the demo set is chosen to exercise every platform behavior: success,
 * latency, CPU work, probabilistic failure (retries), guaranteed failure
 * (DLQ), and progress reporting.
 */
export const jobTypes: JobTypeDefinition[] = [
  {
    type: "demo.echo",
    description: "Returns its payload immediately. The no-op smoke test.",
    samplePayload: { message: "hello codity" },
    handler: async ({ payload, log }) => {
      await log("info", `echo: ${JSON.stringify(payload)}`);
      return payload;
    },
  },
  {
    type: "demo.sleep",
    description: "Sleeps for `ms` (default 2000), reporting progress in 10 steps.",
    samplePayload: { ms: 2000 },
    handler: async ({ payload, signal, log, progress }) => {
      const total = Math.min(num(payload, "ms", 2000), 300_000);
      const step = total / 10;
      await log("info", `sleeping for ${total}ms`);
      for (let i = 1; i <= 10; i++) {
        await sleep(step, signal);
        await progress(i * 10);
      }
      return { sleptMs: total };
    },
  },
  {
    type: "demo.cpu",
    description: "Computes fib(n) iteratively `rounds` million times. CPU burn.",
    samplePayload: { n: 30, rounds: 5 },
    handler: async ({ payload, log }) => {
      const n = Math.min(num(payload, "n", 30), 90);
      const rounds = Math.min(num(payload, "rounds", 5), 50) * 1_000_000;
      let result = 0;
      for (let r = 0; r < rounds; r++) {
        let a = 0,
          b = 1;
        for (let i = 0; i < n; i++) [a, b] = [b, a + b];
        result = a;
      }
      await log("info", `fib(${n}) = ${result}`);
      return { n, fib: result };
    },
  },
  {
    type: "demo.flaky",
    description: "Fails with probability `failureRate` (default 0.5). Exercises retries.",
    samplePayload: { failureRate: 0.5, ms: 500 },
    handler: async ({ payload, signal, log }) => {
      const rate = Math.min(Math.max(num(payload, "failureRate", 0.5), 0), 1);
      await sleep(Math.min(num(payload, "ms", 500), 60_000), signal);
      if (Math.random() < rate) {
        await log("warn", `rolled under failureRate=${rate}, failing`);
        throw new Error(`flaky failure (failureRate=${rate})`);
      }
      await log("info", "got lucky, succeeding");
      return { survivedRate: rate };
    },
  },
  {
    type: "demo.fail",
    description: "Always throws. Exercises the retry → dead letter path.",
    samplePayload: { message: "intentional failure" },
    handler: async ({ payload, log }) => {
      await log("error", "about to fail on purpose");
      throw new Error(typeof payload.message === "string" ? payload.message : "intentional failure");
    },
  },
  {
    type: "email.send",
    description: "Simulated email dispatch: validates, renders, 'sends' (~5% failure).",
    samplePayload: { to: "user@example.com", subject: "Welcome!" },
    handler: async ({ payload, signal, log, progress }) => {
      const to = typeof payload.to === "string" ? payload.to : "";
      if (!to.includes("@")) throw new Error(`invalid recipient address: "${to}"`);
      await log("info", `rendering template for ${to}`);
      await sleep(150 + Math.random() * 350, signal);
      await progress(50);
      await log("info", "connecting to smtp relay");
      await sleep(150 + Math.random() * 700, signal);
      if (Math.random() < 0.05) throw new Error("smtp relay rejected connection (simulated)");
      await progress(100);
      await log("info", `delivered to ${to}`);
      return { to, deliveredAt: new Date().toISOString() };
    },
  },
  {
    type: "report.generate",
    description: "Simulated report build over `rows` rows with progress updates.",
    samplePayload: { rows: 5000, format: "csv" },
    handler: async ({ payload, signal, log, progress }) => {
      const rows = Math.min(num(payload, "rows", 5000), 1_000_000);
      const chunks = 8;
      await log("info", `aggregating ${rows} rows`);
      for (let i = 1; i <= chunks; i++) {
        await sleep(100 + rows / 100, signal);
        await progress(Math.round((i / chunks) * 100));
      }
      await log("info", "report ready");
      return { rows, sizeKb: Math.round(rows / 12) };
    },
  },
  {
    type: "webhook.dispatch",
    description: "Simulated webhook POST with ~8% failure rate.",
    samplePayload: { event: "user.created", url: "https://example.com/hooks" },
    handler: async ({ payload, signal, log }) => {
      const event = typeof payload.event === "string" ? payload.event : "unknown";
      await sleep(100 + Math.random() * 400, signal);
      if (Math.random() < 0.08) throw new Error(`endpoint returned 503 for ${event} (simulated)`);
      await log("info", `dispatched ${event}`);
      return { event, statusCode: 200 };
    },
  },
];

export const handlerRegistry: Map<string, JobTypeDefinition> = new Map(
  jobTypes.map((t) => [t.type, t]),
);
