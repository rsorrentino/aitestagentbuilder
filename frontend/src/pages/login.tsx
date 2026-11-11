/**
 * Login page (only used when the backend runs with AUTH_ENABLED=true).
 */

import { useState } from 'react';
import { useRouter } from 'next/router';
import { api, errorMessage, setToken } from '../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.post('/auth/login', { email, password });
      setToken(res.data.accessToken);
      const next = typeof router.query.next === 'string' && router.query.next.startsWith('/') ? router.query.next : '/';
      router.replace(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--gray-50)', padding: 16 }}>
      <form className="card" style={{ width: '100%', maxWidth: 380 }} onSubmit={submit}>
        <div className="card-header"><h3>🧠 AI Test Agent Builder — Sign in</h3></div>
        <div className="card-body">
          {error && <div className="alert alert-error">⚠️ {error}</div>}
          <div className="form-group">
            <label className="form-label" htmlFor="email">Email</label>
            <input id="email" className="form-control" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="password">Password</label>
            <input id="password" className="form-control" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%', justifyContent: 'center' }}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="form-hint mt-3">The admin account is created from ADMIN_EMAIL / ADMIN_PASSWORD in the backend .env.</p>
        </div>
      </form>
    </div>
  );
}
