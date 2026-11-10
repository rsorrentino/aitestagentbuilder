/**
 * ChatPanel Component
 *
 * Conversational AI interface for natural-language test authoring.
 * Lets users describe tests in plain English and receive structured TestCase output.
 */

import { useState, useRef, useEffect } from 'react';
import { api, errorMessage } from '../lib/api';


interface Message {
  role: 'user' | 'assistant';
  content: string;
  provider?: string;
}

interface ChatPanelProps {
  /** Optional agent context to inject into the system prompt */
  agentContext?: Record<string, any>;
  /** Called when the AI generates usable test cases */
  onTestsGenerated?: (tests: any[]) => void;
}

export default function ChatPanel({ agentContext, onTestsGenerated }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content:
        'Hi! I\'m your AI testing assistant. Describe what you want to test and I\'ll write executable test cases you can save. For example: "Create a test that logs in at /login with user demo and checks the dashboard greets the user."',
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState<string>('auto');
  const [pendingTests, setPendingTests] = useState<any[]>([]);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const userMessage: Message = { role: 'user', content: trimmed };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      const response = await api.post(`/chat`, {
        messages: updatedMessages
          .filter((m) => m.role !== 'assistant' || updatedMessages.indexOf(m) !== 0)
          .map((m) => ({ role: m.role, content: m.content })),
        task: 'chat',
        context: agentContext,
      });

      const assistantMessage: Message = {
        role: 'assistant',
        content: response.data.content,
        provider: response.data.provider,
      };
      setMessages((prev) => [...prev, assistantMessage]);
      setProvider(response.data.provider ?? provider);

      // If the response contains a JSON array of tests, offer to save them
      const fenced = response.data.content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonMatch = fenced ? fenced[1] : response.data.content.match(/\[[\s\S]+\]/)?.[0];
      if (jsonMatch) {
        try {
          const tests = JSON.parse(jsonMatch);
          if (Array.isArray(tests) && tests.length && tests.every((t: any) => t && t.title)) {
            setPendingTests(tests);
            setSaveNote(null);
            onTestsGenerated?.(tests);
          }
        } catch {
          // Not valid JSON — that's fine
        }
      }
    } catch (err: any) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const saveTests = async () => {
    let saved = 0;
    const failures: string[] = [];
    for (const t of pendingTests) {
      try {
        await api.post('/testcases', { module: 'General', expectedResults: [], ...t, tags: [...(t.tags ?? []), 'ai-chat'] });
        saved++;
      } catch (err) {
        failures.push(`${t.title}: ${errorMessage(err)}`);
      }
    }
    setSaveNote(`Saved ${saved} test case(s) to Test Cases.${failures.length ? ` Failed: ${failures.join('; ')}` : ''}`);
    setPendingTests([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span>AI Test Authoring Assistant</span>
        <span className="provider-badge">{provider}</span>
      </div>

      <div className="chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            <div className="message-content">{msg.content}</div>
            {msg.provider && <div className="message-provider">via {msg.provider}</div>}
          </div>
        ))}
        {loading && (
          <div className="message assistant">
            <div className="message-content typing">Thinking…</div>
          </div>
        )}
        {error && <div className="error-banner">{error}</div>}
        {pendingTests.length > 0 && (
          <div className="save-banner">
            <span>{pendingTests.length} test case(s) found in the reply.</span>
            <button onClick={saveTests}>Save to Test Cases</button>
          </div>
        )}
        {saveNote && <div className="save-banner">{saveNote}</div>}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-area">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe your test scenario… (Enter to send, Shift+Enter for new line)"
          rows={3}
          disabled={loading}
        />
        <button onClick={sendMessage} disabled={loading || !input.trim()}>
          {loading ? '…' : 'Send'}
        </button>
      </div>

      <style jsx>{`
        .chat-panel {
          display: flex;
          flex-direction: column;
          height: 500px;
          border: 1px solid #ddd;
          border-radius: 8px;
          overflow: hidden;
          font-family: sans-serif;
        }
        .chat-header {
          background: #1a1a2e;
          color: white;
          padding: 10px 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-weight: 600;
        }
        .provider-badge {
          background: #4a90d9;
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 12px;
        }
        .chat-messages {
          flex: 1;
          overflow-y: auto;
          padding: 12px;
          background: #fafafa;
        }
        .message {
          margin: 8px 0;
          max-width: 80%;
        }
        .message.user {
          margin-left: auto;
        }
        .message.assistant {
          margin-right: auto;
        }
        .message-content {
          padding: 10px 14px;
          border-radius: 12px;
          white-space: pre-wrap;
          font-size: 14px;
          line-height: 1.5;
        }
        .message.user .message-content {
          background: #4a90d9;
          color: white;
          border-bottom-right-radius: 4px;
        }
        .message.assistant .message-content {
          background: white;
          border: 1px solid #e0e0e0;
          border-bottom-left-radius: 4px;
        }
        .message-provider {
          font-size: 11px;
          color: #999;
          margin-top: 3px;
          padding-left: 4px;
        }
        .typing {
          color: #888;
          font-style: italic;
        }
        .error-banner {
          background: #fff0f0;
          border: 1px solid #ffcccc;
          color: #c00;
          padding: 8px 12px;
          border-radius: 6px;
          font-size: 13px;
          margin: 8px 0;
        }
        .save-banner {
          display: flex;
          gap: 10px;
          align-items: center;
          justify-content: space-between;
          background: #eef2ff;
          border: 1px solid #c7d2fe;
          padding: 8px 12px;
          border-radius: 6px;
          font-size: 13px;
          margin: 8px 0;
        }
        .chat-input-area {
          display: flex;
          gap: 8px;
          padding: 10px;
          border-top: 1px solid #eee;
          background: white;
        }
        textarea {
          flex: 1;
          resize: none;
          border: 1px solid #ccc;
          border-radius: 6px;
          padding: 8px;
          font-size: 14px;
          font-family: inherit;
        }
        textarea:focus {
          outline: none;
          border-color: #4a90d9;
        }
        button {
          padding: 8px 16px;
          background: #4a90d9;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 600;
          align-self: flex-end;
        }
        button:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}
