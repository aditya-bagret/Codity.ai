import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import type { Queue, RetryPolicy } from "../../api/types";
import { ErrorNote, Field, Section } from "../../components/ui";
import { usePoll } from "../../lib/usePoll";

export function SettingsTab({
  queue,
  onSaved,
  onDeleted,
}: {
  queue: Queue;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [description, setDescription] = useState(queue.description ?? "");
  const [priority, setPriority] = useState(queue.priority);
  const [maxConcurrency, setMaxConcurrency] = useState(queue.maxConcurrency);
  const [rateLimit, setRateLimit] = useState<string>(queue.rateLimitPerSec?.toString() ?? "");
  const [timeoutSec, setTimeoutSec] = useState(Math.round(queue.defaultTimeoutMs / 1000));
  const [retryPolicyId, setRetryPolicyId] = useState<string>(queue.retryPolicyId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const policies = usePoll<RetryPolicy[]>(
    async () =>
      (await api<{ data: RetryPolicy[] }>(`/projects/${queue.projectId}/retry-policies`)).data,
    [queue.projectId],
    30_000,
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api(`/queues/${queue.id}`, {
        method: "PATCH",
        body: {
          description: description || null,
          priority,
          maxConcurrency,
          rateLimitPerSec: rateLimit === "" ? null : Number(rateLimit),
          defaultTimeoutMs: timeoutSec * 1000,
          retryPolicyId: retryPolicyId || null,
        },
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    }
  };

  const remove = async () => {
    if (!confirm(`Delete queue "${queue.name}" and ALL its jobs? This cannot be undone.`)) return;
    setError(null);
    try {
      await api(`/queues/${queue.id}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  };

  return (
    <Section title="Queue configuration">
      <form onSubmit={submit} className="form-grid form-narrow">
        <Field label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="row">
          <Field label="Queue priority" hint="workers drain higher-priority queues first">
            <input
              type="number"
              min={-100}
              max={100}
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
            />
          </Field>
          <Field label="Max concurrency" hint="running jobs across all workers">
            <input
              type="number"
              min={1}
              max={1000}
              value={maxConcurrency}
              onChange={(e) => setMaxConcurrency(Number(e.target.value))}
            />
          </Field>
        </div>
        <div className="row">
          <Field label="Rate limit / sec" hint="empty = unlimited">
            <input
              type="number"
              min={1}
              placeholder="unlimited"
              value={rateLimit}
              onChange={(e) => setRateLimit(e.target.value)}
            />
          </Field>
          <Field label="Default timeout (seconds)">
            <input
              type="number"
              min={1}
              max={1800}
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(Number(e.target.value))}
            />
          </Field>
        </div>
        <Field label="Retry policy" hint="applied to new jobs; existing jobs keep their snapshot">
          <select value={retryPolicyId} onChange={(e) => setRetryPolicyId(e.target.value)}>
            <option value="">platform default (exponential ×3)</option>
            {(policies.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.strategy}, {p.maxRetries} retries, base {p.baseDelayMs}ms
              </option>
            ))}
          </select>
        </Field>
        <ErrorNote message={error} />
        {saved && <div className="ok-note">Saved.</div>}
        <div className="row">
          <button className="btn btn-primary">Save changes</button>
          <div className="spacer" />
          <button type="button" className="btn btn-danger" onClick={remove}>
            Delete queue
          </button>
        </div>
      </form>
    </Section>
  );
}
