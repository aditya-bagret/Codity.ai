import { useState, type FormEvent } from "react";
import { api } from "../api/client";
import type { Project, RetryPolicy } from "../api/types";
import { ErrorNote, Field, Modal, Section } from "../components/ui";
import { usePoll } from "../lib/usePoll";
import { useProject } from "../state/project";

interface Org {
  id: string;
  name: string;
  role: string;
  members: number;
}

export function Projects() {
  const { projects, current, setCurrent, refresh } = useProject();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const orgs = usePoll<Org[]>(
    async () => (await api<{ data: Org[] }>("/orgs")).data,
    [],
    30_000,
  );
  const detail = usePoll<{ project: Project; role: string } | null>(
    () => (current ? api(`/projects/${current.id}`) : Promise.resolve(null)),
    [current?.id],
    15_000,
  );

  const rotateKey = async () => {
    if (!current) return;
    if (!confirm("Rotate the API key? Existing integrations will stop working.")) return;
    try {
      const res = await api<{ apiKey: string }>(`/projects/${current.id}/rotate-api-key`, {
        method: "POST",
      });
      setRevealedKey(res.apiKey);
      detail.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "rotate failed");
    }
  };

  const apiKey = revealedKey ?? detail.data?.project.apiKey ?? null;

  return (
    <>
      <Section
        title="Projects"
        actions={
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            + New project
          </button>
        }
      >
        <ErrorNote message={error} />
        <table className="table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Organization</th>
              <th>Your role</th>
              <th>Queues</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} className={p.id === current?.id ? "row-selected" : ""}>
                <td className="strong">{p.name}</td>
                <td>{p.organizationName}</td>
                <td>{p.role}</td>
                <td>{p.queueCount}</td>
                <td>
                  {p.id === current?.id ? (
                    <span className="muted">active</span>
                  ) : (
                    <button className="btn btn-small" onClick={() => setCurrent(p.id)}>
                      Switch
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {current && (
        <Section title={`API access — ${current.name}`}>
          <p className="muted">
            Integrations enqueue jobs with the <code>X-Api-Key</code> header (member-level access,
            scoped to this project).
          </p>
          {apiKey ? (
            <div className="api-key-row">
              <code className="api-key">{apiKey}</code>
              <button
                className="btn btn-small"
                onClick={() => void navigator.clipboard.writeText(apiKey)}
              >
                Copy
              </button>
              <button className="btn btn-small" onClick={rotateKey}>
                Rotate
              </button>
            </div>
          ) : (
            <p className="muted">Only org admins can view the API key.</p>
          )}
        </Section>
      )}

      {current && <PoliciesSection projectId={current.id} />}

      {creating && (
        <CreateProjectModal
          orgs={orgs.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}
    </>
  );
}

function PoliciesSection({ projectId }: { projectId: string }) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const policies = usePoll<RetryPolicy[]>(
    async () => (await api<{ data: RetryPolicy[] }>(`/projects/${projectId}/retry-policies`)).data,
    [projectId],
    10_000,
  );

  const remove = async (p: RetryPolicy) => {
    if (!confirm(`Delete retry policy "${p.name}"? Queues using it fall back to the default.`))
      return;
    try {
      await api(`/retry-policies/${p.id}`, { method: "DELETE" });
      policies.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  };

  return (
    <Section
      title="Retry policies"
      actions={
        <button className="btn" onClick={() => setCreating(true)}>
          + New policy
        </button>
      }
    >
      <ErrorNote message={error ?? policies.error} />
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Strategy</th>
            <th>Max retries</th>
            <th>Base delay</th>
            <th>Max delay</th>
            <th>Jitter</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(policies.data ?? []).map((p) => (
            <tr key={p.id}>
              <td className="strong">{p.name}</td>
              <td>{p.strategy}</td>
              <td>{p.maxRetries}</td>
              <td>{p.baseDelayMs}ms</td>
              <td>{p.maxDelayMs}ms</td>
              <td>{p.jitter ? "±15%" : "off"}</td>
              <td>
                <button className="btn btn-small btn-danger" onClick={() => remove(p)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {creating && (
        <CreatePolicyModal
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            policies.refresh();
          }}
        />
      )}
    </Section>
  );
}

function CreateProjectModal({
  orgs,
  onClose,
  onCreated,
}: {
  orgs: Org[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? "");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("/projects", { method: "POST", body: { organizationId: orgId, name } });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    }
  };

  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <Field label="Organization">
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} required>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Project name">
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <ErrorNote message={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary">Create</button>
        </div>
      </form>
    </Modal>
  );
}

function CreatePolicyModal({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [strategy, setStrategy] = useState<"fixed" | "linear" | "exponential">("exponential");
  const [maxRetries, setMaxRetries] = useState(3);
  const [baseDelayMs, setBaseDelayMs] = useState(1000);
  const [maxDelayMs, setMaxDelayMs] = useState(60_000);
  const [jitter, setJitter] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/projects/${projectId}/retry-policies`, {
        method: "POST",
        body: { name, strategy, maxRetries, baseDelayMs, maxDelayMs, jitter },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    }
  };

  return (
    <Modal title="New retry policy" onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="aggressive-exponential" />
        </Field>
        <div className="row">
          <Field label="Strategy">
            <select value={strategy} onChange={(e) => setStrategy(e.target.value as typeof strategy)}>
              <option value="fixed">fixed</option>
              <option value="linear">linear</option>
              <option value="exponential">exponential</option>
            </select>
          </Field>
          <Field label="Max retries">
            <input
              type="number"
              min={0}
              max={20}
              value={maxRetries}
              onChange={(e) => setMaxRetries(Number(e.target.value))}
            />
          </Field>
        </div>
        <div className="row">
          <Field label="Base delay (ms)">
            <input
              type="number"
              min={10}
              value={baseDelayMs}
              onChange={(e) => setBaseDelayMs(Number(e.target.value))}
            />
          </Field>
          <Field label="Max delay (ms)">
            <input
              type="number"
              min={10}
              value={maxDelayMs}
              onChange={(e) => setMaxDelayMs(Number(e.target.value))}
            />
          </Field>
        </div>
        <Field label="Jitter">
          <select value={jitter ? "on" : "off"} onChange={(e) => setJitter(e.target.value === "on")}>
            <option value="on">on (±15%, prevents retry stampedes)</option>
            <option value="off">off (deterministic)</option>
          </select>
        </Field>
        <ErrorNote message={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary">Create policy</button>
        </div>
      </form>
    </Modal>
  );
}
