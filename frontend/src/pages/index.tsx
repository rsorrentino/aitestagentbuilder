/**
 * Main Dashboard Page
 */

import { useState, useEffect } from 'react';
import axios from 'axios';
import Link from 'next/link';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

export default function Dashboard() {
  const [runs, setRuns] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [runsRes, agentsRes] = await Promise.all([
        axios.get(`${API_URL}/runs?limit=10`),
        axios.get(`${API_URL}/agents?limit=10`),
      ]);
      setRuns(runsRes.data);
      setAgents(agentsRes.data);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="container">Loading...</div>;
  }

  return (
    <div className="container">
      <h1>AI Test Agent Builder Dashboard</h1>

      <div className="stats">
        <div className="stat-card">
          <h3>Total Agents</h3>
          <p className="stat-value">{agents.length}</p>
        </div>
        <div className="stat-card">
          <h3>Recent Runs</h3>
          <p className="stat-value">{runs.length}</p>
        </div>
      </div>

      <div className="section">
        <h2>Recent Test Runs</h2>
        <table>
          <thead>
            <tr>
              <th>Run ID</th>
              <th>Status</th>
              <th>Tests</th>
              <th>Passed</th>
              <th>Failed</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>
                  <Link href={`/runs/${run.id}`}>{run.id}</Link>
                </td>
                <td>
                  <span className={`status-badge ${run.status}`}>{run.status}</span>
                </td>
                <td>{run.totalTests}</td>
                <td className="passed">{run.passedTests}</td>
                <td className="failed">{run.failedTests}</td>
                <td>{new Date(run.startedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section">
        <h2>Agents</h2>
        <div className="agent-list">
          {agents.map((agent) => (
            <div key={agent.id} className="agent-card">
              <h3>{agent.name}</h3>
              <p>Type: {agent.config.application_type}</p>
              <p>Status: {agent.status}</p>
            </div>
          ))}
        </div>
      </div>

      <style jsx>{`
        .container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 20px;
        }
        .stats {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 20px;
          margin-bottom: 30px;
        }
        .stat-card {
          background: #f5f5f5;
          padding: 20px;
          border-radius: 8px;
        }
        .stat-value {
          font-size: 32px;
          font-weight: bold;
          margin: 10px 0 0 0;
        }
        .section {
          margin-top: 30px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
        }
        th, td {
          padding: 12px;
          text-align: left;
          border-bottom: 1px solid #ddd;
        }
        .status-badge {
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: bold;
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
        .passed {
          color: #28a745;
        }
        .failed {
          color: #dc3545;
        }
        .agent-list {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
          gap: 20px;
        }
        .agent-card {
          background: #f9f9f9;
          padding: 15px;
          border-radius: 8px;
          border: 1px solid #ddd;
        }
      `}</style>
    </div>
  );
}

