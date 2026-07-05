import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Heartbeat, WorkerInfo } from "../api/types";
import { Sparkline } from "../components/charts";
import { Badge, EmptyState, ErrorNote, Section } from "../components/ui";
import { shortId, timeAgo } from "../lib/format";
import { usePoll } from "../lib/usePoll";

interface WorkerDetail {
  worker: WorkerInfo;
  heartbeats: Heartbeat[];
  currentJobs: Array<{ id: string; type: string; status: string; queueName: string; startedAt: string | null }>;
}

export function Workers() {
  const [selected, setSelected] = useState<string | null>(null);
  const list = usePoll<WorkerInfo[]>(
    async () => (await api<{ data: WorkerInfo[] }>("/workers")).data,
    [],
    3000,
  );
  const detail = usePoll<WorkerDetail | null>(
    () => (selected ? api<WorkerDetail>(`/workers/${selected}`) : Promise.resolve(null)),
    [selected],
    3000,
  );

  return (
    <>
      <Section title="Workers">
        <ErrorNote message={list.error} />
        {list.data?.length === 0 ? (
          <EmptyState message="No workers have registered yet. Start one with: npm run worker" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Worker</th>
                <th>Status</th>
                <th>In flight</th>
                <th>Done 1h</th>
                <th>Failed 1h</th>
                <th>Queues</th>
                <th>Last heartbeat</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((w) => (
                <tr
                  key={w.id}
                  className={`row-click${selected === w.id ? " row-selected" : ""}`}
                  onClick={() => setSelected(w.id === selected ? null : w.id)}
                >
                  <td>
                    <span className="strong">{w.name}</span>{" "}
                    <span className="muted mono">{shortId(w.id)}</span>
                  </td>
                  <td>
                    <Badge status={w.status} />
                  </td>
                  <td>
                    {w.activeJobs}
                    <span className="muted">/{w.maxConcurrency}</span>
                  </td>
                  <td className="ok-text">{w.completed1h}</td>
                  <td className={w.failed1h ? "bad-text" : ""}>{w.failed1h}</td>
                  <td className="muted">{w.queueFilter?.join(", ") ?? "all"}</td>
                  <td className="muted">{timeAgo(w.lastHeartbeatAt)}</td>
                  <td className="muted">{timeAgo(w.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {selected && detail.data && (
        <Section title={`Worker ${detail.data.worker.name}`}>
          <div className="worker-detail">
            <div>
              <div className="sidebar-heading">Load (in-flight jobs, ~10 min)</div>
              <Sparkline points={detail.data.heartbeats.map((h) => h.activeJobs)} />
              <div className="muted">
                host {detail.data.worker.hostname ?? "?"} · pid {detail.data.worker.pid ?? "?"} ·
                rss {detail.data.heartbeats.at(-1)?.rssMb ?? "?"} MB
              </div>
            </div>
            <div>
              <div className="sidebar-heading">Current jobs</div>
              {detail.data.currentJobs.length === 0 ? (
                <div className="muted">idle</div>
              ) : (
                <ul className="plain-list">
                  {detail.data.currentJobs.map((j) => (
                    <li key={j.id}>
                      <Badge status={j.status} />{" "}
                      <Link to={`/jobs/${j.id}`} className="mono">
                        {shortId(j.id)}
                      </Link>{" "}
                      {j.type} <span className="muted">on {j.queueName}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Section>
      )}
    </>
  );
}
