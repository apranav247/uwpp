import { useState, useEffect } from 'react';
import { signIn, signOut, fetchAuthSession, getCurrentUser } from 'aws-amplify/auth';

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const currentUser = await getCurrentUser();
      const session = await fetchAuthSession();
      const orgId = session.tokens.idToken.payload['custom:orgId'];
      setUser({ ...currentUser, orgId });
    } catch (e) {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signIn({ username: email, password });
      await checkAuth();
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  }

  async function handleLogout() {
    await signOut();
    setUser(null);
  }

  if (loading) {
    return <div className="loading-state">Loading...</div>;
  }

  if (user) {
    return (
      <div className="dashboard-container">
        <header className="glass-header">
          <div className="header-brand">
            <h1>UWPP</h1>
            <span className="badge">{user.orgId}</span>
          </div>
          <button onClick={handleLogout} className="btn-secondary">Logout</button>
        </header>
        
        <main className="dashboard-main">
          <h2>Welcome to {user.orgId}</h2>
          <p>You are logged in as {user.username}</p>
          <div className="card">
            <h3>API Connection</h3>
            <p>Ready to fetch data from: <code>{import.meta.env.VITE_API_URL}</code></p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-card glass-panel">
        <div className="brand-header">
          <div className="logo-placeholder"></div>
          <h1>UWPP</h1>
          <p>Sign in to your workspace</p>
        </div>
        
        <form onSubmit={handleLogin} className="login-form">
          {error && <div className="error-banner">{error}</div>}
          
          <div className="form-group">
            <label htmlFor="email">Email Address</label>
            <input 
              id="email"
              type="email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="usera@example.com"
              required 
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input 
              id="password"
              type="password" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your seed password"
              required 
            />
          </div>
          
          <button type="submit" className="btn-primary">Sign In</button>
        </form>
      </div>
    </div>
  );
}

export default App;
