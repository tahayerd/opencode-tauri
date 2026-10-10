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
      monitorPanelEl.onclick = (e) => {
        if (e.target === monitorPanelEl) {
          monitorPanelEl.style.display = 'none';
          if (pollInterval) clearInterval(pollInterval);
        }
      };
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && monitorPanelEl && monitorPanelEl.style.display !== 'none') {
          monitorPanelEl.style.display = 'none';
          if (pollInterval) clearInterval(pollInterval);
        }
      });
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

  function findSettingsButton() {
    const byIcon = document.querySelector('button[data-icon="settings-gear"]');
    if (byIcon) return byIcon;

    const rail = document.querySelector('[data-component="sidebar-rail"]');
    if (rail) {
      const byAria = rail.querySelector('button[aria-label*="Setting" i], button[aria-label*="Ayar" i]');
      if (byAria) return byAria;

      for (const btn of rail.querySelectorAll('button')) {
        const aria = btn.getAttribute('aria-label') || '';
        const iconAttr = btn.getAttribute('data-icon') || '';
        if (
          iconAttr === 'settings-gear' ||
          /setting|ayar/i.test(aria) ||
          btn.querySelector('svg [d*="M7.62516"]') ||
          btn.querySelector('svg [d*="M7.99998"]')
        ) {
          return btn;
        }
      }
    }

    for (const btn of document.querySelectorAll('button')) {
      const aria = btn.getAttribute('aria-label') || '';
      const iconAttr = btn.getAttribute('data-icon') || '';
      if (
        iconAttr === 'settings-gear' ||
        /setting|ayar/i.test(aria) ||
        btn.querySelector('svg [d*="M7.62516"]') ||
        btn.querySelector('svg [d*="M7.99998"]')
      ) {
        return btn;
      }
    }
    return null;
  }

  function attachMonitorRail() {
    const settingsBtn = findSettingsButton();
    if (!settingsBtn) return;

    const targetItem = settingsBtn.closest('[data-component="tooltip-trigger"]') || settingsBtn;
    const navContainer = targetItem.parentElement;
    if (!navContainer || navContainer.querySelector('.oc-rail-monitor-wrapper')) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'oc-rail-monitor-wrapper';
    wrapper.setAttribute('data-component', 'tooltip-trigger');

    monitorRailBtn = document.createElement('button');
    monitorRailBtn.type = 'button';
    monitorRailBtn.className = 'oc-rail-monitor-btn';
    monitorRailBtn.setAttribute('data-component', 'icon-button');
    monitorRailBtn.setAttribute('data-variant', 'ghost');
    monitorRailBtn.setAttribute('data-size', 'large');
    monitorRailBtn.title = 'Subagent & Task Monitor';
    monitorRailBtn.setAttribute('aria-label', 'Subagent & Task Monitor');
    monitorRailBtn.style.cssText = `
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 6px;
      background: transparent;
      border: none;
      color: var(--icon-base, #999);
      cursor: pointer;
      transition: background-color 0.15s, color 0.15s;
    `;
    monitorRailBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
        <path d="M12 2a10 10 0 1 0 10 10H12V2z"/>
        <path d="M12 12 2.1 10.4"/>
        <path d="M12 12l4.5 8.9"/>
      </svg>
    `;

    monitorRailBtn.onmouseenter = () => {
      monitorRailBtn.style.backgroundColor = 'var(--surface-base-hover, rgba(255, 255, 255, 0.08))';
      monitorRailBtn.style.color = 'var(--icon-strong-base, #fff)';
    };
    monitorRailBtn.onmouseleave = () => {
      monitorRailBtn.style.backgroundColor = 'transparent';
      monitorRailBtn.style.color = 'var(--icon-base, #999)';
    };
    monitorRailBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMonitorModal();
    };

    wrapper.appendChild(monitorRailBtn);
    navContainer.insertBefore(wrapper, targetItem);
  }

  function attachToHomeUtilityNav() {
    const buttons = document.querySelectorAll('button');
    let homeSettingsBtn = null;
    for (const btn of buttons) {
      const text = btn.textContent.trim();
      const isSettingsText = text === 'Ayarlar' || text === 'Settings' || /^(Ayarlar|Settings)$/i.test(text);
      if (isSettingsText) {
        const parent = btn.parentElement;
        if (parent) {
          const siblingTexts = Array.from(parent.querySelectorAll('button')).map(b => b.textContent.trim());
          if (siblingTexts.some(t => /Yardım|Help/i.test(t))) {
            homeSettingsBtn = btn;
            break;
          }
        }
      }
    }

    if (!homeSettingsBtn) return;
    const navContainer = homeSettingsBtn.parentElement;
    if (!navContainer || navContainer.querySelector('.oc-home-monitor-btn')) return;

    const monitorBtn = document.createElement('button');
    monitorBtn.type = 'button';
    monitorBtn.className =
      'oc-home-monitor-btn flex h-7 min-w-0 w-full shrink-0 cursor-pointer items-center gap-2 rounded-[6px] bg-transparent px-1.5 text-left text-v2-text-text-faint [font-weight:440] transition-[background-color,color] duration-[120ms] ease-in-out hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base';
    monitorBtn.innerHTML = `
      <svg data-slot="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; color: var(--v2-icon-icon-muted, #999);">
        <path d="M12 2a10 10 0 1 0 10 10H12V2z"/>
        <path d="M12 12 2.1 10.4"/>
        <path d="M12 12l4.5 8.9"/>
      </svg>
      <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px]">Agent Monitor</span>
    `;
    monitorBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMonitorModal();
    };

    navContainer.insertBefore(monitorBtn, homeSettingsBtn);
  }

  const obs = new MutationObserver(() => {
    attachToHomeUtilityNav();
    attachMonitorRail();
  });
  obs.observe(document.body, { childList: true, subtree: true });
  attachToHomeUtilityNav();
  attachMonitorRail();
  console.info('[agent-monitor] ready');
})();
