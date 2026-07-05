import { useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { Queue, RetryPolicy } from "../api/types";
import { usePoll } from "../lib/usePoll";
import { ErrorNote, Field, Modal } from "./ui";

/**
 * Create a queue in a project. Used from the overview page and the sidebar so a
 * freshly-created project isn't a dead end.
 */
export function CreateQueueModal({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (queue: Queue) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(0);
  const [maxConcurrency, setMaxConcurrency] = useState(5);
  const [rateLimit, setRateLimit] = useState("");
  const [timeoutSec, setTimeoutSec] = useState(60);
  const [retryPolicyId, setRetryPolicyId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const policies = usePoll<RetryPolicy[]>(
    async () =>
      (await api<{ data: RetryPolicy[] }>(`/projects/${projectId}/retry-policies`)).data,
    [projectId],
    30_000,
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ queue: Queue }>(`/projects/${projectId}/queues`, {
        method: "POST",
        body: {
          name,
          description: description.trim() || undefined,
          priority,
          maxConcurrency,
          rateLimitPerSec: rateLimit === "" ? null : Number(rateLimit),
          defaultTimeoutMs: timeoutSec * 1000,
          retryPolicyId: retryPolicyId || null,
        },
      });
      onCreated(res.queue);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create queue");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New queue" onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <Field label="Name" hint="letters, digits, hyphens and underscores">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            placeholder="emails"
          />
        </Field>
        <Field label="Description (optional)">
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="row">
          <Field label="Priority" hint="higher drains first">
            <input
              type="number"
              min={-100}
              max={100}
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
            />
          </Field>
          <Field label="Max concurrency">
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
        <Field label="Retry policy">
          <select value={retryPolicyId} onChange={(e) => setRetryPolicyId(e.target.value)}>
            <option value="">platform default (exponential ×3)</option>
            {(policies.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.strategy}, {p.maxRetries} retries
              </option>
            ))}
          </select>
        </Field>
        <ErrorNote message={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "…" : "Create queue"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
