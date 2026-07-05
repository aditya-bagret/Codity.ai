import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { JobDetail } from "./pages/JobDetail";
import { Login } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { Projects } from "./pages/Projects";
import { QueueDetail } from "./pages/QueueDetail";
import { Workers } from "./pages/Workers";
import { useAuth } from "./state/auth";
import { ProjectProvider } from "./state/project";

export function App() {
  const { user, ready } = useAuth();
  if (!ready) return <div className="boot">loading…</div>;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      {user ? (
        <Route
          element={
            <ProjectProvider>
              <Layout />
            </ProjectProvider>
          }
        >
          <Route path="/" element={<Overview />} />
          <Route path="/queues/:queueId" element={<QueueDetail />} />
          <Route path="/jobs/:jobId" element={<JobDetail />} />
          <Route path="/workers" element={<Workers />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      ) : (
        <Route path="*" element={<Navigate to="/login" replace />} />
      )}
    </Routes>
  );
}
