chrome.action.onClicked.addListener(() => {
  chrome.storage.local.get(['pentest_window_id'], (r) => {
    if (r.pentest_window_id) {
      chrome.windows.get(r.pentest_window_id, (win) => {
        if (chrome.runtime.lastError || !win) openPanel();
        else chrome.windows.update(r.pentest_window_id, { focused: true });
      });
    } else {
      openPanel();
    }
  });
});

function openPanel() {
  chrome.windows.create({
    url: chrome.runtime.getURL('panel.html'),
    type: 'popup', width: 500, height: 700, focused: true,
  }, (win) => { chrome.storage.local.set({ pentest_window_id: win.id }); });
}

chrome.windows.onRemoved.addListener((wid) => {
  chrome.storage.local.get(['pentest_window_id'], (r) => {
    if (r.pentest_window_id === wid) chrome.storage.local.remove('pentest_window_id');
  });
});


function getRealCookies(url) {
  return new Promise((resolve) => {
    try {
      chrome.cookies.getAll({ url }, (cookies) => {
        const out = {};
        (cookies || []).forEach(c => { out[c.name] = c.value; });
        resolve(out);
      });
    } catch (e) { resolve({}); }
  });
}


function pageInterceptor() {
  if (window.__pentestActive) return;
  window.__pentestActive = true;

  function toAbsolute(u) {
    if (!u) return u;
    if (/^https?:\/\//.test(u)) return u;
    if (u.startsWith('//')) return location.protocol + u;
    if (u.startsWith('/')) return location.origin + u;
    return location.origin + '/' + u;
  }

  function relay(entry) {
    document.dispatchEvent(new CustomEvent('__pc_capture__', { detail: JSON.stringify(entry) }));
  }

  const _origFetch = window.fetch;
  window.fetch = async function (...args) {
    const input = args[0], init = args[1] || {};
    const url    = toAbsolute(typeof input === 'string' ? input : (input?.url || ''));
    const method = (init.method || 'GET').toUpperCase();
    const headers = {};
    try { new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; }); } catch {}
    let body = null;
    if (init.body) { try { body = JSON.parse(init.body); } catch { body = String(init.body); } }

    const resp = await _origFetch.apply(this, args);
    let preview = '';
    try { preview = await resp.clone().text().then(t => t.slice(0, 600)); } catch {}

    delete headers['cookie']; delete headers['Cookie'];
    relay({ url, method, headers, body, status: resp.status,
            response_preview: preview, timestamp: new Date().toISOString(), referer: location.href });
    return resp;
  };

  const _OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new _OrigXHR();
    let _m = 'GET', _u = '', _h = {};

    xhr.open = function (m, u, ...r) {
      _m = m.toUpperCase(); _u = toAbsolute(u);
      return _OrigXHR.prototype.open.apply(xhr, [m, u, ...r]);
    };
    xhr.setRequestHeader = function (k, v) {
      _h[k] = v; return _OrigXHR.prototype.setRequestHeader.apply(xhr, [k, v]);
    };
    xhr.send = function (data) {
      xhr.addEventListener('loadend', () => {
        let b = data;
        if (typeof b === 'string') { try { b = JSON.parse(b); } catch {} }
        const hdrs = { ..._h }; delete hdrs['cookie']; delete hdrs['Cookie'];
        relay({ url: _u, method: _m, headers: hdrs, body: b, status: xhr.status,
                response_preview: (xhr.responseText || '').slice(0, 600),
                timestamp: new Date().toISOString(), referer: location.href });
      });
      return _OrigXHR.prototype.send.apply(xhr, [data]);
    };
    return xhr;
  };
  window.XMLHttpRequest.prototype = _OrigXHR.prototype;
}

function bridgeScript() {
  if (window.__pentestBridge) return;
  window.__pentestBridge = true;
  document.addEventListener('__pc_capture__', (e) => {
    try { chrome.runtime.sendMessage({ type: 'CAPTURE', data: JSON.parse(e.detail) }); } catch {}
  });
}

function injectIntoTab(tabId) {
  chrome.scripting.executeScript({ target: { tabId }, func: pageInterceptor, world: 'MAIN' }).catch(() => {});
  chrome.scripting.executeScript({ target: { tabId }, func: bridgeScript,     world: 'ISOLATED' }).catch(() => {});
}

chrome.webNavigation.onCompleted.addListener((d) => {
  if (d.frameId !== 0) return;
  chrome.storage.local.get(['pentest_capturing'], (r) => { if (r.pentest_capturing) injectIntoTab(d.tabId); });
});

chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId !== 0) return;
  chrome.storage.local.get(['pentest_capturing'], (r) => { if (r.pentest_capturing) injectIntoTab(d.tabId); });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'CAPTURE') return;
  const entry = msg.data;
  if (!entry?.url) return;
  if (/^(chrome-extension|data|blob):/.test(entry.url)) return;

  getRealCookies(entry.url).then((realCookies) => {
    entry.cookies = realCookies; 

    chrome.storage.local.get(['pentest_requests'], (r) => {
      const list = r.pentest_requests || [];
      const last = list[list.length - 1];
      if (last && last.url === entry.url && last.method === entry.method &&
          Math.abs(new Date(entry.timestamp) - new Date(last.timestamp)) < 400) return;
      list.push(entry);
      chrome.storage.local.set({ pentest_requests: list.slice(-500) });
    });
  });
});
