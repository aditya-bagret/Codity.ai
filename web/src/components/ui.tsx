import { useEffect, type ReactNode } from "react";
import { jsonPretty } from "../lib/format";

export function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "ok" | "warn" | "bad";
}) {
  return (
    <div className={`stat-card${tone ? ` tone-${tone}` : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  scheduled: "purple",
  queued: "blue",
  claimed: "amber",
  running: "amber",
  completed: "green",
  succeeded: "green",
  failed: "red",
  timed_out: "red",
  lost: "red",
  cancelled: "gray",
  pending: "amber",
  retried: "blue",
  discarded: "gray",
  online: "green",
  draining: "amber",
  offline: "gray",
  dead: "red",
};

export function Badge({ status, children }: { status: string; children?: ReactNode }) {
  const tone = STATUS_TONE[status] ?? "gray";
  return (
    <span className={`badge badge-${tone}${status === "running" ? " pulse" : ""}`}>
      {children ?? status.replace("_", " ")}
    </span>
  );
}

export function Section({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {actions && <div className="section-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <div className="empty-state">{message}</div>;
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="error-note">{message}</div>;
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " modal-wide" : ""}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function JsonView({ value, maxHeight }: { value: unknown; maxHeight?: number }) {
  return (
    <pre className="json-view" style={maxHeight ? { maxHeight } : undefined}>
      {jsonPretty(value)}
    </pre>
  );
}

export function Pager({
  total,
  limit,
  offset,
  onPage,
}: {
  total: number;
  limit: number;
  offset: number;
  onPage: (offset: number) => void;
}) {
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  return (
    <div className="pager">
      <button className="btn" disabled={offset === 0} onClick={() => onPage(offset - limit)}>
        ← Prev
      </button>
      <span>
        page {page} / {pages} · {total} total
      </span>
      <button
        className="btn"
        disabled={offset + limit >= total}
        onClick={() => onPage(offset + limit)}
      >
        Next →
      </button>
    </div>
  );
}

export function ProgressBar({ percent }: { percent: number | null }) {
  if (percent === null) return null;
  return (
    <div className="progress-track" title={`${percent}%`}>
      <div className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}
