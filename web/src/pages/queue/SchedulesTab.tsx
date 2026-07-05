import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import type { Queue, Schedule } from "../../api/types";
import { Badge, EmptyState, ErrorNote, Field, Modal } from "../../components/ui";
import { formatTime, jsonPretty, timeAgo } from "../../lib/format";
import { useMeta } from "../../lib/useMeta";
import { usePoll } from "../../lib/usePoll";

export function SchedulesTab({ queue }: { queue: Queue }) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schedules = usePoll<Schedule[]>(
    async () => (await api<{ data: Schedule[] }>(`/queues/${queue.id}/schedules`)).data,
    [queue.id],
    5000,
  );

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      schedules.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "action failed");
    }
  };

  return (
    <>
      <div className="toolbar">
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          + New schedule
        </button>
      </div>
      <ErrorNote message={error ?? schedules.error} />

      {schedules.data?.length === 0 ? (
        <EmptyState message="No recurring schedules on this queue." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Cron</th>
              <th>Job type</th>
              <th>Status</th>
              <th>Next run</th>
              <th>Last enqueued</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(schedules.data ?? []).map((s) => (
              <tr key={s.id}>
                <td className="strong">{s.name}</td>
                <td>
                  <code>{s.cronExpression}</code> <span className="muted">{s.timezone}</span>
                </td>
                <td className="mono">{s.jobType}</td>
                <td>
                  <Badge status={s.isActive ? "online" : "cancelled"}>
                    {s.isActive ? "active" : "paused"}
                  </Badge>
                </td>
                <td className="muted">{s.isActive ? formatTime(s.nextRunAt) : "—"}</td>
                <td className="muted">{s.lastEnqueuedAt ? timeAgo(s.lastEnqueuedAt) : "never"}</td>
                <td className="actions-cell">
                  <button
                    className="btn btn-small"
                    onClick={() =>
                      act(() => api(`/schedules/${s.id}/trigger`, { method: "POST" }))
                    }
                  >
                    Run now
                  </button>
                  <button
                    className="btn btn-small"
                    onClick={() =>
                      act(() =>
                        api(`/schedules/${s.id}`, {
                          method: "PATCH",
                          body: { isActive: !s.isActive },
                        }),
                      )
                    }
                  >
                    {s.isActive ? "Pause" : "Resume"}
                  </button>
                  <button
                    className="btn btn-small btn-danger"
                    onClick={() => {
                      if (confirm(`Delete schedule "${s.name}"?`)) {
                        void act(() => api(`/schedules/${s.id}`, { method: "DELETE" }));
                      }
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {creating && (
        <CreateScheduleModal
          queue={queue}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            schedules.refresh();
          }}
        />
      )}
    </>
  );
}

function CreateScheduleModal({
  queue,
  onClose,
  onCreated,
}: {
  queue: Queue;
  onClose: () => void;
  onCreated: () => void;
}) {
  const meta = useMeta();
  const [name, setName] = useState("");
  const [cron, setCron] = useState("*/5 * * * *");
  const [timezone, setTimezone] = useState("UTC");
  const [jobType, setJobType] = useState("demo.echo");
  const [payload, setPayload] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      await api(`/queues/${queue.id}/schedules`, {
        method: "POST",
        body: { name, cronExpression: cron, timezone, jobType, payload: parsed },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create schedule");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`New schedule on ${queue.name}`} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="nightly-report" />
        </Field>
        <div className="row">
          <Field label="Cron expression" hint="minute hour day month weekday">
            <input value={cron} onChange={(e) => setCron(e.target.value)} required />
          </Field>
          <Field label="Timezone">
            <input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          </Field>
        </div>
        <Field label="Job type">
          <div className="row">
            <select
              value={meta?.jobTypes.some((t) => t.type === jobType) ? jobType : ""}
              onChange={(e) => {
                if (!e.target.value) return;
                setJobType(e.target.value);
                const def = meta?.jobTypes.find((t) => t.type === e.target.value);
                if (def) setPayload(jsonPretty(def.samplePayload));
              }}
            >
              <option value="">custom…</option>
              {(meta?.jobTypes ?? []).map((t) => (
                <option key={t.type} value={t.type}>
                  {t.type}
                </option>
              ))}
            </select>
            <input value={jobType} onChange={(e) => setJobType(e.target.value)} required />
          </div>
        </Field>
        <Field label="Payload (JSON)">
          <textarea rows={4} value={payload} onChange={(e) => setPayload(e.target.value)} spellCheck={false} />
        </Field>
        <ErrorNote message={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "…" : "Create schedule"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
