/**
 * Test Run Detail Page with Real-time Updates
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import axios from 'axios';
import io from 'socket.io-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3000';

export default function RunDetail() {
  const router = useRouter();
  const { id } = router.query;
  const [run, setRun] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;

    // Fetch initial run data
    fetchRunData();

    // Connect to WebSocket for real-time updates
    const socket = io(WS_URL, {
      path: '/ws',
    });

    socket.on('connect', () => {
      console.log('WebSocket connected');
    });

    socket.on('run_progress', (data: any) => {
      if (data.runId === id) {
        setRun((prev: any) => ({
          ...prev,
          ...data,
        }));
      }
    });

    socket.on('test_result', (data: any) => {
      if (data.runId === id) {
        fetchRunData(); // Refresh data
      }
    });

    socket.on('run_completed', (data: any) => {
      if (data.runId === id) {
        fetchRunData(); // Refresh data
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [id]);

  const fetchRunData = async () => {
    try {
      const response = await axios.get(`${API_URL}/runs/${id}`);
      setRun(response.data);
    } catch (error) {
      console.error('Failed to fetch run data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading || !run) {
    return <div className="container">Loading...</div>;
  }

  const progress = run.totalTests > 0 
    ? ((run.passedTests + run.failedTests) / run.totalTests) * 100 
    : 0;

  return (
    <div className="container">
      <h1>Test Run: {run.id}</h1>

      <div className="run-header">
        <div className="status-badge large {run.status}">{run.status}</div>
        <div className="meta">
          <p>Started: {new Date(run.startedAt).toLocaleString()}</p>
          {run.finishedAt && (
            <p>Finished: {new Date(run.finishedAt).toLocaleString()}</p>
          )}
          {run.duration && (
            <p>Duration: {(run.duration / 1000).toFixed(2)}s</p>
          )}
        </div>
      </div>

      <div className="progress-bar">
        <div 
          className="progress-fill" 
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="stats">
        <div className="stat">
          <span className="label">Total:</span>
          <span className="value">{run.totalTests}</span>
        </div>
        <div className="stat passed">
          <span className="label">Passed:</span>
          <span className="value">{run.passedTests}</span>
        </div>
        <div className="stat failed">
          <span className="label">Failed:</span>
          <span className="value">{run.failedTests}</span>
        </div>
        <div className="stat">
          <span className="label">Skipped:</span>
          <span className="value">{run.skippedTests}</span>
        </div>
      </div>

      <div className="results">
        <h2>Test Results</h2>
        {run.results && run.results.map((result: any) => (
          <div key={result.id} className={`result-card ${result.status}`}>
            <div className="result-header">
              <h3>{result.testCaseId}</h3>
              <span className={`status-badge ${result.status}`}>
                {result.status}
              </span>
            </div>
            {result.error && (
              <div className="error">{result.error}</div>
            )}
            {result.duration && (
              <div className="duration">
                Duration: {(result.duration / 1000).toFixed(2)}s
              </div>
            )}
          </div>
        ))}
      </div>

      <style jsx>{`
        .container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 20px;
        }
        .run-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }
        .status-badge {
          padding: 8px 16px;
          border-radius: 4px;
          font-weight: bold;
        }
        .status-badge.large {
          font-size: 18px;
        }
        .status-badge.completed {
          background: #28a745;
          color: white;
        }
        .status-badge.running {
          background: #ffc107;
          color: black;
        }
        .status-badge.failed {
          background: #dc3545;
          color: white;
        }
        .progress-bar {
          width: 100%;
          height: 30px;
          background: #f0f0f0;
          border-radius: 4px;
          overflow: hidden;
          margin-bottom: 20px;
        }
        .progress-fill {
          height: 100%;
          background: #28a745;
          transition: width 0.3s ease;
        }
        .stats {
          display: flex;
          gap: 20px;
          margin-bottom: 30px;
        }
        .stat {
          padding: 15px;
          background: #f9f9f9;
          border-radius: 8px;
        }
        .stat.passed .value {
          color: #28a745;
        }
        .stat.failed .value {
          color: #dc3545;
        }
        .result-card {
          padding: 15px;
          margin-bottom: 10px;
          border-radius: 8px;
          border-left: 4px solid #ddd;
        }
        .result-card.passed {
          border-left-color: #28a745;
        }
        .result-card.failed {
          border-left-color: #dc3545;
        }
        .error {
          color: #dc3545;
          margin-top: 10px;
          padding: 10px;
          background: #f8d7da;
          border-radius: 4px;
        }
      `}</style>
    </div>
  );
}

