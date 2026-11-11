/**
 * Projects & Members — list projects, create (admins), manage members,
 * rename / archive (owners) the current project.
 */

import { useCallback, useEffect, useState } from 'react';
import Layout from '../components/Layout';
import { api, errorMessage, formatDate, PROJECT_ROLES_LIST } from '../lib/api';
import { useSession } from '../lib/session';

export default function ProjectsPage() {
  const session = useSession();
  const { project } = session;
  const [projects, setProjects] = useState<any[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState('editor');
  const [rename, setRename] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, m] = await Promise.all([
        api.get('/projects?archived=true'),
        project ? api.get(`/projects/${project.id}/members`) : Promise.resolve({ data: [] }),
      ]);
      setProjects(p.data);
      setMembers(m.data);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [project]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setRename(project?.name ?? ''); }, [project]);

  const run = async (fn: () => Promise<any>, ok: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(ok);
      await load();
      await session.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const canManageMembers = session.can('admin');
  const isOwner = session.role === 'owner';

  return (
    <Layout title="Projects & Members">
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 20, alignItems: 'start' }}>
        <div className="card">
          <div className="card-header"><h3>🗂️ Projects</h3></div>
          <div className="table-wrapper">
            <table className="data-table">
              <thead><tr><th>Project</th><th>Your role</th><th>Agents</th><th>Tests</th><th>Runs</th><th></th></tr></thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="fw-600">{p.name}</div>
                      <div className="text-sm text-muted">{p.slug}{p.archived ? ' · archived' : ''}</div>
                    </td>
                    <td><span className="badge badge-neutral">{p.role ?? '—'}</span></td>
                    <td>{p.counts?.agents ?? '—'}</td>
                    <td>{p.counts?.testCases ?? '—'}</td>
                    <td>{p.counts?.runs ?? '—'}</td>
                    <td>
                      {p.id === project?.id
                        ? <span className="badge badge-success">current</span>
                        : <button className="btn btn-secondary btn-sm" onClick={() => session.switchProject(p.id)}>Switch</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {session.isAdmin && (
            <form className="card-body" style={{ borderTop: '1px solid var(--gray-100)' }}
              onSubmit={(e) => { e.preventDefault(); run(() => api.post('/projects', { name: newName, description: newDesc }), `Project “${newName}” created`).then(() => { setNewName(''); setNewDesc(''); }); }}>
              <div className="form-label">New project</div>
              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                <input className="form-control" style={{ flex: '1 1 160px' }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Project name" aria-label="New project name" required />
                <input className="form-control" style={{ flex: '2 1 200px' }} value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Description (optional)" aria-label="New project description" />
                <button className="btn btn-primary btn-sm" type="submit">＋ Create</button>
              </div>
            </form>
          )}
        </div>

        {project && (
          <div className="card">
            <div className="card-header"><h3>👥 Members of “{project.name}”</h3></div>
            {!session.authEnabled && (
              <div className="alert alert-info" style={{ margin: 16 }}>
                Authentication is off (local mode), so everyone acts as administrator. Set AUTH_ENABLED=true to use roles.
              </div>
            )}
            <div className="table-wrapper">
              <table className="data-table">
                <thead><tr><th>User</th><th>Role</th><th>Added</th><th></th></tr></thead>
                <tbody>
                  {members.length === 0 && <tr><td colSpan={4} className="text-muted">No explicit members.</td></tr>}
                  {members.map((m) => (
                    <tr key={m.userId}>
                      <td>
                        <div className="fw-600">{m.name ?? m.email}</div>
                        <div className="text-sm text-muted">{m.email}{!m.active ? ' · deactivated' : ''}</div>
                      </td>
                      <td>
                        {canManageMembers ? (
                          <select className="form-control" aria-label={`Role of ${m.email}`} value={m.role}
                            onChange={(e) => run(() => api.put(`/projects/${project.id}/members`, { userId: m.userId, role: e.target.value }), `Role of ${m.email} updated`)}>
                            {PROJECT_ROLES_LIST.map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                        ) : <span className="badge badge-neutral">{m.role}</span>}
                      </td>
                      <td className="text-sm text-muted">{formatDate(m.addedAt)}</td>
                      <td>
                        {canManageMembers && (
                          <button className="btn btn-danger btn-sm" onClick={() => confirm(`Remove ${m.email} from ${project.name}?`) && run(() => api.delete(`/projects/${project.id}/members/${m.userId}`), `${m.email} removed`)}>Remove</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canManageMembers && session.authEnabled && (
              <form className="card-body" style={{ borderTop: '1px solid var(--gray-100)' }}
                onSubmit={(e) => { e.preventDefault(); run(() => api.put(`/projects/${project.id}/members`, { email: memberEmail, role: memberRole }), `${memberEmail} added as ${memberRole}`).then(() => setMemberEmail('')); }}>
                <div className="form-label">Add member</div>
                <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                  <input className="form-control" style={{ flex: '2 1 200px' }} type="email" value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} placeholder="user@company.com" aria-label="Member email" required />
                  <select className="form-control" style={{ flex: '1 1 110px' }} value={memberRole} onChange={(e) => setMemberRole(e.target.value)} aria-label="Member role">
                    {PROJECT_ROLES_LIST.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <button className="btn btn-primary btn-sm" type="submit">Add</button>
                </div>
                <p className="form-hint mt-2">The user must already have an account (administrators create accounts under Users).</p>
              </form>
            )}

            {session.can('admin') && (
              <div className="card-body" style={{ borderTop: '1px solid var(--gray-100)' }}>
                <div className="form-label">Project settings</div>
                <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                  <input className="form-control" style={{ flex: '1 1 200px' }} value={rename} onChange={(e) => setRename(e.target.value)} aria-label="Project name" />
                  <button className="btn btn-secondary btn-sm" onClick={() => run(() => api.patch(`/projects/${project.id}`, { name: rename }), 'Project renamed')}>Rename</button>
                  {isOwner && project.id !== 'default' && (
                    <button className="btn btn-secondary btn-sm" onClick={() => run(() => api.patch(`/projects/${project.id}`, { archived: !project.archived }), project.archived ? 'Project restored' : 'Project archived')}>
                      {project.archived ? 'Restore' : 'Archive'}
                    </button>
                  )}
                  {isOwner && project.id !== 'default' && (
                    <button className="btn btn-danger btn-sm" onClick={() => {
                      const typed = prompt(`This deletes every agent, test and run in “${project.name}”. Type the project slug (${project.slug}) to confirm:`);
                      if (typed === project.slug) {
                        api.delete(`/projects/${project.id}?confirm=${encodeURIComponent(typed)}`)
                          .then(() => session.switchProject('default'))
                          .catch((err) => setError(errorMessage(err)));
                      }
                    }}>Delete</button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
