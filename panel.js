
let all = [], capturing = false, pollTimer = null;

chrome.storage.local.get(['pentest_capturing', 'pentest_requests'], (r) => {
  capturing = r.pentest_capturing || false;
  all = r.pentest_requests || [];
  syncUI(); render(); updateCount();
  if (capturing) startPolling();
});

function refreshHost() {
  chrome.tabs.query({ active: true }, (tabs) => {
    const t = tabs.find(t => t.url && !t.url.startsWith('chrome-extension://'));
    if (t?.url) {
      try { document.getElementById('host-label').textContent = new URL(t.url).hostname; } catch {}
    }
  });
}
refreshHost();
setInterval(refreshHost, 3000);

document.getElementById('btn-capture').addEventListener('click', () => {
  capturing = !capturing;
  chrome.storage.local.set({ pentest_capturing: capturing });
  syncUI();
  if (capturing) {
    startPolling();
    toast('Captura ativa — interaja com o site normalmente!');
  } else {
    stopPolling();
    toast('Captura pausada.');
  }
});

document.getElementById('btn-inject').addEventListener('click', () => {
  if (!capturing) { toast('Ative a captura primeiro!'); return; }
  chrome.tabs.query({ active: true }, (tabs) => {
    const t = tabs.find(tab => tab.url && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('chrome://'));
    if (!t) { toast('Nenhuma aba válida encontrada.'); return; }
    chrome.scripting.executeScript({ target: { tabId: t.id }, func: pageInterceptor, world: 'MAIN' })
      .then(() => chrome.scripting.executeScript({ target: { tabId: t.id }, func: bridgeScript, world: 'ISOLATED' }))
      .then(() => {
        const btn = document.getElementById('btn-inject');
        btn.textContent = '✓ Injetado!'; btn.classList.add('ok');
        setTimeout(() => { btn.textContent = '⚡ Injetar na aba'; btn.classList.remove('ok'); }, 2000);
        toast('Interceptor injetado! Interaja com o site.');
      }).catch(err => toast('Erro: ' + err.message));
  });
});

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

  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const input = args[0], init = args[1] || {};
    const url    = toAbsolute(typeof input === 'string' ? input : (input?.url || ''));
    const method = (init.method || 'GET').toUpperCase();
    const headers = {};
    try { new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; }); } catch {}
    let body = null;
    if (init.body) { try { body = JSON.parse(init.body); } catch { body = String(init.body); } }
    const resp = await _fetch.apply(this, args);
    let preview = '';
    try { preview = await resp.clone().text().then(t => t.slice(0, 600)); } catch {}
    delete headers['cookie']; delete headers['Cookie'];
    relay({ url, method, headers, body, status: resp.status,
            response_preview: preview, timestamp: new Date().toISOString(), referer: location.href });
    return resp;
  };

  const _XHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new _XHR();
    let _m = 'GET', _u = '', _h = {};
    xhr.open = function (m, u, ...r) { _m = m.toUpperCase(); _u = toAbsolute(u); return _XHR.prototype.open.apply(xhr, [m, u, ...r]); };
    xhr.setRequestHeader = function (k, v) { _h[k] = v; return _XHR.prototype.setRequestHeader.apply(xhr, [k, v]); };
    xhr.send = function (data) {
      xhr.addEventListener('loadend', () => {
        let b = data; if (typeof b === 'string') { try { b = JSON.parse(b); } catch {} }
        const hdrs = { ..._h }; delete hdrs['cookie']; delete hdrs['Cookie'];
        relay({ url: _u, method: _m, headers: hdrs, body: b, status: xhr.status,
                response_preview: (xhr.responseText || '').slice(0, 600),
                timestamp: new Date().toISOString(), referer: location.href });
      });
      return _XHR.prototype.send.apply(xhr, [data]);
    };
    return xhr;
  };
  window.XMLHttpRequest.prototype = _XHR.prototype;
}

function bridgeScript() {
  if (window.__pentestBridge) return;
  window.__pentestBridge = true;
  document.addEventListener('__pc_capture__', (e) => {
    try { chrome.runtime.sendMessage({ type: 'CAPTURE', data: JSON.parse(e.detail) }); } catch {}
  });
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    chrome.storage.local.get(['pentest_requests'], (r) => {
      const inc = r.pentest_requests || [];
      if (inc.length !== all.length) { all = inc; render(); updateCount(); }
    });
  }, 800);
}

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function syncUI() {
  const btn = document.getElementById('btn-capture');
  const led = document.getElementById('led');
  const lbl = document.getElementById('status-label');
  if (capturing) {
    btn.textContent = '⏸ Pausar Captura'; btn.classList.add('on');
    led.classList.add('on'); led.classList.remove('off'); lbl.textContent = 'Capturando...';
  } else {
    btn.textContent = '▶ Iniciar Captura'; btn.classList.remove('on');
    led.classList.remove('on'); led.classList.add('off'); lbl.textContent = 'Parado';
  }
}

document.getElementById('filter').addEventListener('input', render);
document.getElementById('method-filter').addEventListener('change', render);

function getFiltered() {
  const q = document.getElementById('filter').value.toLowerCase();
  const m = document.getElementById('method-filter').value;
  return all.filter(r => {
    if (m && r.method !== m) return false;
    return !q || r.url.toLowerCase().includes(q) || r.method.toLowerCase().includes(q) || String(r.status).includes(q);
  });
}

function render() {
  const el = document.getElementById('list');
  const items = getFiltered();
  updateCount();
  if (items.length === 0) {
    el.innerHTML = `<div class="empty"><div class="ico">📡</div><p>
      1. Clique <b>▶ Iniciar Captura</b><br>
      2. Interaja com o site normalmente<br>
      3. Todas as requisições são capturadas<br>
      &nbsp;&nbsp;&nbsp;automaticamente (headers completos)</p></div>`;
    return;
  }
  el.innerHTML = [...items].reverse().map(r => {
    let path = r.url, host = '';
    try { const u = new URL(r.url); path = u.pathname + u.search; host = u.hostname; } catch {}
    const sc = r.status >= 500 ? 's5' : r.status >= 400 ? 's4' : r.status >= 300 ? 's3' : 's2';
    const time = r.timestamp ? new Date(r.timestamp).toLocaleTimeString('pt-BR') : '';
    return `<div class="item">
      <span class="method ${r.method}">${r.method}</span>
      <span class="status ${sc}">${r.status || '?'}</span>
      <div class="item-url">
        <div class="item-path" title="${r.url}">${path}</div>
        <div class="item-host">${host}</div>
      </div>
      <span class="item-time">${time}</span>
    </div>`;
  }).join('');
}

function updateCount() {
  document.getElementById('count').textContent = `${all.length} reqs`;
  document.getElementById('req-count-label').textContent = `${all.length} requisições`;
}

document.getElementById('btn-export').addEventListener('click', () => {
  if (all.length === 0) { toast('Nenhuma requisição ainda!'); return; }
  const code = generatePython(all);
  const blob = new Blob([code], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  let h = 'capture';
  try { h = new URL(all[0].url).hostname.replace(/\./g, '_'); } catch {}
  const d = new Date().toISOString().slice(0, 10);
  chrome.downloads.download({ url, filename: `pentest_${h}_${d}.txt`, saveAs: false });
  toast(`Exportado: pentest_${h}_${d}.txt`);
});

document.getElementById('btn-clear').addEventListener('click', () => {
  chrome.storage.local.set({ pentest_requests: [] }, () => {
    all = []; render(); updateCount(); toast('Limpo!');
  });
});

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
}

function generatePython(requests) {
  let host = '';
  try { host = new URL(requests[requests.length - 1].url).hostname; } catch {}

  const L = [];
  L.push('import requests');
  L.push('');

  requests.forEach((r, i) => {
    let label = r.url;
    try { const u = new URL(r.url); label = u.pathname + u.search; } catch {}
    const fn = 'req_' + String(i + 1).padStart(2, '0') + '_' + r.method.toLowerCase();
    const idx = i + 1;

    L.push('# ' + '─'.repeat(58));
    L.push('# [' + idx + '] ' + r.method + ' ' + label + '  →  HTTP ' + (r.status || '?'));
    L.push('def ' + fn + '():');


    const cookies = r.cookies || {};
    L.push('    cookies = {');
    Object.entries(cookies).forEach(([k, v]) => {
      L.push('        ' + ps(k) + ': ' + ps(v) + ',');
    });
    L.push('    }');

    const skipH = new Set([
      'host', 'content-length', 'connection',
      'cookie', ':authority', ':method', ':path', ':scheme'
    ]);
    const hdrs = {};
    if (r.headers) {
      Object.entries(r.headers).forEach(([k, v]) => {
        const lk = k.toLowerCase();
        if (!skipH.has(lk)) hdrs[lk] = v; 
      });
    }


    const rawCookie = Object.entries(cookies).map(([k, v]) => k + '=' + v).join('; ');

    L.push('    headers = {');
    Object.entries(hdrs).forEach(([k, v]) => {
      L.push('        ' + ps(k) + ': ' + ps(v) + ',');
    });
    if (rawCookie) {
      L.push("        # 'cookie': " + ps(rawCookie) + ',');
    }
    L.push('    }');

    const method = r.method.toLowerCase();
    if (r.body != null && r.body !== '') {
      if (typeof r.body === 'object') {
        const bodyStr = JSON.stringify(r.body, null, 4)
          .split('\n').map((line, li) => li === 0 ? line : '    ' + line).join('\n');
        L.push('    json_body = ' + bodyStr);
        L.push("    response = requests." + method + "('" + r.url + "', cookies=cookies, headers=headers, json=json_body)");
      } else {
        L.push('    data = ' + ps(String(r.body)));
        L.push("    response = requests." + method + "('" + r.url + "', cookies=cookies, headers=headers, data=data)");
      }
    } else {
      L.push("    response = requests." + method + "('" + r.url + "', cookies=cookies, headers=headers)");
    }

    L.push('    print(response.text[:400])');
    if (r.response_preview) {
      L.push('    # Resposta: ' + r.response_preview.slice(0, 200).replace(/\n/g, ' '));
    }
    L.push('    return response');
    L.push('');
    L.push('');
  });

  return L.join('\n');
}

function ps(s) {
  const escaped = String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
  return "'" + escaped + "'";
}
