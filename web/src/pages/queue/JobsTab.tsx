import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { Job, Queue, Page } from "../../api/types";
import {
  Badge,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  Pager,
  ProgressBar,
} from "../../components/ui";
import { jsonPretty, shortId, timeAgo } from "../../lib/format";
import { useMeta } from "../../lib/useMeta";
import { usePoll } from "../../lib/usePoll";

const STATUSES = ["scheduled", "queued", "claimed", "running", "completed", "failed", "cancelled"];

export function JobsTab({ queue }: { queue: Queue }) {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const limit = 20;

  const jobs = usePoll<Page<Job>>(
    () => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (status) params.set("status", status);
      if (search.trim()) params.set("search", search.trim());
      return api(`/queues/${queue.id}/jobs?${params}`);
    },
    [queue.id, status, search, offset],
    3000,
  );

  return (
    <>
      <div className="toolbar">
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">all statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          placeholder="search id / type / idempotency key…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          + Create job
        </button>
      </div>

      <ErrorNote message={jobs.error} />
      {jobs.data?.data.length === 0 ? (
        <EmptyState message="No jobs match. Create one, or run `npm run demo` for a batch of sample traffic." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Type</th>
              <th>Status</th>
              <th>Prio</th>
              <th>Attempts</th>
              <th>Runs / ran at</th>
              <th>Created</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {(jobs.data?.data ?? []).map((j) => (
              <tr key={j.id}>
                <td>
                  <Link to={`/jobs/${j.id}`} className="mono">
                    {shortId(j.id)}
                  </Link>
                  {j.batchId && <span className="chip">batch</span>}
                  {j.scheduledJobId && <span className="chip">cron</span>}
                </td>
                <td className="mono">{j.type}</td>
                <td>
                  <Badge status={j.status} />
                  {j.status === "running" && <ProgressBar percent={j.progress} />}
                </td>
                <td>{j.priority}</td>
                <td>
                  {j.attempts}
                  <span className="muted">/{j.maxAttempts}</span>
                </td>
                <td className="muted">{timeAgo(j.completedAt ?? j.startedAt ?? j.runAt)}</td>
                <td className="muted">{timeAgo(j.createdAt)}</td>
                <td className="error-cell" title={j.lastError ?? ""}>
                  {j.lastError ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {jobs.data && (
        <Pager
          total={jobs.data.pagination.total}
          limit={limit}
          offset={offset}
          onPage={setOffset}
        />
      )}

      {creating && (
        <CreateJobModal
          queue={queue}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            jobs.refresh();
          }}
        />
      )}
    </>
  );
}

function CreateJobModal({
  queue,
  onClose,
  onCreated,
}: {
  queue: Queue;
  onClose: () => void;
  onCreated: () => void;
}) {
  const meta = useMeta();
  const [type, setType] = useState("demo.echo");
  const [payload, setPayload] = useState('{\n  "message": "hello codity"\n}');
  const [priority, setPriority] = useState(0);
  const [delaySec, setDelaySec] = useState(0);
  const [retries, setRetries] = useState<string>("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pickType = (t: string) => {
    setType(t);
    const def = meta?.jobTypes.find((jt) => jt.type === t);
    if (def) setPayload(jsonPretty(def.samplePayload));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    let parsed: unknown;
    try {
      parsed = payload.trim() ? JSON.parse(payload) : {};
    } catch {
      setError("payload is not valid JSON");
      return;
    }
    setBusy(true);
    try {
      await api(`/queues/${queue.id}/jobs`, {
        method: "POST",
        body: {
          type,
          payload: parsed,
          priority,
          ...(delaySec > 0 ? { delayMs: delaySec * 1000 } : {}),
          ...(retries !== "" ? { retries: Number(retries) } : {}),
          ...(idempotencyKey.trim() ? { idempotencyKey: idempotencyKey.trim() } : {}),
        },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create job");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Create job in ${queue.name}`} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <Field label="Job type" hint={meta?.jobTypes.find((t) => t.type === type)?.description}>
          <div className="row">
            <select value={meta?.jobTypes.some((t) => t.type === type) ? type : ""} onChange={(e) => e.target.value && pickType(e.target.value)}>
              <option value="">custom…</option>
              {(meta?.jobTypes ?? []).map((t) => (
                <option key={t.type} value={t.type}>
                  {t.type}
                </option>
              ))}
            </select>
            <input value={type} onChange={(e) => setType(e.target.value)} required />
          </div>
        </Field>
        <Field label="Payload (JSON)">
          <textarea
            rows={6}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            spellCheck={false}
          />
        </Field>
        <div className="row">
          <Field label="Priority (higher first)">
            <input
              type="number"
              min={-100}
              max={100}
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
            />
          </Field>
          <Field label="Delay (seconds)">
            <input
              type="number"
              min={0}
              value={delaySec}
              onChange={(e) => setDelaySec(Number(e.target.value))}
            />
          </Field>
          <Field label="Retries (override)">
            <input
              type="number"
              min={0}
              max={20}
              placeholder="queue policy"
              value={retries}
              onChange={(e) => setRetries(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Idempotency key (optional)">
          <input
            value={idempotencyKey}
            onChange={(e) => setIdempotencyKey(e.target.value)}
            placeholder="e.g. order-1234-confirmation"
          />
        </Field>
        <ErrorNote message={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "…" : "Enqueue job"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
