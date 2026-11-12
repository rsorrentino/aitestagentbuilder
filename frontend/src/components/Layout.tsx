/**
 * Shared Layout — sidebar (project switcher, navigation, user menu) + main area.
 */

import Link from 'next/link';
import { useRouter } from 'next/router';
import { ReactNode } from 'react';
import { setToken, BACKEND_URL } from '../lib/api';
import { useSession } from '../lib/session';

interface NavItem {
  href: string;
  icon: string;
  label: string;
  exact?: boolean;
  show?: boolean;
}

interface LayoutProps {
  children: ReactNode;
  title?: string;
  actions?: ReactNode;
}

export default function Layout({ children, title, actions }: LayoutProps) {
  const router = useRouter();
  const session = useSession();
  const { user, projects, project, isAdmin, authEnabled } = session;

  const isActive = (item: NavItem) => {
    if (item.exact) return router.pathname === item.href;
    if (item.href === '/runs') return router.pathname.startsWith('/runs') || router.pathname === '/live';
    return router.pathname.startsWith(item.href);
  };

  const signOut = () => {
    setToken(null);
    router.push('/login');
  };

  const sections: { label: string; items: NavItem[] }[] = [
    {
      label: 'Main',
      items: [
        { href: '/', icon: '🏠', label: 'Dashboard', exact: true },
        { href: '/agents', icon: '🤖', label: 'Agents' },
        { href: '/runs', icon: '▶️', label: 'Runs' },
        { href: '/testcases', icon: '🧪', label: 'Test Cases' },
        { href: '/testdata', icon: '🎲', label: 'Test Data' },
        { href: '/recorder', icon: '⏺', label: 'Recorder', show: session.can('editor') },
        { href: '/documents', icon: '📄', label: 'Documents' },
        { href: '/analytics', icon: '📈', label: 'Analytics' },
      ],
    },
    {
      label: 'Project',
      items: [
        { href: '/schedules', icon: '⏰', label: 'Schedules' },
        { href: '/settings/notifications', icon: '🔔', label: 'Notifications' },
        { href: '/projects', icon: '🗂️', label: 'Projects & Members' },
        { href: '/audit', icon: '📜', label: 'Audit Log', show: session.can('admin') },
      ],
    },
    {
      label: 'Tools',
      items: [
        { href: '/wizard/salesforce', icon: '⚡', label: 'SF Wizard' },
        { href: '/settings/ai-providers', icon: '⚙️', label: 'AI Providers' },
        { href: '/admin/users', icon: '👥', label: 'Users', show: isAdmin && authEnabled },
      ],
    },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-mark">🧠</div>
          <div className="logo-text">
            AI Test Agent
            <span>Builder</span>
          </div>
        </div>

        {projects.length > 0 && (
          <div style={{ padding: '0 14px 10px' }}>
            <label htmlFor="project-switcher" className="nav-section-label" style={{ padding: 0, display: 'block', marginBottom: 4 }}>Project</label>
            <select
              id="project-switcher"
              aria-label="Current project"
              value={project?.id ?? ''}
              onChange={(e) => session.switchProject(e.target.value)}
              style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,.2)', background: 'rgba(255,255,255,.08)', color: 'inherit', fontSize: 13 }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id} style={{ color: '#0f172a' }}>
                  {p.name}{p.archived ? ' (archived)' : ''}
                </option>
              ))}
            </select>
            {session.role && <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>Your role: {session.role}</div>}
          </div>
        )}

        <nav className="sidebar-nav">
          {sections.map((section) => (
            <div key={section.label}>
              <div className="nav-section-label">{section.label}</div>
              {section.items.filter((i) => i.show !== false).map((item) => (
                <Link key={item.href} href={item.href} className={`nav-item${isActive(item) ? ' active' : ''}`}>
                  <span className="nav-icon">{item.icon}</span>
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          {user && authEnabled && (
            <div style={{ marginBottom: 6 }}>
              <Link href="/account" style={{ color: 'inherit', fontSize: 12, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }} title="Account settings">
                👤 {user.email}
              </Link>
              <button className="btn btn-ghost btn-sm" onClick={signOut} style={{ marginTop: 4, padding: '2px 6px' }}>Sign out</button>
            </div>
          )}
          <div>
            <a href={`${BACKEND_URL}/api/docs`} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>API docs</a> · v1.1
          </div>
        </div>
      </aside>

      <div className="main-area">
        {project?.archived && (
          <div className="alert alert-warning" style={{ margin: 0, borderRadius: 0 }}>
            Project “{project.name}” is archived and read-only.
          </div>
        )}
        {(title || actions) && (
          <header className="page-header">
            {title && <h1>{title}</h1>}
            {actions && <div className="flex gap-3">{actions}</div>}
          </header>
        )}
        <main className="page-content">{children}</main>
      </div>
    </div>
  );
}
