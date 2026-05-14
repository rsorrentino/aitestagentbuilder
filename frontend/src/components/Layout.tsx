/**
 * Shared Layout — sidebar + main area shell for all pages.
 */

import Link from 'next/link';
import { useRouter } from 'next/router';
import { ReactNode } from 'react';

interface NavItem {
  href: string;
  icon: string;
  label: string;
  exact?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/',          icon: '🏠', label: 'Dashboard',   exact: true },
  { href: '/agents',    icon: '🤖', label: 'Agents' },
  { href: '/testcases', icon: '🧪', label: 'Test Cases' },
  { href: '/documents', icon: '📄', label: 'Documents' },
];

const SETTINGS_ITEMS: NavItem[] = [
  { href: '/wizard/salesforce',    icon: '⚡', label: 'SF Wizard' },
  { href: '/settings/ai-providers', icon: '⚙️', label: 'AI Providers' },
];

interface LayoutProps {
  children: ReactNode;
  title?: string;
  actions?: ReactNode;
}

export default function Layout({ children, title, actions }: LayoutProps) {
  const router = useRouter();

  const isActive = (item: NavItem) => {
    if (item.exact) return router.pathname === item.href;
    return router.pathname.startsWith(item.href);
  };

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-mark">🧠</div>
          <div className="logo-text">
            AI Test Agent
            <span>Builder</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section-label">Main</div>
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item${isActive(item) ? ' active' : ''}`}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </Link>
          ))}

          <div className="nav-section-label">Tools</div>
          {SETTINGS_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item${isActive(item) ? ' active' : ''}`}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="sidebar-footer">
          v1.0 MVP &bull; MIT License
        </div>
      </aside>

      {/* Main */}
      <div className="main-area">
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
