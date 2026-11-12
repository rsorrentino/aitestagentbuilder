/**
 * Dashboard: sign-in health of the project's login profiles and Salesforce
 * personas — which ones need a person before the next runs.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';

const STATE: Record<string, string> = { ok: 'session ok', expiring: 'session expiring', expired: 'session expired', none: 'no saved session' };

export default function SignInHealthCard() {
  const [data, setData] = useState<{ identities: any[]; attention: number } | null>(null);

  useEffect(() => {
    api.get('/auth/health').then((r) => setData(r.data)).catch(() => setData(null));
  }, []);

  if (!data || data.identities.length === 0) return null;
  const attention = data.identities.filter((x) => x.attention);

  return (
    <div className="card" role="region" aria-label="Sign-in health">
      <div className="card-header"><h3>🔐 Sign-in health</h3></div>
      <div className="card-body text-sm">
        {attention.length === 0 ? (
          <p className="text-success" style={{ margin: 0 }}>All {data.identities.length} test users can sign in without a person.</p>
        ) : (
          <>
            <p className="text-muted" style={{ marginTop: 0 }}>{attention.length} of {data.identities.length} test users may need a person before the next runs:</p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {attention.slice(0, 6).map((x) => (
                <li key={`${x.agentId}-${x.kind}-${x.identity}`} className="mb-2">
                  <Link href={`/agents/${x.agentId}`}><strong>{x.identity}</strong></Link> <span className="text-muted">· {x.agentName}</span>
                  <div className={x.session === 'expired' || x.unattended === 'no' ? 'text-danger' : ''}>{STATE[x.session]} · {x.how}</div>
                  <div className="text-muted">{x.hint}</div>
                </li>
              ))}
            </ul>
            {attention.length > 6 && <p className="text-muted">…and {attention.length - 6} more</p>}
          </>
        )}
      </div>
    </div>
  );
}
