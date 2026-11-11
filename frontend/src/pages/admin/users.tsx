/**
 * Users — administrators create accounts, reset passwords, unlock,
 * deactivate and grant the administrator role.
 */

import { useCallback, useEffect, useState } from 'react';
import Layout from '../../components/Layout';
import { api, errorMessage, formatDate, PROJECT_ROLES_LIST } from '../../lib/api';
import { useSession } from '../../lib/session';

export default function UsersPage() {
  const session = useSession();
  const [users, setUsers] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('user');
  const [projectId, setProjectIdField] = useState('');
  const [projectRole, setProjectRole] = useState('editor');

  const load = useCallback(async () => {
    try {
      setUsers((await api.get('/admin/users')).data);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (fn: () => Promise<any>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    act(async () => {
      const res = await api.post('/admin/users', {
        email, name: name || undefined, role,
        projects: projectId ? [{ projectId, role: projectRole }] : [],
      });
      setSecret({ email, password: res.data.temporaryPassword });
      setEmail(''); setName('');
    });
  };

  const resetPassword = (u: any) => {
    if (!confirm(`Reset the password of ${u.email}? They will have to choose a new one at next login.`)) return;
    act(async () => {
      const res = await api.post(`/admin/users/${u.id}/reset-password`);
      setSecret({ email: u.email, password: res.data.temporaryPassword });
    });
  };

  if (!session.loading && !session.isAdmin) {
    return <Layout title="Users"><div className="alert alert-error">Administrator access required.</div></Layout>;
  }

  return (
    <Layout title="Users">
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {secret && (
        <div className="alert alert-success">
          Temporary password for <strong>{secret.email}</strong> (shown once — share it securely; they must change it at first login):
          <div className="code" style={{ marginTop: 6, userSelect: 'all' }} data-testid="temp-password">{secret.password}</div>
        </div>
      )}

      <form className="card mb-6" onSubmit={create}>
        <div className="card-header"><h3>＋ New user</h3></div>
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, alignItems: 'end' }}>
          <div>
            <label className="form-label" htmlFor="u-email">Email *</label>
            <input id="u-email" type="email" className="form-control" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="form-label" htmlFor="u-name">Name</label>
            <input id="u-name" className="form-control" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="form-label" htmlFor="u-role">System role</label>
            <select id="u-role" className="form-control" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="u-project">Add to project</label>
            <select id="u-project" className="form-control" value={projectId} onChange={(e) => setProjectIdField(e.target.value)}>
              <option value="">— none —</option>
              {session.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="u-prole">Project role</label>
            <select id="u-prole" className="form-control" value={projectRole} onChange={(e) => setProjectRole(e.target.value)} disabled={!projectId}>
              {PROJECT_ROLES_LIST.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <button className="btn btn-primary btn-sm" type="submit">Create user</button>
        </div>
      </form>

      <div className="card">
        <div className="table-wrapper">
          <table className="data-table">
            <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead>
            <tbody>
              {users.map((u) => {
                const locked = u.lockedUntil && new Date(u.lockedUntil) > new Date();
                const self = u.id === session.user?.id;
                return (
                  <tr key={u.id}>
                    <td>
                      <div className="fw-600">{u.name ?? u.email}</div>
                      <div className="text-sm text-muted">{u.email}</div>
                    </td>
                    <td>
                      <select className="form-control" aria-label={`System role of ${u.email}`} value={u.role} disabled={self}
                        onChange={(e) => act(() => api.patch(`/admin/users/${u.id}`, { role: e.target.value }))}>
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td>
                      <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                        <span className={u.active ? 'badge badge-success' : 'badge badge-neutral'}>{u.active ? 'active' : 'deactivated'}</span>
                        {locked && <span className="badge badge-danger">locked</span>}
                        {u.mustChangePassword && <span className="badge badge-warning">must change password</span>}
                      </div>
                    </td>
                    <td className="text-sm text-muted">{formatDate(u.lastLogin)}</td>
                    <td>
                      <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => resetPassword(u)}>Reset password</button>
                        {locked && <button className="btn btn-secondary btn-sm" onClick={() => act(() => api.post(`/admin/users/${u.id}/unlock`))}>Unlock</button>}
                        {!self && (
                          <button className={`btn btn-sm ${u.active ? 'btn-danger' : 'btn-secondary'}`}
                            onClick={() => act(() => api.patch(`/admin/users/${u.id}`, { active: !u.active }))}>
                            {u.active ? 'Deactivate' : 'Reactivate'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
