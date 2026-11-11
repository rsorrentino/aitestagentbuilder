/** Quarantined tests of the current project, with quarantine / release actions. */

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

export interface QuarantineEntry {
  testCaseId: string;
  reason: string;
  auto: boolean;
  quarantinedBy?: string;
  quarantinedAt: string;
  title?: string;
}

export function useQuarantine() {
  const [entries, setEntries] = useState<Map<string, QuarantineEntry>>(new Map());

  const reload = useCallback(async () => {
    try {
      const res = await api.get('/quarantine');
      setEntries(new Map(res.data.map((q: QuarantineEntry) => [q.testCaseId, q])));
    } catch {
      setEntries(new Map());
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const quarantine = async (testCaseId: string, reason?: string) => {
    await api.post(`/testcases/${encodeURIComponent(testCaseId)}/quarantine`, { reason });
    await reload();
  };
  const release = async (testCaseId: string) => {
    await api.delete(`/testcases/${encodeURIComponent(testCaseId)}/quarantine`);
    await reload();
  };

  /** Analytics ids carry a persona suffix ("TC-1@rep"): look up by the test case id. */
  const get = (id: string) => entries.get(id.split('@')[0]);

  return { entries, get, quarantine, release, reload };
}
