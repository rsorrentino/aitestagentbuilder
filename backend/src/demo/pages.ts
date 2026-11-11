/**
 * A tiny demo web application served at /demo, so the platform can be tried
 * end-to-end without an external site. Credentials: demo / demo123.
 */

import { Router } from 'express';

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Demo Shop</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;color:#1e293b}
  label{display:block;margin-top:12px;font-weight:600}input{width:100%;padding:8px;margin-top:4px;box-sizing:border-box}
  button{margin-top:16px;padding:8px 16px;background:#4f46e5;color:#fff;border:0;border-radius:6px;cursor:pointer}
  .error{color:#b91c1c;margin-top:12px}li{padding:4px 0}nav a{margin-right:12px}
</style></head><body>${body}</body></html>`;

export const DEMO_PAGES: Record<string, string> = {
  '/': layout('Home', `
    <h1>Demo Shop</h1>
    <p>A sample application for trying AI Test Agent Builder.</p>
    <nav><a href="./login" id="login-link">Sign in</a></nav>`),

  '/login': layout('Login', `
    <h1>Sign in</h1>
    <form id="login-form">
      <label for="username">Username</label><input id="username" name="username" autocomplete="off">
      <label for="password">Password</label><input id="password" name="password" type="password">
      <button id="login-btn" type="submit">Sign in</button>
      <div id="error" class="error" role="alert"></div>
    </form>
    <script>
      document.getElementById('login-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var u = document.getElementById('username').value, p = document.getElementById('password').value;
        if (u === 'demo' && p === 'demo123') {
          sessionStorage.setItem('user', u);
          location.href = './dashboard';
        } else {
          document.getElementById('error').textContent = 'Invalid username or password';
        }
      });
    </script>`),

  '/dashboard': layout('Dashboard', `
    <nav><a href="./">Home</a><a href="./login" id="logout">Sign out</a></nav>
    <h1 id="welcome">Welcome</h1>
    <h2>Shopping list</h2>
    <input id="new-item" placeholder="Add an item" aria-label="New item">
    <button id="add-item">Add</button>
    <ul id="items"></ul>
    <script>
      var user = sessionStorage.getItem('user');
      if (!user) { location.href = './login'; }
      document.getElementById('welcome').textContent = 'Welcome, ' + user + '!';
      document.getElementById('add-item').addEventListener('click', function () {
        var input = document.getElementById('new-item');
        if (!input.value.trim()) return;
        var li = document.createElement('li'); li.textContent = input.value.trim();
        document.getElementById('items').appendChild(li); input.value = '';
      });
    </script>`),
};

export function demoRouter(): Router {
  const router = Router();
  router.get(['/', '/login', '/dashboard'], (req, res) => {
    res.type('html').send(DEMO_PAGES[req.path] ?? DEMO_PAGES['/']);
  });
  return router;
}
