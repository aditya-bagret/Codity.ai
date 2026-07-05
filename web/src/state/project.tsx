import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api } from "../api/client";
import type { Project } from "../api/types";
import { useAuth } from "./auth";

const SELECTED_KEY = "codity.project";

interface ProjectState {
  projects: Project[];
  current: Project | null;
  setCurrent: (id: string) => void;
  refresh: () => Promise<void>;
  loaded: boolean;
}

const ProjectContext = createContext<ProjectState | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(localStorage.getItem(SELECTED_KEY));
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const res = await api<{ data: Project[] }>("/projects");
    setProjects(res.data);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh]);

  const current =
    projects.find((p) => p.id === currentId) ?? (projects.length > 0 ? projects[0] : null);

  const setCurrent = useCallback((id: string) => {
    localStorage.setItem(SELECTED_KEY, id);
    setCurrentId(id);
  }, []);

  return (
    <ProjectContext.Provider value={{ projects, current, setCurrent, refresh, loaded }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectState {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProject outside ProjectProvider");
  return ctx;
}
