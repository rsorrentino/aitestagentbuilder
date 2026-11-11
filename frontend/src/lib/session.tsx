/**
 * Session context: current user, accessible projects, the selected project
 * and the user's role in it. UI hides actions the role cannot perform (the
 * API enforces the same rules).
 */

import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, getProjectId, ProjectRole, ROLE_RANK, setProjectId } from './api';

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
  role: 'admin' | 'user';
  mustChangePassword: boolean;
}

export interface SessionProject {
  id: string;
  name: string;
  slug: string;
  role: ProjectRole;
  archived: boolean;
}

interface Session {
  loading: boolean;
  authEnabled: boolean;
  user: SessionUser | null;
  projects: SessionProject[];
  project: SessionProject | null;
  role: ProjectRole | null;
  isAdmin: boolean;
  /** True when the current project role is at least `min` */
  can: (min: ProjectRole) => boolean;
  switchProject: (id: string) => void;
  reload: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [projects, setProjects] = useState<SessionProject[]>([]);
  const [projectId, setProjectIdState] = useState<string>('default');

  const reload = useCallback(async () => {
    try {
      const res = await api.get('/auth/me');
      setAuthEnabled(!!res.data.authEnabled);
      setUser(res.data.user);
      const list: SessionProject[] = res.data.projects ?? [];
      setProjects(list);
      const stored = getProjectId();
      const chosen = list.find((p) => p.id === stored) ?? list.find((p) => p.id === 'default') ?? list[0];
      if (chosen && chosen.id !== stored) setProjectId(chosen.id);
      setProjectIdState(chosen?.id ?? 'default');
    } catch {
      // unauthenticated / backend down: pages show their own errors
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const role = project?.role ?? null;

  const value: Session = {
    loading,
    authEnabled,
    user,
    projects,
    project,
    role,
    isAdmin: user?.role === 'admin',
    can: (min) => !!role && ROLE_RANK[role] >= ROLE_RANK[min] && !(project?.archived && min !== 'viewer'),
    switchProject: (id) => {
      setProjectId(id);
      setProjectIdState(id);
      // Reload so every page refetches its data for the new project
      if (typeof window !== 'undefined') window.location.reload();
    },
    reload,
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
