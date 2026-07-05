import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { DlqEntry, Page, Queue } from "../../api/types";
import { Badge, EmptyState, ErrorNote, JsonView, Pager } from "../../components/ui";
import { shortId, timeAgo } from "../../lib/format";
import { usePoll } from "../../lib/usePoll";

export function DlqTab({ queue }: { queue: Queue }) {
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState("pending");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const limit = 20;

  const entries = usePoll<Page<DlqEntry>>(
    () => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (statusFilter) params.set("status", statusFilter);
      return api(`/queues/${queue.id}/dlq?${params}`);
    },
    [queue.id, offset, statusFilter],
    4000,
  );

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      entries.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "action failed");
    }
  };

  return (
    <>
      <div className="toolbar">
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">all entries</option>
          <option value="pending">pending</option>
          <option value="retried">retried</option>
          <option value="discarded">discarded</option>
        </select>
        <div className="spacer" />
        <button
          className="btn"
          onClick={() =>
            act(() => api(`/queues/${queue.id}/dlq/retry-all`, { method: "POST" }))
          }
        >
          ↻ Retry all pending
        </button>
      </div>
      <ErrorNote message={error ?? entries.error} />

      {entries.data?.data.length === 0 ? (
        <EmptyState message="Dead letter queue is empty." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Type</th>
              <th>Reason</th>
              <th>Attempts</th>
              <th>Status</th>
              <th>Failed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(entries.data?.data ?? []).flatMap((entry) => {
              const rows = [
                <tr key={entry.id}>
                  <td>
                    <Link to={`/jobs/${entry.jobId}`} className="mono">
                      {shortId(entry.jobId)}
                    </Link>
                  </td>
                  <td className="mono">{entry.jobType}</td>
                  <td className="error-cell" title={entry.reason}>
                    {entry.reason}
                  </td>
                  <td>{entry.attemptsMade}</td>
                  <td>
                    <Badge status={entry.status} />
                  </td>
                  <td className="muted">{timeAgo(entry.failedAt)}</td>
                  <td className="actions-cell">
                    <button
                      className="btn btn-small"
                      onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                    >
                      {expanded === entry.id ? "Hide" : "Inspect"}
                    </button>
                    {entry.status === "pending" && (
                      <>
                        <button
                          className="btn btn-small btn-primary"
                          onClick={() => act(() => api(`/dlq/${entry.id}/retry`, { method: "POST" }))}
                        >
                          Retry
                        </button>
                        <button
                          className="btn btn-small btn-danger"
                          onClick={() => act(() => api(`/dlq/${entry.id}/discard`, { method: "POST" }))}
                        >
                          Discard
                        </button>
                      </>
                    )}
                  </td>
                </tr>,
              ];
              if (expanded === entry.id) {
                rows.push(
                  <tr key={`${entry.id}-detail`} className="detail-row">
                    <td colSpan={7}>
                      <div className="dlq-detail">
                        <div>
                          <div className="sidebar-heading">Payload snapshot</div>
                          <JsonView value={entry.payload} maxHeight={180} />
                        </div>
                        <div>
                          <div className="sidebar-heading">Failure reason</div>
                          <p className="dlq-reason">{entry.reason}</p>
                        </div>
                      </div>
                    </td>
                  </tr>,
                );
              }
              return rows;
            })}
          </tbody>
        </table>
      )}
      {entries.data && (
        <Pager
          total={entries.data.pagination.total}
          limit={limit}
          offset={offset}
          onPage={setOffset}
        />
      )}
    </>
  );
}
