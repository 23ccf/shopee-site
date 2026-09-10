// 前端鉴权层：在 app.js 加载前先执行。
// 行为：检查 source.json.require_auth；如开启且未登录，则用全屏登录页覆盖主界面，
// 登录/注册成功后再把主界面显示出来。token 存 localStorage。
//
// 不依赖任何框架，纯 DOM + fetch。

(function () {
  'use strict';

  const LS_KEY = 'shopee_auth_v1';
  const SOURCE_URL = 'data/source.json';
  const TOKEN_KEY = 'shopee_auth_token';
  const USER_KEY = 'shopee_auth_user';

  const state = {
    backendUrl: null,
    requireAuth: false,
    token: null,
    user: null,
  };

  function readConfig(d) {
    state.backendUrl = (d && d.backend_url) || 'http://127.0.0.1:3000';
    state.requireAuth = !!(d && d.require_auth);
  }

  function loadStored() {
    try {
      const t = localStorage.getItem(TOKEN_KEY);
      const u = localStorage.getItem(USER_KEY);
      if (t) { state.token = t; state.user = u ? JSON.parse(u) : null; }
    } catch (e) {}
  }
  function saveAuth(token, user) {
    state.token = token; state.user = user;
    try { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch (e) {}
  }
  function clearAuth() {
    state.token = null; state.user = null;
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch (e) {}
  }

  // 暴露给 app.js 用的鉴权 API
  window.ShopeeAuth = {
    get state() { return state; },
    getToken() { return state.token; },
    getUser() { return state.user; },
    isLoggedIn() { return !!state.token; },
    logout() { clearAuth(); renderLogin(); },
    // 包装 fetch：自动带 X-Shopee-Token 头。
    // 不用 Authorization: Bearer，因为某些反向代理会改写该 header。
    async authFetch(path, init) {
      init = init || {};
      init.headers = init.headers || {};
      if (state.token) init.headers['x-shopee-token'] = state.token;
      const url = path.startsWith('http') ? path : (state.backendUrl + path);
      const r = await fetch(url, init);
      if (r.status === 401) {
        // token 失效
        clearAuth();
        renderLogin('登录已过期，请重新登录');
        throw new Error('未登录');
      }
      return r;
    },
    async apiPost(path, body) {
      const r = await this.authFetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      return (await r.json());
    },
    async apiDelete(path, body) {
      const r = await this.authFetch(path, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      return (await r.json());
    },
    async apiGet(path) {
      const r = await this.authFetch(path);
      return (await r.json());
    },
  };

  // ===== 登录页 UI =====
  function renderLogin(msg) {
    // 隐藏主界面
    const main = document.getElementById('appRoot') || document.querySelector('main') || document.body.children[0];
    if (main) main.style.display = 'none';
    let overlay = document.getElementById('authOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'authOverlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:#f5f5f4;z-index:9999;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;';
      overlay.innerHTML = `
        <div style="background:#fff;border-radius:16px;padding:32px;width:360px;box-shadow:0 10px 40px rgba(0,0,0,0.08);">
          <h1 style="margin:0 0 4px;font-size:22px;color:#222;font-weight:500;">虾皮选品</h1>
          <p style="margin:0 0 20px;font-size:13px;color:#888;" id="authSubtitle">登录你的账号以查看选品库</p>
          <div id="authMsg" style="display:none;background:#fff1f0;color:#a32d2d;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:12px;"></div>
          <label style="display:block;font-size:12px;color:#666;margin-bottom:6px;">用户名</label>
          <input id="authUsername" type="text" autocomplete="username" style="width:100%;padding:10px 12px;border:1px solid #d3d1c7;border-radius:8px;font-size:14px;margin-bottom:14px;box-sizing:border-box;outline:none;"/>
          <label style="display:block;font-size:12px;color:#666;margin-bottom:6px;">密码</label>
          <input id="authPassword" type="password" autocomplete="current-password" style="width:100%;padding:10px 12px;border:1px solid #d3d1c7;border-radius:8px;font-size:14px;margin-bottom:18px;box-sizing:border-box;outline:none;"/>
          <button id="authSubmit" style="width:100%;padding:12px;background:#0F6E56;color:#fff;border:0;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;">登录</button>
          <div style="text-align:center;margin-top:14px;font-size:12px;color:#888;">
            <a href="#" id="authToggle" style="color:#0F6E56;text-decoration:none;">还没有账号？去注册</a>
          </div>
          <div style="margin-top:18px;padding-top:14px;border-top:1px solid #f0eee8;font-size:11px;color:#aaa;text-align:center;">
            数据存储于你自己的后端；后端地址：<span id="authBackend" style="font-family:monospace;color:#666;"></span>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const inp1 = overlay.querySelector('#authUsername');
      const inp2 = overlay.querySelector('#authPassword');
      const btn = overlay.querySelector('#authSubmit');
      const toggle = overlay.querySelector('#authToggle');
      const subtitle = overlay.querySelector('#authSubtitle');
      const msgEl = overlay.querySelector('#authMsg');
      let mode = 'login';

      function showError(m) { msgEl.textContent = m; msgEl.style.display = 'block'; }
      function clearError() { msgEl.style.display = 'none'; msgEl.textContent = ''; }

      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        mode = (mode === 'login') ? 'register' : 'login';
        if (mode === 'register') { subtitle.textContent = '注册账号以开始使用选品库'; btn.textContent = '注册'; toggle.textContent = '已有账号？去登录'; }
        else { subtitle.textContent = '登录你的账号以查看选品库'; btn.textContent = '登录'; toggle.textContent = '还没有账号？去注册'; }
        clearError();
      });

      async function submit() {
        const username = inp1.value.trim();
        const password = inp2.value;
        if (!username || !password) { showError('请填写用户名和密码'); return; }
        btn.disabled = true; btn.textContent = mode === 'login' ? '登录中…' : '注册中…';
        try {
          const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
          const r = await window.ShopeeAuth.apiPost(path, { username, password });
          if (!r.ok) { showError(r.error || '操作失败'); btn.disabled = false; btn.textContent = mode === 'login' ? '登录' : '注册'; return; }
          saveAuth(r.token, r.user);
          overlay.remove();
          if (main) main.style.display = '';
          // 触发一个全局事件，app.js 监听后开始初始化数据
          window.dispatchEvent(new Event('shopee-auth-ready'));
        } catch (e) { showError('网络错误：' + e.message); btn.disabled = false; btn.textContent = mode === 'login' ? '登录' : '注册'; }
      }
      btn.addEventListener('click', submit);
      inp2.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      inp1.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp2.focus(); });
    }
    overlay.querySelector('#authBackend').textContent = state.backendUrl;
    if (msg) {
      const m = overlay.querySelector('#authMsg'); m.textContent = msg; m.style.display = 'block';
    }
  }

  // ===== 启动：决定是否拦截 =====
  async function boot() {
    loadStored();
    try {
      const r = await fetch(SOURCE_URL, { cache: 'no-cache' });
      if (r.ok) readConfig(await r.json());
    } catch (e) {}

    if (state.requireAuth && !state.token) {
      // 等 DOM ready 再渲染覆盖层
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => renderLogin());
      } else {
        renderLogin();
      }
      return;
    }
    // 已登录或不要求登录：通知 app.js
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => window.dispatchEvent(new Event('shopee-auth-ready')));
    } else {
      window.dispatchEvent(new Event('shopee-auth-ready'));
    }
  }
  boot();
})();
