import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Overview as OverviewData } from "../api/types";
import { ThroughputChart } from "../components/charts";
import { CreateQueueModal } from "../components/CreateQueueModal";
import { Badge, EmptyState, ErrorNote, Section, StatCard } from "../components/ui";
import { durationShort, shortId, timeAgo } from "../lib/format";
import { usePoll } from "../lib/usePoll";
import { useProject } from "../state/project";

export function Overview() {
  const { current, loaded, refresh } = useProject();
  const navigate = useNavigate();
  const [creatingQueue, setCreatingQueue] = useState(false);
  const { data, error } = usePoll<OverviewData | null>(
    () => (current ? api<OverviewData>(`/projects/${current.id}/overview`) : Promise.resolve(null)),
    [current?.id],
    3000,
  );

  if (loaded && !current) {
    return (
      <EmptyState message="No projects yet — create one from the Projects page to get started." />
    );
  }
  if (!data) return <ErrorNote message={error} />;

  const backlogAge = data.queues.reduce<number>((worst, q) => {
    if (!q.oldestQueuedAt) return worst;
    return Math.max(worst, Date.now() - new Date(q.oldestQueuedAt).getTime());
  }, 0);

  return (
    <>
      <div className="stat-grid">
        <StatCard
          label="Workers online"
          value={data.workersOnline}
          hint={`${data.workersTotal} registered`}
          tone={data.workersOnline > 0 ? "ok" : "bad"}
        />
        <StatCard label="Completed (24h)" value={data.completed24h} tone="ok" />
        <StatCard
          label="Failed executions (24h)"
          value={data.failed24h}
          tone={data.failed24h > 0 ? "warn" : undefined}
        />
        <StatCard
          label="Success rate (24h)"
          value={data.successRate24h !== null ? `${data.successRate24h}%` : "—"}
          tone={
            data.successRate24h === null ? undefined : data.successRate24h >= 95 ? "ok" : "warn"
          }
        />
        <StatCard
          label="Queued backlog"
          value={data.queuedBacklog}
          hint={backlogAge > 0 ? `oldest waiting ${durationShort(backlogAge)}` : undefined}
        />
        <StatCard
          label="Dead letter queue"
          value={data.dlqPending}
          tone={data.dlqPending > 0 ? "bad" : "ok"}
        />
      </div>

      {(data.failed24h > 0 || data.dlqPending > 0) && (
        <div className="notice notice-warn" role="status">
          <strong>Demo failures are expected.</strong> The seed data and{" "}
          <code>npm run demo</code> deliberately enqueue jobs that fail (for example{" "}
          <code>demo.fail</code>, invalid email addresses, and flaky handlers) so you can
          exercise retries and the dead letter queue. This does not indicate a broken install.
        </div>
      )}

      <Section title="Throughput — last 60 minutes">
        <ThroughputChart buckets={data.throughput} />
      </Section>

      <Section
        title="Queue health"
        actions={
          <button className="btn btn-primary btn-small" onClick={() => setCreatingQueue(true)}>
            + New queue
          </button>
        }
      >
        {data.queues.length === 0 ? (
          <div className="empty-state">
            <p>No queues in this project yet.</p>
            <button className="btn btn-primary" onClick={() => setCreatingQueue(true)}>
              + Create your first queue
            </button>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Queue</th>
                <th>Prio</th>
                <th>Queued</th>
                <th>Running</th>
                <th>Scheduled</th>
                <th>Done 24h</th>
                <th>Failed 24h</th>
                <th>DLQ</th>
                <th>Oldest queued</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.queues.map((q) => (
                <tr key={q.id}>
                  <td>
                    <Link to={`/queues/${q.id}`} className="strong">
                      {q.name}
                    </Link>{" "}
                    {q.isPaused && <Badge status="cancelled">paused</Badge>}
                  </td>
                  <td>{q.priority}</td>
                  <td>{q.queued}</td>
                  <td>
                    {q.running}
                    <span className="muted">/{q.maxConcurrency}</span>
                  </td>
                  <td>{q.scheduled}</td>
                  <td className="ok-text">{q.completed24h}</td>
                  <td className={q.failed24h > 0 ? "bad-text" : ""}>{q.failed24h}</td>
                  <td className={q.dlqPending > 0 ? "bad-text" : ""}>{q.dlqPending}</td>
                  <td className="muted">{q.oldestQueuedAt ? timeAgo(q.oldestQueuedAt) : "—"}</td>
                  <td>
                    <Link className="btn btn-small" to={`/queues/${q.id}`}>
                      open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Recent failures">
        {data.recentFailures.length === 0 ? (
          <EmptyState message="No failed executions recently. 🎉" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Type</th>
                <th>Queue</th>
                <th>Outcome</th>
                <th>Error</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {data.recentFailures.map((f) => (
                <tr key={f.executionId}>
                  <td>
                    <Link to={`/jobs/${f.jobId}`} className="mono">
                      {shortId(f.jobId)}
                    </Link>
                  </td>
                  <td className="mono">{f.jobType}</td>
                  <td>{f.queueName}</td>
                  <td>
                    <Badge status={f.status} />
                  </td>
                  <td className="error-cell" title={f.error ?? ""}>
                    {f.error ?? "—"}
                  </td>
                  <td className="muted">{timeAgo(f.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {creatingQueue && current && (
        <CreateQueueModal
          projectId={current.id}
          onClose={() => setCreatingQueue(false)}
          onCreated={(queue) => {
            setCreatingQueue(false);
            void refresh();
            navigate(`/queues/${queue.id}`);
          }}
        />
      )}
    </>
  );
}
