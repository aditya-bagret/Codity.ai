import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Queue } from "../api/types";
import { usePoll } from "../lib/usePoll";
import { useAuth } from "../state/auth";
import { useProject } from "../state/project";
import { Badge } from "./ui";
import { CreateQueueModal } from "./CreateQueueModal";

export function Layout() {
  const { user, logout } = useAuth();
  const { projects, current, setCurrent } = useProject();
  const navigate = useNavigate();
  const [creatingQueue, setCreatingQueue] = useState(false);

  const queues = usePoll<Queue[]>(
    async () =>
      current
        ? (await api<{ data: Queue[] }>(`/projects/${current.id}/queues`)).data
        : [],
    [current?.id],
    8000,
  );

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="logo">
          <span className="logo-mark">⚙</span> Codity
        </div>
        <nav>
          <NavLink to="/" end>
            Overview
          </NavLink>
          <NavLink to="/workers">Workers</NavLink>
          <NavLink to="/projects">Projects</NavLink>
        </nav>
        <div className="sidebar-queues">
          <div className="sidebar-heading">
            <span>Queues</span>
            {current && (
              <button
                className="sidebar-add"
                title="New queue"
                onClick={() => setCreatingQueue(true)}
              >
                +
              </button>
            )}
          </div>
          {(queues.data ?? []).map((q) => (
            <NavLink key={q.id} to={`/queues/${q.id}`} className="queue-link">
              <span className="queue-link-name">
                {q.isPaused && <span title="paused">⏸ </span>}
                {q.name}
              </span>
              {(q.queued ?? 0) + (q.running ?? 0) > 0 && (
                <span className="queue-link-count">{(q.queued ?? 0) + (q.running ?? 0)}</span>
              )}
            </NavLink>
          ))}
          {queues.data?.length === 0 && current && (
            <button className="sidebar-empty-btn" onClick={() => setCreatingQueue(true)}>
              + Create a queue
            </button>
          )}
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <select
            className="project-select"
            value={current?.id ?? ""}
            onChange={(e) => setCurrent(e.target.value)}
            disabled={projects.length === 0}
          >
            {projects.length === 0 && <option value="">no projects</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.organizationName ? `${p.organizationName} / ` : ""}
                {p.name}
              </option>
            ))}
          </select>
          <div className="topbar-right">
            <span className="live-dot" title="polling live" />
            <span className="muted">{user?.email}</span>
            <button className="btn btn-ghost" onClick={logout}>
              Log out
            </button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>

      {creatingQueue && current && (
        <CreateQueueModal
          projectId={current.id}
          onClose={() => setCreatingQueue(false)}
          onCreated={(queue) => {
            setCreatingQueue(false);
            queues.refresh();
            navigate(`/queues/${queue.id}`);
          }}
        />
      )}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge status={status} />;
}
