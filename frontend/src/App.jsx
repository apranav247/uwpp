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

  if (loading) return <div>Loading...</div>;

  if (!user) {
    return (
      <div className="login-container">
        <div className="login-card">
          <h1>Sign in</h1>
          {authError && <div className="error-banner">{authError}</div>}
          <form onSubmit={handleLogin}>
            <div className="form-group">
              <label>Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div className="form-group">
              <label>Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required />
            </div>
            <button type="submit" className="btn-primary" disabled={loading}>Sign in</button>
          </form>
        </div>
      </div>
    );
  }

  const unseenCount = notifications.filter(n => !lastSeen || n.createdAt > lastSeen).length;

  return (
    <div className="dashboard-container">
      <header className="app-header">
        <div>
          <strong>UWPP</strong> - {user.email || user.username}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', position: 'relative' }}>
          <button className="btn-secondary" onClick={toggleNotifications} style={{ position: 'relative' }}>
            🔔 Bell
            {unseenCount > 0 && (
              <span className="badge" style={{ position: 'absolute', top: -5, right: -5, background: 'red', color: 'white', borderRadius: '50%', padding: '2px 6px', fontSize: '0.8rem' }}>
                {unseenCount}
              </span>
            )}
          </button>
          {showNotifications && (
            <div className="notifications-panel" style={{ position: 'absolute', top: '100%', right: '70px', background: 'white', border: '1px solid #ccc', zIndex: 10, width: '300px', maxHeight: '400px', overflowY: 'auto', boxShadow: '0 4px 6px rgba(0,0,0,0.1)', color: 'black' }}>
              <div style={{ padding: '0.5rem', borderBottom: '1px solid #eee', fontWeight: 'bold' }}>Notifications</div>
              {notifications.length === 0 ? (
                <div style={{ padding: '1rem', color: '#666' }}>No notifications</div>
              ) : (
                notifications.slice(0, 10).map(n => (
                  <div key={n.notificationId} style={{ padding: '0.5rem', borderBottom: '1px solid #eee', textAlign: 'left' }}>
                    <div style={{ fontSize: '0.9rem' }}>{n.message}</div>
                    <div style={{ fontSize: '0.8rem', color: '#666' }}>{new Date(n.createdAt).toLocaleString()}</div>
                  </div>
                ))
              )}
            </div>
          )}
          <button className="btn-secondary" onClick={handleLogout}>Sign out</button>
        </div>
      </header>

      {globalError && <div className="error-banner" style={{ margin: '1rem 2rem 0' }}>{globalError}</div>}

      <main className="main-content">
        <aside className="sidebar">
          <div className="sidebar-header">
            <h3>Projects</h3>
            <form onSubmit={handleCreateProject} style={{ marginTop: '1rem' }}>
              <div className="form-group" style={{ marginBottom: '0.5rem' }}>
                <input
                  type="text"
                  placeholder="New project name"
                  value={newProjectName}
                  onChange={e => setNewProjectName(e.target.value)}
                  required
                />
              </div>
              <button type="submit" className="btn-primary" disabled={isSubmitting}>Create Project</button>
            </form>
          </div>
          <div className="project-list">
            {projects.map(p => (
              <div
                key={p.projectId}
                className={`project-item ${activeProjectId === p.projectId ? 'active' : ''}`}
                onClick={() => loadTasks(p.projectId)}
              >
                {p.name}
              </div>
            ))}
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
