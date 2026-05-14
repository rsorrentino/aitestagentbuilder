/**
 * Main Dashboard Page
 */

import { useState, useEffect } from 'react';
import axios from 'axios';
import Link from 'next/link';
import ChatPanel from '../components/ChatPanel';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

export default function Dashboard() {
  const [runs, setRuns] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showChat, setShowChat] = useState(false);

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
      <div className="top-bar">
        <h1>AI Test Agent Builder</h1>
        <div className="top-actions">
          <Link href="/wizard/salesforce" className="action-btn wizard-btn">
            ⚡ Salesforce Wizard
          </Link>
          <Link href="/settings/ai-providers" className="action-btn">
            ⚙️ AI Providers
          </Link>
          <button className="action-btn chat-btn" onClick={() => setShowChat(!showChat)}>
            {showChat ? '✕ Close Chat' : '💬 AI Assistant'}
          </button>
        </div>
      </div>

      {showChat && (
        <div className="chat-section">
          <ChatPanel
            agentContext={{ agents: agents.slice(0, 3), recentRuns: runs.slice(0, 3) }}
            onTestsGenerated={(tests) => console.log('Generated tests:', tests)}
          />
        </div>
      )}

      <div className="stats">
        <div className="stat-card">
          <h3>Total Agents</h3>
          <p className="stat-value">{agents.length}</p>
        </div>
        <div className="stat-card">
          <h3>Recent Runs</h3>
          <p className="stat-value">{runs.length}</p>
        </div>
        <div className="stat-card">
          <h3>Quick Actions</h3>
          <div className="quick-links">
            <Link href="/wizard/salesforce">New Salesforce Agent</Link>
            <Link href="/settings/ai-providers">Provider Health</Link>
          </div>
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
              <th>Live</th>
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
                <td>
                  <Link href={`/live?runId=${run.id}`} className="live-link">▶ Live</Link>
                </td>
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
              <div className="agent-card-header">
                <h3>{agent.name}</h3>
                {agent.config?.platform === 'salesforce' && (
                  <span className="platform-badge sf">Salesforce</span>
                )}
              </div>
              <p>Type: {agent.config.application_type}</p>
              <p>Status: {agent.status}</p>
              {agent.config?.ai?.provider && (
                <p>AI: {agent.config.ai.provider}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      <style jsx>{`
        .container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 20px;
          font-family: sans-serif;
        }
        .top-bar {
          display: flex;
          align-items: center;
          gap: 16px;
          margin-bottom: 20px;
          flex-wrap: wrap;
        }
        h1 { margin: 0; font-size: 24px; }
        .top-actions {
          margin-left: auto;
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }
        .action-btn {
          padding: 8px 14px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          border: 1px solid #ddd;
          background: white;
          text-decoration: none;
          color: #333;
        }
        .wizard-btn { background: #1a1a2e; color: white; border-color: #1a1a2e; }
        .chat-btn { background: #4a90d9; color: white; border-color: #4a90d9; }
        .chat-section { margin-bottom: 24px; }
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
        .quick-links {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-top: 10px;
        }
        .quick-links a { font-size: 13px; color: #4a90d9; text-decoration: none; }
        .section { margin-top: 30px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
        .status-badge {
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: bold;
        }
        .status-badge.completed { background: #28a745; color: white; }
        .status-badge.running { background: #ffc107; color: black; }
        .status-badge.failed { background: #dc3545; color: white; }
        .passed { color: #28a745; }
        .failed { color: #dc3545; }
        .live-link { font-size: 12px; color: #fd7e14; text-decoration: none; font-weight: 600; }
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
        .agent-card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }
        .agent-card-header h3 { margin: 0; font-size: 15px; }
        .platform-badge {
          font-size: 10px;
          padding: 2px 7px;
          border-radius: 10px;
          font-weight: 700;
        }
        .platform-badge.sf { background: #0d9dda; color: white; }
      `}</style>
    </div>
  );
}

