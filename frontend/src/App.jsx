import { useState, useEffect, useRef } from 'react';
import { signIn, signOut, getCurrentUser, fetchUserAttributes } from 'aws-amplify/auth';
import { listProjects, createProject, listTasks, createTask, updateTask, listUsers, listNotifications, getMetrics } from './api.js';

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Auth state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');

  // Data state
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(null);

  // Form state
  const [newProjectName, setNewProjectName] = useState('');
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [globalError, setGlobalError] = useState('');

  // Metrics state
  const [metrics, setMetrics] = useState(null);
  const [metricsError, setMetricsError] = useState('');

  // Notifications state
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [lastSeen, setLastSeen] = useState(null);
  const pollRef = useRef({ inFlight: false, timer: null });

  // Shell navigation & popover state
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const bellButtonRef = useRef(null);
  const notifPanelRef = useRef(null);
  const userMenuRef = useRef(null);

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        if (showNotifications) {
          setShowNotifications(false);
          bellButtonRef.current?.focus();
        }
        if (showUserMenu) {
          setShowUserMenu(false);
        }
        if (sidebarOpen) {
          setSidebarOpen(false);
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showNotifications, showUserMenu, sidebarOpen]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (showNotifications && notifPanelRef.current && !notifPanelRef.current.contains(e.target) && !bellButtonRef.current?.contains(e.target)) {
        setShowNotifications(false);
      }
      if (showUserMenu && userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setShowUserMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showNotifications, showUserMenu]);

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (user) {
      pollNotifications();
      pollRef.current.timer = setInterval(() => {
        if (!document.hidden && !pollRef.current.inFlight) {
          pollNotifications();
        }
      }, 12000);
      return () => {
        if (pollRef.current.timer) clearInterval(pollRef.current.timer);
      };
    }
  }, [user]);

  async function pollNotifications() {
    pollRef.current.inFlight = true;
    try {
      const data = await listNotifications();
      setNotifications(data.items || []);
    } catch (e) {
      // Ignored; api.js handles session expiry
    } finally {
      pollRef.current.inFlight = false;
    }
  }

  function loadLastSeen(userId) {
    try {
      const stored = localStorage.getItem(`uwpp:lastSeen:${userId}`);
      if (stored) setLastSeen(stored);
    } catch (e) {
      // Ignore
    }
  }

  function updateLastSeen() {
    if (!user) return;
    const now = new Date().toISOString();
    setLastSeen(now);
    try {
      localStorage.setItem(`uwpp:lastSeen:${user.userId}`, now);
    } catch (e) {
      // Ignore
    }
  }

  function toggleNotifications() {
    setShowNotifications(!showNotifications);
    if (!showNotifications) {
      setShowUserMenu(false);
      updateLastSeen();
    }
  }

  async function checkAuth() {
    try {
      const currentUser = await getCurrentUser();
      const attributes = await fetchUserAttributes();
      setUser({ ...currentUser, email: attributes.email });
      loadLastSeen(currentUser.userId);
      loadInitialData();
    } catch (e) {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    setAuthError('');
    setLoading(true);
    try {
      const result = await signIn({ username: email, password });
      if (result.nextStep?.signInStep !== 'DONE') {
        setAuthError('Account setup incomplete, contact admin');
        setLoading(false);
        return;
      }
      await checkAuth();
    } catch (e) {
      if (e.name === 'UserAlreadyAuthenticatedException') {
        await checkAuth();
      } else if (e.name === 'NotAuthorizedException') {
        setAuthError('Incorrect email or password.');
        setLoading(false);
      } else if (e.name === 'UserNotFoundException') {
        setAuthError('User does not exist.');
        setLoading(false);
      } else {
        setAuthError('An error occurred during login. Please try again.');
        setLoading(false);
      }
    }
  }

  async function handleLogout() {
    if (pollRef.current.timer) clearInterval(pollRef.current.timer);
    pollRef.current.inFlight = false;
    await signOut();
    setUser(null);
    setProjects([]);
    setTasks([]);
    setUsers([]);
    setActiveProjectId(null);
    setNotifications([]);
    setShowNotifications(false);
    setShowUserMenu(false);
    setSidebarOpen(false);
    setLastSeen(null);
    setMetrics(null);
    setMetricsError('');
  }

  async function loadMetrics() {
    try {
      const data = await getMetrics();
      setMetrics(data);
      setMetricsError('');
    } catch (e) {
      setMetricsError(`Failed to load metrics: ${e.message}`);
    }
  }

  async function loadInitialData() {
    try {
      const [projectsData, usersData] = await Promise.all([
        listProjects(),
        listUsers()
      ]);
      setProjects(projectsData.items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      setUsers(usersData.items);
      loadMetrics();
    } catch (e) {
      setGlobalError(`Failed to load data: ${e.message}`);
    }
  }

  async function loadTasks(projectId) {
    setActiveProjectId(projectId);
    setTasks([]);
    try {
      const data = await listTasks(projectId);
      setTasks(data.items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    } catch (e) {
      setGlobalError(`Failed to load tasks: ${e.message}`);
    }
  }

  async function handleCreateProject(e) {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    setIsSubmitting(true);
    setGlobalError('');
    try {
      const created = await createProject({ name: newProjectName });
      setProjects(prev => [...prev, created].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      setNewProjectName('');
      loadTasks(created.projectId);
    } catch (e) {
      setGlobalError(`Failed to create project: ${e.message}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCreateTask(e) {
    e.preventDefault();
    if (!newTaskTitle.trim() || !activeProjectId) return;
    setIsSubmitting(true);
    setGlobalError('');
    try {
      const created = await createTask({ projectId: activeProjectId, title: newTaskTitle });
      setTasks(prev => [...prev, created].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      setNewTaskTitle('');
      loadMetrics();
    } catch (e) {
      setGlobalError(`Failed to create task: ${e.message}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleUpdateTask(taskId, updates) {
    setGlobalError('');
    try {
      const updated = await updateTask(taskId, updates);
      setTasks(prev => prev.map(t => t.taskId === taskId ? updated : t));
      loadMetrics();
    } catch (e) {
      setGlobalError(`Failed to update task: ${e.message}`);
    }
  }

  if (loading) {
    return (
      <div className="app-loading-screen" role="status" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <span className="app-loading-text">Loading UWPP...</span>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="login-container">
        <div className="login-split">
          <div className="brand-panel">
            <div className="brand-header">
              <div className="brand-wordmark">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
                <span>UWPP</span>
              </div>
              <h1 className="brand-headline">Unified Workforce Productivity Platform</h1>
              <p className="brand-tagline">
                Cloud-native multi-tenant platform for team project tracking and productivity metrics.
              </p>
              <ul className="brand-features">
                <li className="brand-feature-item">
                  <svg className="brand-feature-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
                  </svg>
                  <span><strong>Organization data isolation:</strong> Cryptographically scoped multi-tenancy backed by Amazon Cognito and DynamoDB.</span>
                </li>
                <li className="brand-feature-item">
                  <svg className="brand-feature-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
                  </svg>
                  <span><strong>Assignment notifications:</strong> Event-driven task alerts delivered via Amazon EventBridge.</span>
                </li>
                <li className="brand-feature-item">
                  <svg className="brand-feature-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zm6-4a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zm6-3a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
                  </svg>
                  <span><strong>Team progress metrics:</strong> Real-time task completion rates and per-person workload visibility.</span>
                </li>
              </ul>
            </div>
            <div className="brand-footer">
              Enterprise Tenant Workspace &bull; Version 2.0
            </div>
          </div>

          <div className="login-form-panel">
            <div className="login-form-header">
              <h2 className="login-form-title">Sign in</h2>
              <p className="login-form-subtitle">Enter your organization credentials to access your workspace</p>
            </div>

            {authError && (
              <div className="error-banner" role="alert">
                <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <span>{authError}</span>
              </div>
            )}

            <form onSubmit={handleLogin}>
              <div className="form-group">
                <label htmlFor="login-email">Email</label>
                <input
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  placeholder="name@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="login-password">Password</label>
                <input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                />
              </div>
              <button type="submit" className="btn-primary btn-full-width" disabled={loading}>
                Sign in
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  const unseenCount = notifications.filter(n => !lastSeen || n.createdAt > lastSeen).length;
  const userEmail = user?.email || user?.username || '';
  const userInitials = userEmail.slice(0, 2).toUpperCase() || 'U';
  const activeProject = projects.find(p => p.projectId === activeProjectId);

  return (
    <div className="dashboard-container">
      <header className="app-header">
        <div className="header-left">
          <button
            type="button"
            className="mobile-drawer-toggle"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Toggle navigation drawer"
            aria-expanded={sidebarOpen}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="header-brand-badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
            <span>UWPP</span>
          </div>
          <span className="header-context-separator" aria-hidden="true">/</span>
          <span className="header-context-label">
            {activeProject ? activeProject.name : 'All Projects'}
          </span>
        </div>

        <div className="header-right">
          <div className="bell-wrapper">
            <button
              ref={bellButtonRef}
              type="button"
              className="bell-btn"
              onClick={toggleNotifications}
              aria-label={unseenCount > 0 ? `${unseenCount} unread notifications` : 'Notifications'}
              aria-expanded={showNotifications}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              {unseenCount > 0 && (
                <span className="bell-badge" aria-hidden="true">
                  {unseenCount}
                </span>
              )}
            </button>

            {showNotifications && (
              <div
                ref={notifPanelRef}
                className="notifications-popover"
                role="region"
                aria-label="Notifications"
              >
                <div className="notifications-popover-header">
                  <span className="notifications-popover-title">Notifications</span>
                  {notifications.length > 0 && (
                    <span className="badge badge-in-progress">
                      {notifications.length} total
                    </span>
                  )}
                </div>
                <div className="notifications-list">
                  {notifications.length === 0 ? (
                    <div className="notification-empty-state">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                      </svg>
                      <span>No notifications yet</span>
                    </div>
                  ) : (
                    notifications.slice(0, 10).map(n => {
                      const isUnseen = !lastSeen || n.createdAt > lastSeen;
                      return (
                        <div
                          key={n.notificationId}
                          className={`notification-card ${isUnseen ? 'notification-card-unread' : ''}`}
                        >
                          <div className="notification-card-header">
                            <span className="notification-card-message">{n.message}</span>
                          </div>
                          <span className="notification-card-time">
                            {new Date(n.createdAt).toLocaleString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit'
                            })}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="user-menu-wrapper" ref={userMenuRef}>
            <button
              type="button"
              className="user-avatar-btn"
              onClick={() => {
                const nextState = !showUserMenu;
                setShowUserMenu(nextState);
                if (nextState) setShowNotifications(false);
              }}
              aria-label="User account menu"
              aria-expanded={showUserMenu}
            >
              <span className="avatar avatar-sm">{userInitials}</span>
              <svg className="user-menu-chevron" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
              </svg>
            </button>

            {showUserMenu && (
              <div className="user-dropdown-popover" role="menu">
                <div className="user-dropdown-info">
                  <span className="user-dropdown-email">{userEmail}</span>
                  <span className="user-dropdown-role">Authenticated Member</span>
                </div>
                <button
                  type="button"
                  className="user-dropdown-signout"
                  onClick={handleLogout}
                  role="menuitem"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                  <span>Sign out</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {globalError && (
        <div className="error-banner" role="alert" style={{ margin: 'var(--space-4) var(--space-6) 0' }}>
          <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <span>{globalError}</span>
        </div>
      )}

      <main className="main-content">
        {sidebarOpen && (
          <div
            className="drawer-backdrop"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`} aria-label="Projects navigation">
          <div className="sidebar-header">
            <div className="sidebar-header-top">
              <h3 className="sidebar-title">Projects</h3>
              <button
                type="button"
                className="sidebar-close-btn"
                onClick={() => setSidebarOpen(false)}
                aria-label="Close navigation drawer"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <form onSubmit={handleCreateProject} className="sidebar-new-project-form">
              <input
                type="text"
                className="sidebar-new-project-input"
                placeholder="New project name..."
                value={newProjectName}
                onChange={e => setNewProjectName(e.target.value)}
                required
              />
              <button type="submit" className="btn-secondary" disabled={isSubmitting}>
                + Add Project
              </button>
            </form>
          </div>
          <div className="project-list" role="list">
            {projects.length === 0 ? (
              <div className="project-empty-state">No projects yet</div>
            ) : (
              projects.map(p => (
                <div
                  key={p.projectId}
                  role="listitem"
                  className={`project-item ${activeProjectId === p.projectId ? 'active' : ''}`}
                  onClick={() => {
                    loadTasks(p.projectId);
                    setSidebarOpen(false);
                  }}
                >
                  <span className="project-item-name">{p.name}</span>
                </div>
              ))
            )}
          </div>
        </aside>

        <section className="board-container">
          <div className="metrics-panel" style={{ padding: '1rem', background: '#f8f9fa', borderBottom: '1px solid #dee2e6', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>Team Metrics</h3>
              <button className="btn-secondary" onClick={loadMetrics} style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem' }}>Refresh</button>
            </div>
            {metricsError && <div style={{ color: 'red', fontSize: '0.8rem', marginTop: '0.5rem' }}>{metricsError}</div>}
            {metrics && !metricsError && (
              <div style={{ display: 'flex', gap: '2rem', marginTop: '1rem' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ marginBottom: '0.5rem' }}>
                    <strong>Completion Rate:</strong> {metrics.completionRate}% ({metrics.doneTasks} / {metrics.totalTasks} tasks)
                  </div>
                  <div className="progress-bar-bg" style={{ background: '#e9ecef', borderRadius: '4px', height: '16px', width: '100%', overflow: 'hidden' }}>
                    <div className="progress-bar-fill" style={{ background: '#28a745', height: '100%', width: `${metrics.completionRate}%`, transition: 'width 0.3s ease' }}></div>
                  </div>
                  <div style={{ marginTop: '0.5rem' }}>
                    <strong>Unassigned Tasks:</strong> {metrics.unassigned}
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #ccc' }}>
                        <th style={{ textAlign: 'left', padding: '4px' }}>Name</th>
                        <th style={{ textAlign: 'right', padding: '4px' }}>Done</th>
                        <th style={{ textAlign: 'right', padding: '4px' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.tasksPerPerson.map(p => (
                        <tr key={p.userId} style={{ borderBottom: '1px solid #eee' }}>
                          <td style={{ padding: '4px' }}>{p.name}</td>
                          <td style={{ textAlign: 'right', padding: '4px' }}>{p.done}</td>
                          <td style={{ textAlign: 'right', padding: '4px' }}>{p.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {activeProjectId ? (
            <>
              <div className="board-header">
                <h3>Tasks</h3>
                <form onSubmit={handleCreateTask} style={{ display: 'flex', gap: '1rem', marginTop: '1rem', maxWidth: '400px' }}>
                  <input
                    style={{ flex: 1, padding: '0.5rem' }}
                    type="text"
                    placeholder="New task title"
                    value={newTaskTitle}
                    onChange={e => setNewTaskTitle(e.target.value)}
                    required
                  />
                  <button type="submit" className="btn-primary" style={{ width: 'auto' }} disabled={isSubmitting}>Create Task</button>
                </form>
              </div>
              <div className="board-columns">
                {['TODO', 'IN_PROGRESS', 'DONE'].map(status => (
                  <div key={status} className="board-column">
                    <h3>{status.replace('_', ' ')}</h3>
                    <div className="task-list">
                      {tasks.filter(t => t.status === status).map(task => (
                        <div key={task.taskId} className="task-card">
                          <h4>{task.title}</h4>
                          {task.description && <p>{task.description}</p>}

                          <div className="task-actions">
                            <select
                              value={task.status}
                              onChange={e => handleUpdateTask(task.taskId, { status: e.target.value })}
                            >
                              <option value="TODO">TODO</option>
                              <option value="IN_PROGRESS">IN PROGRESS</option>
                              <option value="DONE">DONE</option>
                            </select>

                            <select
                              value={task.assignedTo || ''}
                              onChange={e => handleUpdateTask(task.taskId, { assignedTo: e.target.value })}
                            >
                              <option value="" disabled>Unassigned</option>
                              {users.map(u => (
                                <option key={u.userId} value={u.userId}>{u.name}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div style={{ padding: '2rem', color: '#666' }}>
              Select a project to view tasks
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
