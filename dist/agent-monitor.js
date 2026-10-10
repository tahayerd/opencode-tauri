/**
 * OpenCode Desktop - Subagent & Background Process Monitor
 *
 * Real-time monitoring of subagents (Pantheon, explorer, planner, etc.)
 * and background session runs via OpenCode Server IPC / Loopback.
 */
(function () {
  'use strict';

  let monitorPanelEl = null;
  let monitorRailBtn = null;
  let pollInterval = null;

  function injectMonitorStyles() {
    if (document.getElementById('oc-subagent-monitor-styles')) return;
    const style = document.createElement('style');
    style.id = 'oc-subagent-monitor-styles';
    style.textContent = `
      .oc-monitor-backdrop {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
      }
      .oc-monitor-modal {
        width: 880px; max-width: 92vw; height: 80vh;
        background: var(--v2-background-bg-base, #18181b);
        border: 0.5px solid var(--v2-border-border-muted, rgba(255,255,255,0.1));
        border-radius: 12px; display: flex; flex-direction: column; overflow: hidden;
        position: relative; box-shadow: 0 20px 40px rgba(0,0,0,0.5);
      }
      .oc-status-pill {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500;
      }
      .oc-status-running { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 0.5px solid rgba(34, 197, 94, 0.3); }
      .oc-status-idle { background: rgba(148, 163, 184, 0.15); color: #94a3b8; border: 0.5px solid rgba(148, 163, 184, 0.3); }
      .oc-status-error { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 0.5px solid rgba(239, 68, 68, 0.3); }
    `;
    document.head.appendChild(style);
  }

  async function fetchActiveSessions() {
    try {
      const creds = await window.__TAURI__?.core?.invoke('get_server_credentials') || {};
      const url = `${creds.url || 'http://127.0.0.1:4096'}/session`;
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) return [];
      return await res.json();
    } catch (e) {
      return [];
    }
  }

  async function renderMonitorContent() {
    if (!monitorPanelEl) return warContent;
    const bodyEl = monitorPanelEl.querySelector('#oc-monitor-list');
    if (!bodyEl) return;

    const sessions = await fetchActiveSessions();
    if (!sessions || sessions.length === 0) {
      bodyEl.innerHTML = `
        <div style="text-align: center; padding: 60px 20px; color: var(--v2-text-text-muted, #888);">
          <div style="font-size: 32px; margin-bottom: 12px;">🤖</div>
          <div style="font-size: 14px; font-weight: 500;">No Active Subagents or Background Tasks</div>
          <div style="font-size: 12px; margin-top: 4px; opacity: 0.8;">Subagents spawned by OpenCode will appear here with live runtime status and controls.</div>
        </div>
      `;
      return;
    }

    bodyEl.innerHTML = sessions.map(s => `
      <div style="padding: 14px 16px; border-radius: 8px; border: 0.5px solid var(--v2-border-border-muted, rgba(255,255,255,0.08)); background: var(--v2-background-bg-layer-01, rgba(255,255,255,0.02)); margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between;">
        <div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-weight: 600; font-size: 13.5px; color: var(--v2-text-text-base, #eee);">${s.title || s.id || 'Task Session'}</span>
            <span class="oc-status-pill oc-status-${s.status === 'busy' ? 'running' : 'idle'}">${s.status || 'active'}</span>
          </div>
          <div style="font-size: 11.5px; color: var(--v2-text-text-muted, #777); margin-top: 4px; font-family: monospace;">ID: ${s.id}</div>
        </div>
        <div>
          <button type="button" data-component="button-v2" data-variant="outline" style="padding: 4px 10px; font-size: 11.5px; border-radius: 5px; cursor: pointer; color: #ef4444; border: 0.5px solid rgba(239,68,68,0.3); background: transparent;" onclick="window.__ocAbortSession('${s.id}')">Abort</button>
        </div>
      </div>
    `).join('');
  }

  window.__ocAbortSession = async function (sessionId) {
    try {
      const creds = await window.__TAURI__?.core?.invoke('get_server_credentials') || {};
      await fetch(`${creds.url || 'http://127.0.0.1:4096'}/session/${sessionId}/abort`, { method: 'POST' });
      renderMonitorContent();
    } catch (e) {
      console.error('[subagent-monitor] abort failed:', e);
    }
  };

  function openMonitorModal() {
    injectMonitorStyles();
    if (!monitorPanelEl) {
      monitorPanelEl = document.createElement('div');
      monitorPanelEl.className = 'oc-monitor-backdrop';
      monitorPanelEl.innerHTML = `
        <div class="oc-monitor-modal">
          <div style="padding: 24px 28px 16px; border-bottom: 0.5px solid var(--v2-border-border-muted, rgba(255,255,255,0.08)); display: flex; justify-content: space-between; align-items: center;">
            <div>
              <h2 style="font-size: 16px; font-weight: 600; color: var(--v2-text-text-base, #eee); margin: 0;">Agent & Background Monitor</h2>
              <p style="font-size: 12.5px; color: var(--v2-text-text-muted, #888); margin: 4px 0 0;">Live tracking of running background tasks, subagents, and sessions.</p>
            </div>
            <button id="oc-monitor-close" style="background: transparent; border: none; font-size: 18px; color: var(--v2-text-text-muted, #999); cursor: pointer;">✕</button>
          </div>
          <div id="oc-monitor-list" style="padding: 20px 28px; flex: 1; overflow-y: auto;"></div>
        </div>
      `;
      document.body.appendChild(monitorPanelEl);
      monitorPanelEl.querySelector('#oc-monitor-close').onclick = () => {
        monitorPanelEl.style.display = 'none';
        if (pollInterval) clearInterval(pollInterval);
      };
    }
    monitorPanelEl.style.display = 'flex';
    renderMonitorContent();
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(renderMonitorContent, 3000);
  }

  function attachMonitorRail() {
    const buttons = document.querySelectorAll('button');
    let settingsBtn = null;
    for (const btn of buttons) {
      if (btn.querySelector('svg [d*="M7.62516 4.46094"]') || btn.textContent.includes('Settings')) {
        settingsBtn = btn;
        break;
      }
    }
    if (!settingsBtn) return;
    const navContainer = settingsBtn.parentElement;
    if (!navContainer || navContainer.querySelector('.oc-rail-monitor-btn')) return;

    monitorRailBtn = document.createElement('button');
    monitorRailBtn.type = 'button';
    monitorRailBtn.className = 'oc-rail-monitor-btn ' + (settingsBtn.className || '');
    monitorRailBtn.title = 'Subagent & Task Monitor';
    monitorRailBtn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
        <path d="M12 2a10 10 0 1 0 10 10H12V2z"/>
        <path d="M12 12 2.1 10.4"/>
        <path d="M12 12l4.5 8.9"/>
      </svg>
      <span class="truncate">Agents</span>
    `;
    monitorRailBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMonitorModal();
    };
    navContainer.insertBefore(monitorRailBtn, settingsBtn);
  }

  const obs = new MutationObserver(() => attachMonitorRail());
  obs.observe(document.body, { childList: true, subtree: true });
  attachMonitorRail();
  console.info('[agent-monitor] ready');
})();
