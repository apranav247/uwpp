import { fetchAuthSession, signOut } from 'aws-amplify/auth';

const API_URL = import.meta.env.VITE_API_URL;

async function api(path, options = {}) {
  let session;
  try {
    session = await fetchAuthSession();
  } catch (e) {
    throw new Error('No valid session');
  }

  const idToken = session.tokens?.idToken?.toString();
  if (!idToken) throw new Error('No ID token found');

  const headers = {
    'Authorization': `Bearer ${idToken}`,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const url = `${API_URL}${path}`;
  let response;
  
  try {
    response = await fetch(url, { ...options, headers });
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }

  if (response.status === 401) {
    await signOut();
    throw new Error('Session expired, please sign in again');
  }

  let body;
  try {
    body = await response.json();
  } catch (e) {
    throw new Error(`HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(body?.error || `HTTP ${response.status}`);
  }

  return body;
}

export const listProjects = () => api('/projects');
export const createProject = (data) => api('/projects', { method: 'POST', body: JSON.stringify(data) });
export const listTasks = (projectId) => api(`/tasks?projectId=${projectId}`);
export const createTask = (data) => api('/tasks', { method: 'POST', body: JSON.stringify(data) });
export const updateTask = (taskId, data) => api(`/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(data) });
export const listUsers = () => api('/users');
export const listNotifications = () => api('/notifications');
export const getMetrics = () => api('/metrics');
