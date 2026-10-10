import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { Amplify } from 'aws-amplify';

const apiUrl = import.meta.env.VITE_API_URL;
const userPoolId = import.meta.env.VITE_USER_POOL_ID;
const userPoolClientId = import.meta.env.VITE_USER_POOL_CLIENT_ID;

if (!apiUrl || !userPoolId || !userPoolClientId) {
  const errDiv = document.createElement('div');
  errDiv.style.color = 'white';
  errDiv.style.backgroundColor = 'red';
  errDiv.style.padding = '20px';
  errDiv.style.margin = '20px';
  errDiv.style.borderRadius = '5px';
  errDiv.style.fontFamily = 'sans-serif';
  errDiv.textContent = 'Configuration Error: Missing required VITE_ environment variables (API_URL, USER_POOL_ID, USER_POOL_CLIENT_ID).';
  document.body.appendChild(errDiv);
} else {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId
      }
    }
  });

  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
