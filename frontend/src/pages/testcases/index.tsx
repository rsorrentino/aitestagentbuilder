/**
 * Test Cases Page — browse, filter, and manage extracted or manually-created test cases.
 */

import { useState, useEffect } from 'react';
import axios from 'axios';
import Link from 'next/link';
import Layout from '../../components/Layout';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

const PRIORITIES = ['', 'Critical', 'High', 'Medium', 'Low'];
const STATUSES   = ['', 'active', 'draft', 'archived'];

function priorityBadge(p: string) {
  const m: Record<string, string> = {
    Critical: 'badge badge-danger',
    High:     'badge badge-warning',
    Medium:   'badge badge-info',
    Low:      'badge badge-neutral',
  };
  return m[p] ?? 'badge badge-neutral';
}

export default function TestCasesPage() {
  const [cases, setCases]         = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [search, setSearch]       = useState('');
  const [priority, setPriority]   = useState('');
  const [status, setStatus]       = useState('');
  const [showNew, setShowNew]     = useState(false);
  const [newForm, setNewForm]     = useState({ name: '', description: '', priority: 'High' });
  const [saving, setSaving]       = useState(false);

  useEffect(() => { fetchCases(); }, []);

  const fetchCases = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get(`${API_URL}/testcases?limit=200`);
      setCases(Array.isArray(res.data) ? res.data : []);
    } catch (err: any) {
      setError(err.response?.data?.error ?? err.message);
    } finally {
      setLoading(false);
    }
  };

  const deleteCase = async (id: string) => {
    if (!confirm('Delete this test case?')) return;
    try {
      await axios.delete(`${API_URL}/testcases/${id}`);
      setCases((prev) => prev.filter((c) => c.id !== id));
    } catch (err: any) {
      alert(err.response?.data?.error ?? err.message);
    }
  };

  const saveNew = async () => {
    if (!newForm.name.trim()) return;
    setSaving(true);
    try {
      const res = await axios.post(`${API_URL}/testcases`, {
        name: newForm.name.trim(),
        description: newForm.description.trim(),
        priority: newForm.priority,
        steps: [],
        expectedResult: '',
        status: 'active',
      });
      setCases((prev) => [res.data, ...prev]);
      setNewForm({ name: '', description: '', priority: 'High' });
      setShowNew(false);
    } catch (err: any) {
      alert(err.response?.data?.error ?? err.message);
    } finally {
      setSaving(false);
    }
  };

  const filtered = cases.filter((c) => {
    const q = search.toLowerCase();
    const nameMatch = !q || (c.name ?? '').toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q);
    const prioMatch = !priority || c.priority === priority;
    const statMatch = !status   || c.status   === status;
    return nameMatch && prioMatch && statMatch;
  });

  const actions = (
    <button className="btn btn-primary btn-sm" onClick={() => setShowNew(!showNew)}>
      {showNew ? '✕ Cancel' : '＋ New Test Case'}
    </button>
  );

  return (
    <Layout title="Test Cases" actions={actions}>
      {error && <div className="alert alert-error">⚠️ {error}</div>}

      {/* Quick-add form */}
      {showNew && (
        <div className="card mb-6" style={{ borderColor: 'var(--brand-300)' }}>
          <div className="card-header"><h3>New Test Case</h3></div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div className="form-group">
                <label className="form-label">Name *</label>
                <input
                  className="form-control"
                  value={newForm.name}
                  onChange={(e) => setNewForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Login with valid credentials"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Priority</label>
                <select
                  className="form-control"
                  value={newForm.priority}
                  onChange={(e) => setNewForm((f) => ({ ...f, priority: e.target.value }))}
                >
                  {['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Description</label>
              <textarea
                className="form-control"
                rows={2}
                value={newForm.description}
                onChange={(e) => setNewForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Describe the test scenario…"
              />
            </div>
            <div className="flex gap-3">
              <button className="btn btn-primary btn-sm" onClick={saveNew} disabled={saving || !newForm.name.trim()}>
                {saving ? '…' : '✓ Save'}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowNew(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-6" style={{ flexWrap: 'wrap' }}>
        <input
          className="form-control"
          style={{ flex: '1 1 200px', maxWidth: 320 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍  Search test cases…"
        />
        <select className="form-control" style={{ width: 160 }} value={priority} onChange={(e) => setPriority(e.target.value)}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p || 'All priorities'}</option>)}
        </select>
        <select className="form-control" style={{ width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
        </select>
        <span className="text-sm text-muted" style={{ display: 'flex', alignItems: 'center' }}>
          {filtered.length} / {cases.length} shown
        </span>
      </div>

      {/* List */}
      {loading ? (
        <div className="page-loading"><div className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon">🧪</div>
            <h3>{cases.length === 0 ? 'No test cases yet' : 'No matches'}</h3>
            <p>
              {cases.length === 0
                ? 'Upload a test book on the Documents page or create test cases manually.'
                : 'Try adjusting your search filters.'}
            </p>
            {cases.length === 0 && (
              <div className="flex gap-3">
                <Link href="/documents" className="btn btn-primary btn-sm">📄 Upload Document</Link>
                <button className="btn btn-secondary btn-sm" onClick={() => setShowNew(true)}>＋ Create Manually</button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr><th>Name</th><th>Priority</th><th>Steps</th><th>Status</th><th>Source</th><th></th></tr>
              </thead>
              <tbody>
                {filtered.map((tc) => (
                  <tr key={tc.id}>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{tc.name}</div>
                      {tc.description && <div className="text-sm text-muted">{tc.description.slice(0, 80)}{tc.description.length > 80 ? '…' : ''}</div>}
                    </td>
                    <td><span className={priorityBadge(tc.priority)}>{tc.priority}</span></td>
                    <td className="text-sm">{tc.steps?.length ?? '—'}</td>
                    <td>
                      <span className={tc.status === 'active' ? 'badge badge-success' : tc.status === 'draft' ? 'badge badge-warning' : 'badge badge-neutral'}>
                        {tc.status ?? 'active'}
                      </span>
                    </td>
                    <td className="text-sm text-muted">{tc.documentId ? '📄 Extracted' : '✏️ Manual'}</td>
                    <td>
                      <button className="btn btn-danger btn-sm" onClick={() => deleteCase(tc.id)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Layout>
  );
}
