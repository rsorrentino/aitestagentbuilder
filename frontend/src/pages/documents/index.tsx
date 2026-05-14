/**
 * Documents Page — upload test books and manage extracted documents.
 */

import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import Layout from '../../components/Layout';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

const SUPPORTED_TYPES = '.pdf,.docx,.xlsx,.csv,.txt,.md';

function fileIcon(name: string) {
  if (name.endsWith('.pdf'))  return '📕';
  if (name.endsWith('.docx')) return '📘';
  if (name.endsWith('.xlsx') || name.endsWith('.csv')) return '📊';
  if (name.endsWith('.md'))   return '📝';
  return '📄';
}

export default function DocumentsPage() {
  const [documents, setDocuments]   = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [uploading, setUploading]   = useState(false);
  const [extracting, setExtracting] = useState<string | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [success, setSuccess]       = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { fetchDocuments(); }, []);

  const fetchDocuments = async () => {
    setLoading(true);
    try {
      const res = await axios.get(`${API_URL}/ingestion/documents`).catch(() => ({ data: [] }));
      setDocuments(Array.isArray(res.data) ? res.data : []);
    } finally {
      setLoading(false);
    }
  };

  const uploadFile = async (file: File) => {
    setUploading(true);
    setError(null);
    setSuccess(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      await axios.post(`${API_URL}/ingestion/upload`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setSuccess(`"${file.name}" uploaded successfully!`);
      await fetchDocuments();
    } catch (err: any) {
      setError(err.response?.data?.error ?? err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  };

  const extract = async (docId: string) => {
    setExtracting(docId);
    setError(null);
    try {
      await axios.post(`${API_URL}/ingestion/documents/${docId}/extract`);
      setSuccess('Test cases extracted and saved successfully!');
      await fetchDocuments();
    } catch (err: any) {
      setError(err.response?.data?.error ?? err.message);
    } finally {
      setExtracting(null);
    }
  };

  return (
    <Layout title="Documents">
      {error   && <div className="alert alert-error">⚠️ {error}</div>}
      {success && <div className="alert alert-success">✅ {success}</div>}

      {/* Upload zone */}
      <div
        className="card mb-6"
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        style={{ border: '2px dashed var(--gray-300)', cursor: 'pointer' }}
        onClick={() => fileRef.current?.click()}
      >
        <div className="empty-state" style={{ padding: '40px 20px' }}>
          {uploading ? (
            <>
              <div className="spinner" style={{ width: 36, height: 36 }} />
              <p style={{ marginTop: 16 }}>Uploading…</p>
            </>
          ) : (
            <>
              <div className="empty-icon">📂</div>
              <h3>Drop a file here or click to browse</h3>
              <p>Supported: PDF, Word (.docx), Excel (.xlsx), CSV, Markdown (.md), TXT<br/>Max size: 50 MB</p>
              <div className="btn btn-primary">Choose File</div>
            </>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={SUPPORTED_TYPES}
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ''; }}
        />
      </div>

      {/* Document list */}
      <div className="card">
        <div className="card-header">
          <h3>Uploaded Documents</h3>
          <button className="btn btn-secondary btn-sm" onClick={fetchDocuments}>↻ Refresh</button>
        </div>
        {loading ? (
          <div className="page-loading"><div className="spinner" /></div>
        ) : documents.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📄</div>
            <h3>No documents yet</h3>
            <p>Upload a test book — the AI will extract structured test cases from it automatically.</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Status</th>
                  <th>Tests Found</th>
                  <th>Uploaded</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr key={doc.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 20 }}>{fileIcon(doc.fileName ?? doc.name ?? '')}</span>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>{doc.fileName ?? doc.name ?? doc.id}</div>
                          <div className="text-sm text-muted code">{doc.id.slice(0, 10)}…</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={
                        doc.status === 'processed' ? 'badge badge-success' :
                        doc.status === 'processing' ? 'badge badge-warning' :
                        doc.status === 'failed' ? 'badge badge-danger' : 'badge badge-neutral'
                      }>{doc.status ?? 'uploaded'}</span>
                    </td>
                    <td className="fw-600">{doc.testCaseCount ?? doc.extractedCount ?? '—'}</td>
                    <td className="text-sm text-muted">{new Date(doc.createdAt ?? doc.uploadedAt).toLocaleDateString()}</td>
                    <td>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => extract(doc.id)}
                        disabled={extracting === doc.id}
                      >
                        {extracting === doc.id ? '…' : '🔍 Extract Tests'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* How it works */}
      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-header"><h3>How It Works</h3></div>
        <div className="card-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
            {[
              ['1. Upload', '📤', 'Upload your test specification document — PDF, Word, Excel, or plain text.'],
              ['2. Extract', '🔍', 'The AI reads your document and extracts structured test cases automatically.'],
              ['3. Review', '✅', 'Review and edit the extracted test cases in the Test Cases page.'],
              ['4. Run', '▶', 'Assign test cases to an agent and trigger an automated test run.'],
            ].map(([step, icon, desc]) => (
              <div key={String(step)} style={{ textAlign: 'center', padding: 16 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>{icon}</div>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>{step}</div>
                <div className="text-sm text-muted">{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Layout>
  );
}
