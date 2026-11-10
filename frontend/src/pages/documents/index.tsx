/**
 * Documents — upload test specifications and extract test cases with AI.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Layout from '../../components/Layout';
import { api, errorMessage, statusBadge } from '../../lib/api';

const SUPPORTED_TYPES = '.pdf,.docx,.xlsx,.xls,.csv,.txt,.md,.html';

function fileIcon(name: string) {
  const n = name.toLowerCase();
  if (n.endsWith('.pdf')) return '📕';
  if (n.endsWith('.docx')) return '📘';
  if (n.endsWith('.xlsx') || n.endsWith('.xls') || n.endsWith('.csv')) return '📊';
  if (n.endsWith('.md')) return '📝';
  return '📄';
}

function formatSize(bytes?: number) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState<string | null>(null);
  const [module, setModule] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const fetchDocuments = useCallback(async () => {
    try {
      const res = await api.get('/ingestion/documents');
      setDocuments(res.data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDocuments();
    api.get('/llm/providers').then((r) => setAiReady(!!r.data.anyConfigured)).catch(() => setAiReady(null));
  }, [fetchDocuments]);

  const uploadFile = async (file: File) => {
    setUploading(true);
    setError(null);
    setSuccess(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      await api.post('/ingestion/upload', fd);
      setSuccess(`“${file.name}” uploaded. Click “Extract Tests” to turn it into test cases.`);
      await fetchDocuments();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const extract = async (docId: string) => {
    setExtracting(docId);
    setError(null);
    setSuccess(null);
    try {
      const res = await api.post(`/ingestion/documents/${docId}/extract`, { module: module.trim() || undefined });
      const truncated = res.data.metadata?.truncated ? ' (document was long — only the first part was analysed)' : '';
      setSuccess(`✅ ${res.data.extracted} test case(s) extracted with ${res.data.metadata?.provider}${truncated}.`);
      await fetchDocuments();
    } catch (err) {
      setError(errorMessage(err));
      await fetchDocuments();
    } finally {
      setExtracting(null);
    }
  };

  const remove = async (docId: string) => {
    if (!confirm('Delete this document? Extracted test cases are kept.')) return;
    try {
      await api.delete(`/ingestion/documents/${docId}`);
      setDocuments((prev) => prev.filter((d) => d.id !== docId));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Layout title="Documents">
      {aiReady === false && (
        <div className="alert alert-warning">
          No AI provider is configured, so extraction is unavailable. See <Link href="/settings/ai-providers">AI Providers</Link>.
        </div>
      )}
      {error && <div className="alert alert-error">⚠️ {error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      <div
        className="card mb-6"
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) uploadFile(f); }}
        onDragOver={(e) => e.preventDefault()}
        style={{ border: '2px dashed var(--gray-300)', cursor: 'pointer' }}
        onClick={() => fileRef.current?.click()}
      >
        <div className="empty-state" style={{ padding: '36px 20px' }}>
          {uploading ? (
            <><div className="spinner" style={{ width: 36, height: 36 }} /><p style={{ marginTop: 16 }}>Uploading…</p></>
          ) : (
            <>
              <div className="empty-icon">📂</div>
              <h3>Drop a test specification here or click to browse</h3>
              <p>PDF, Word (.docx), Excel (.xlsx), CSV, Markdown, HTML or TXT · max 50 MB</p>
              <div className="btn btn-primary">Choose File</div>
            </>
          )}
        </div>
        <input ref={fileRef} type="file" accept={SUPPORTED_TYPES} style={{ display: 'none' }} data-testid="file-input"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ''; }} />
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Uploaded Documents</h3>
          <div className="flex gap-2" style={{ alignItems: 'center' }}>
            <input className="form-control" style={{ width: 220 }} value={module} onChange={(e) => setModule(e.target.value)}
              placeholder="Default module (optional)" aria-label="Default module for extracted tests" />
            <button className="btn btn-secondary btn-sm" onClick={fetchDocuments}>↻</button>
          </div>
        </div>
        {loading ? (
          <div className="page-loading"><div className="spinner" /></div>
        ) : documents.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📄</div>
            <h3>No documents yet</h3>
            <p>Upload a test book — the AI will extract structured, executable test cases from it.</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead><tr><th>Document</th><th>Status</th><th>Tests</th><th>Size</th><th>Uploaded</th><th>Actions</th></tr></thead>
              <tbody>
                {documents.map((doc) => (
                  <tr key={doc.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 20 }}>{fileIcon(doc.name)}</span>
                        <div>
                          <div className="fw-600" style={{ fontSize: 14 }}>{doc.name}</div>
                          {doc.status === 'failed' && doc.error && <div className="text-sm text-danger">{doc.error}</div>}
                        </div>
                      </div>
                    </td>
                    <td><span className={statusBadge(doc.status)}>{extracting === doc.id ? 'processing' : doc.status}</span></td>
                    <td className="fw-600">
                      {doc.testCaseCount > 0 ? <Link href={`/testcases`}>{doc.testCaseCount}</Link> : '—'}
                    </td>
                    <td className="text-sm text-muted">{formatSize(doc.fileSize)}</td>
                    <td className="text-sm text-muted">{new Date(doc.uploadedAt).toLocaleString()}</td>
                    <td>
                      <div className="flex gap-2">
                        <button className="btn btn-primary btn-sm" onClick={() => extract(doc.id)} disabled={!!extracting || aiReady === false}>
                          {extracting === doc.id ? 'Extracting…' : doc.testCaseCount > 0 ? '🔍 Extract again' : '🔍 Extract Tests'}
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => remove(doc.id)} title="Delete document">🗑</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
}
