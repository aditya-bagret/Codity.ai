import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { DlqEntry, Job, JobExecution, JobLog } from "../api/types";
import {
  Badge,
  ErrorNote,
  JsonView,
  ProgressBar,
  Section,
} from "../components/ui";
import { formatMs, formatTime, shortId, timeAgo } from "../lib/format";
import { usePoll } from "../lib/usePoll";

interface JobDetailData {
  job: Job;
  executions: JobExecution[];
  dlq: DlqEntry | null;
  batch: { id: string; name: string | null; total: number; counts: Record<string, number> } | null;
}

export function JobDetail() {
  const { jobId = "" } = useParams();
  const [actionError, setActionError] = useState<string | null>(null);

  const detail = usePoll<JobDetailData>(() => api(`/jobs/${jobId}`), [jobId], 2500);
  const logs = usePoll<JobLog[]>(
    async () => (await api<{ data: JobLog[] }>(`/jobs/${jobId}/logs`)).data,
    [jobId],
    2500,
  );

  if (detail.error) return <ErrorNote message={detail.error} />;
  if (!detail.data) return null;
  const { job, executions, dlq, batch } = detail.data;

  const act = async (path: string, body?: unknown) => {
    setActionError(null);
    try {
      await api(path, { method: "POST", body });
      detail.refresh();
      logs.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "action failed");
    }
  };

  const terminal = ["failed", "cancelled", "completed"].includes(job.status);
  const pending = ["scheduled", "queued"].includes(job.status);
  const lifecycleLogs = (logs.data ?? []).filter((l) => !l.executionId);
  const logsByExecution = new Map<string, JobLog[]>();
  for (const log of logs.data ?? []) {
    if (!log.executionId) continue;
    const list = logsByExecution.get(log.executionId) ?? [];
    list.push(log);
    logsByExecution.set(log.executionId, list);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="mono-title">
            {job.type} <Badge status={job.status} />
          </h1>
          <p className="muted">
            <span className="mono">{job.id}</span> · queue{" "}
            <Link to={`/queues/${job.queueId}`}>{job.queueName}</Link> · priority {job.priority} ·
            attempt {job.attempts}/{job.maxAttempts}
            {job.idempotencyKey && <> · key <code>{job.idempotencyKey}</code></>}
          </p>
        </div>
        <div className="page-actions">
          {pending && (
            <button className="btn btn-danger" onClick={() => act(`/jobs/${job.id}/cancel`)}>
              Cancel
            </button>
          )}
          {terminal && (
            <button
              className="btn btn-primary"
              onClick={() => act(`/jobs/${job.id}/retry`, { extraAttempts: 1 })}
            >
              ↻ Retry now
            </button>
          )}
        </div>
      </div>
      <ErrorNote message={actionError} />

      {job.status === "running" && <ProgressBar percent={job.progress} />}

      {dlq && dlq.status === "pending" && (
        <div className="dlq-banner">
          ☠ This job is in the dead letter queue: {dlq.reason}
        </div>
      )}

      <div className="timeline">
        <TimelineStep label="Created" time={job.createdAt} done />
        <TimelineStep
          label={new Date(job.runAt) > new Date(job.createdAt) ? "Scheduled for" : "Due"}
          time={job.runAt}
          done={job.status !== "scheduled"}
        />
        <TimelineStep label="Claimed" time={job.claimedAt ?? null} done={!!job.claimedAt} />
        <TimelineStep label="Started" time={job.startedAt} done={!!job.startedAt} />
        <TimelineStep
          label={job.status === "cancelled" ? "Cancelled" : job.status === "failed" ? "Failed" : "Completed"}
          time={job.completedAt}
          done={!!job.completedAt}
          bad={job.status === "failed"}
        />
      </div>

      <div className="two-col">
        <Section title="Payload">
          <JsonView value={job.payload} maxHeight={260} />
        </Section>
        <Section title="Result">
          {job.result !== null && job.result !== undefined ? (
            <JsonView value={job.result} maxHeight={260} />
          ) : (
            <div className="muted">no result{job.lastError ? ` — last error: ${job.lastError}` : ""}</div>
          )}
        </Section>
      </div>

      {batch && (
        <Section title="Batch">
          <p>
            Part of batch <code>{batch.name ?? shortId(batch.id)}</code> ({batch.total} jobs):{" "}
            {Object.entries(batch.counts)
              .filter(([, n]) => n > 0)
              .map(([status, n]) => `${n} ${status}`)
              .join(", ")}
          </p>
        </Section>
      )}

      <Section title={`Executions (${executions.length})`}>
        {executions.length === 0 ? (
          <div className="muted">No attempts yet.</div>
        ) : (
          <div className="executions">
            {executions.map((e) => (
              <div key={e.id} className="execution">
                <div className="execution-head">
                  <span className="strong">Attempt {e.attempt}</span>
                  <Badge status={e.status} />
                  <span className="muted">
                    {e.workerName ? `on ${e.workerName}` : ""} · started {timeAgo(e.startedAt)} ·{" "}
                    {e.durationMs !== null ? formatMs(e.durationMs) : "running…"}
                  </span>
                </div>
                {e.error && <div className="execution-error">{e.error}</div>}
                {(logsByExecution.get(e.id) ?? []).length > 0 && (
                  <div className="log-lines">
                    {logsByExecution.get(e.id)!.map((l) => (
                      <div key={l.id} className={`log-line log-${l.level}`}>
                        <span className="log-time">{formatTime(l.createdAt)}</span>
                        <span className="log-level">{l.level}</span>
                        <span>{l.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Lifecycle log">
        <div className="log-lines">
          {lifecycleLogs.map((l) => (
            <div key={l.id} className={`log-line log-${l.level}`}>
              <span className="log-time">{formatTime(l.createdAt)}</span>
              <span className="log-level">{l.level}</span>
              <span>{l.message}</span>
            </div>
          ))}
          {lifecycleLogs.length === 0 && <div className="muted">no lifecycle events</div>}
        </div>
      </Section>
    </>
  );
}

function TimelineStep({
  label,
  time,
  done,
  bad,
}: {
  label: string;
  time: string | null;
  done: boolean;
  bad?: boolean;
}) {
  return (
    <div className={`timeline-step${done ? " step-done" : ""}${bad ? " step-bad" : ""}`}>
      <div className="step-dot" />
      <div className="step-label">{label}</div>
      <div className="step-time muted">{time ? formatTime(time) : "—"}</div>
    </div>
  );
}
