import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { Queue, QueueStats, RetryPolicy } from "../api/types";
import { ThroughputChart } from "../components/charts";
import { Badge, ErrorNote, Section, StatCard } from "../components/ui";
import { durationShort, formatMs } from "../lib/format";
import { usePoll } from "../lib/usePoll";
import { DlqTab } from "./queue/DlqTab";
import { JobsTab } from "./queue/JobsTab";
import { SchedulesTab } from "./queue/SchedulesTab";
import { SettingsTab } from "./queue/SettingsTab";

type Tab = "jobs" | "schedules" | "dlq" | "settings";

export function QueueDetail() {
  const { queueId = "" } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("jobs");
  const [actionError, setActionError] = useState<string | null>(null);

  const queue = usePoll<{ queue: Queue; retryPolicy: RetryPolicy | null }>(
    () => api(`/queues/${queueId}`),
    [queueId],
    5000,
  );
  const stats = usePoll<QueueStats>(() => api(`/queues/${queueId}/stats`), [queueId], 3000);

  if (queue.error) return <ErrorNote message={queue.error} />;
  if (!queue.data) return null;
  const q = queue.data.queue;
  const s = stats.data;

  const togglePause = async () => {
    setActionError(null);
    try {
      await api(`/queues/${q.id}/${q.isPaused ? "resume" : "pause"}`, { method: "POST" });
      queue.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "failed");
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {q.name} {q.isPaused && <Badge status="cancelled">paused</Badge>}
          </h1>
          <p className="muted">
            {q.description || "no description"} · priority {q.priority} · concurrency{" "}
            {q.maxConcurrency}
            {q.rateLimitPerSec ? ` · ${q.rateLimitPerSec}/s rate limit` : ""} · policy{" "}
            {queue.data.retryPolicy?.name ?? "platform default"}
          </p>
        </div>
        <div className="page-actions">
          <button className={`btn ${q.isPaused ? "btn-primary" : ""}`} onClick={togglePause}>
            {q.isPaused ? "▶ Resume" : "⏸ Pause"}
          </button>
        </div>
      </div>
      <ErrorNote message={actionError} />

      {s && (
        <div className="stat-grid">
          <StatCard label="Queued" value={s.counts.queued} />
          <StatCard label="Scheduled" value={s.counts.scheduled} />
          <StatCard label="Running" value={s.counts.claimed + s.counts.running} />
          <StatCard label="Completed" value={s.counts.completed} tone="ok" />
          <StatCard
            label="Failed"
            value={s.counts.failed}
            tone={s.counts.failed > 0 ? "bad" : undefined}
          />
          <StatCard
            label="DLQ pending"
            value={s.dlqPending}
            tone={s.dlqPending > 0 ? "bad" : "ok"}
          />
          <StatCard
            label="Success (24h)"
            value={s.successRate24h !== null ? `${s.successRate24h}%` : "—"}
          />
          <StatCard
            label="Duration p50 / p95"
            value={`${formatMs(s.duration.p50Ms)} / ${formatMs(s.duration.p95Ms)}`}
            hint={
              s.oldestQueuedAgeMs
                ? `oldest queued ${durationShort(s.oldestQueuedAgeMs)}`
                : undefined
            }
          />
        </div>
      )}

      {s && (
        <Section title="Queue throughput — last 60 minutes">
          <ThroughputChart buckets={s.throughput} height={90} />
        </Section>
      )}

      <div className="tabs">
        {(["jobs", "schedules", "dlq", "settings"] as Tab[]).map((t) => (
          <button
            key={t}
            className={`tab${tab === t ? " tab-active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "dlq" ? "Dead letters" : t[0].toUpperCase() + t.slice(1)}
            {t === "dlq" && (s?.dlqPending ?? 0) > 0 && (
              <span className="tab-count">{s!.dlqPending}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "jobs" && <JobsTab queue={q} />}
      {tab === "schedules" && <SchedulesTab queue={q} />}
      {tab === "dlq" && <DlqTab queue={q} />}
      {tab === "settings" && (
        <SettingsTab
          queue={q}
          onSaved={() => queue.refresh()}
          onDeleted={() => navigate("/")}
        />
      )}
    </>
  );
}
