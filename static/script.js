// Run AFTER DOM is ready even if defer accidentally removed
(function attachWhenReady() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

function boot() {
  console.log('JD app booted');

  // ---- DOM references ----
  const outputBox = document.getElementById("outputBox");
  const outputSubtitle = document.getElementById("outputSubtitle");
  const machineInput = document.getElementById("machineId");
  const locationInput = document.getElementById("location");
  const machineErr = document.getElementById("machineErr");
  const locationErr = document.getElementById("locationErr");
  const machineBtn = document.getElementById("machineSearchBtn");
  const locationBtn = document.getElementById("locationSearchBtn");
  const clearBtn = document.getElementById("clearOutputBtn");
  const downloadBtn = document.getElementById("downloadCsvBtn");
  const limitSelect = document.getElementById("limitSelect");
  const toastContainer = document.getElementById("toastContainer");
  const matchedPill = document.getElementById("matchedPill");
  const returnedPill = document.getElementById("returnedPill");
  const statusText = document.getElementById("statusText");
  const copyJsonBtn = document.getElementById("copyJsonBtn");

  // Guard: if critical elements are missing, stop and show why
  const critical = [outputBox, machineBtn, locationBtn, limitSelect];
  if (critical.some(el => !el)) {
    console.error('DOM not ready or IDs changed', { outputBox, machineBtn, locationBtn, limitSelect });
    alert('Internal error: UI elements not found. Please refresh.');
    return;
  }

  // Track last search for export
  let lastSearch = null;
  let lastResult = null;

  // ---------- AU pre-warm via hidden iframe ----------
  let prewarmed = false;
  function prewarmViaIframe() {
    return new Promise((resolve) => {
      if (prewarmed) return resolve();
      const i = document.createElement('iframe');
      i.style.display = 'none';
      i.src = '/health'; // fast JSON endpoint on your server
      i.onload = () => { prewarmed = true; i.remove(); resolve(); };
      i.onerror = () => { prewarmed = true; i.remove(); resolve(); };
      document.body.appendChild(i);
    });
  }
  // prewarm once per load
  prewarmViaIframe().catch(()=>{});

  function escapeHtml(v) {
    return String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function toast(type, msg) {
    const t = document.createElement("div");
    t.className = `toast ${type}`;
    t.textContent = msg;
    toastContainer.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  function showHint() {
    lastResult = null;
    lastSearch = null;
    downloadBtn.disabled = true;
    copyJsonBtn.disabled = true;
    outputBox.innerHTML = `
<div class="hint">
  Results will appear here.<br/>
  This UI calls your backend and renders JSON.
</div>`;
    matchedPill.textContent = "Matched: 0";
    returnedPill.textContent = "Returned: 0";
    statusText.textContent = "Ready.";
  }

  function showError(message) {
    outputBox.innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
    statusText.textContent = "Error!";
    toast("error", message);
  }

  function showLoading(msg) {
    outputBox.innerHTML = `<div class="loading">
      <div class="spinner"></div> ${escapeHtml(msg)}
    </div>`;
    statusText.textContent = msg;
  }

  // ---------- Hardened fetchJson with retry ----------
  async function fetchJson(url) {
    const abs = `${window.location.origin}${url.startsWith('/') ? url : '/' + url}`;

    const doFetch = () => fetch(abs, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
      redirect: 'follow'
    });

    let res = await doFetch();

    const attempt = async (r) => {
      const ct = r.headers.get('content-type') || '';
      if (!r.ok) {
        let msg = '';
        try {
          if (ct.includes('application/json')) {
            const j = await r.json();
            msg = j.detail || JSON.stringify(j);
          } else {
            msg = await r.text();
          }
        } catch {
          msg = `HTTP ${r.status}`;
        }
        throw new Error(msg || 'Request failed');
      }

      const clone = r.clone();
      const text = await clone.text();
      if (!ct.includes('application/json')) {
        throw new Error(text || 'Non-JSON response received');
      }
      if (!text || text.trim() === '') {
        throw new Error('Empty response from server');
      }
      return JSON.parse(text);
    };

    try {
      return await attempt(res);
    } catch (e) {
      // One controlled retry (lets AU settle the cookie)
      await new Promise(r => setTimeout(r, 250));
      res = await doFetch();
      return await attempt(res);
    }
  }

  function renderTable(data) {
    const cols = data.columns || [];
    const rows = data.rows || [];
    lastResult = data;

    matchedPill.textContent = `Matched: ${data.matched_rows}`;
    returnedPill.textContent = `Returned: ${rows.length}`;
    downloadBtn.disabled = false;
    copyJsonBtn.disabled = false;

    let html = `<div class="result-meta">
      Matched: <b>${escapeHtml(data.matched_rows)}</b> •
      Returned: <b>${escapeHtml(rows.length)}</b>
    </div>`;

    html += `<div class="result-table-wrap"><table class="result-table"><thead><tr>`;
    html += cols.map(c => `<th>${escapeHtml(c)}</th>`).join("");
    html += `</tr></thead><tbody>`;

    for (const r of rows) {
      html += `<tr>`;
      for (const c of cols) {
        html += `<td>${escapeHtml(r[c])}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table></div>`;

    outputBox.innerHTML = html;
    statusText.textContent = "Loaded results.";
  }

  // ---------- Searches (await prewarm) ----------
  async function searchByLocation() {
    await prewarmViaIframe();
    const v = locationInput.value.trim();
    if (!v) { showError("Location required"); return; }
    showLoading("Searching location...");
    try {
      const limit = parseInt(limitSelect.value) || 50;
      const data = await fetchJson(`/api/search/location?q=${encodeURIComponent(v)}&limit=${limit}`);
      lastSearch = { type: "location", value: v };
      renderTable(data);
    } catch (e) {
      showError(e.message);
    }
  }

  async function searchByMachine() {
    await prewarmViaIframe();
    const v = machineInput.value.trim();
    if (!v) { showError("Machine ID required"); return; }
    showLoading("Searching machine...");
    try {
      const limit = parseInt(limitSelect.value) || 50;
      const data = await fetchJson(`/api/search/machine?machine_id=${encodeURIComponent(v)}&limit=${limit}`);
      lastSearch = { type: "machine", value: v };
      renderTable(data);
    } catch (e) {
      showError(e.message);
    }
  }

  // ---------- Download ALL matched ----------
  async function downloadAllMatched() {
    if (!lastSearch) {
      showError("Search first before exporting.");
      return;
    }
    let url = "";
    if (lastSearch.type === "machine") {
      url = `/api/export/machine?machine_id=${encodeURIComponent(lastSearch.value)}`;
    } else {
      url = `/api/export/location?q=${encodeURIComponent(lastSearch.value)}`;
    }

    try {
      toast("success", "Preparing full CSV...");
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) {
        let txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "results.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      showError(e.message);
    }
  }

  async function copyJson() {
    if (!lastResult) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(lastResult.rows, null, 2));
      toast("success", "Copied JSON to clipboard");
    } catch {
      toast("error", "Copy failed");
    }
  }

  // ---- Bind Events ----
  machineBtn.onclick = () => { console.log('Machine search click'); searchByMachine(); };
  locationBtn.onclick = () => { console.log('Location search click'); searchByLocation(); };
  machineInput.onkeydown = e => { if (e.key === "Enter") searchByMachine(); };
  locationInput.onkeydown = e => { if (e.key === "Enter") searchByLocation(); };
  clearBtn.onclick = showHint;
  downloadBtn.onclick = downloadAllMatched;
  copyJsonBtn.onclick = copyJson;

  // Init
  showHint();
}



