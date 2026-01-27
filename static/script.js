
(function () {
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

  // Track last search for export:
  // { type: "machine", value: "..."} or {type:"location", value:"..."}
  let lastSearch = null;

  let lastResult = null;

  function escapeHtml(v) {
    return String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
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
      </div>
    `;

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
    outputBox.innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        <div>${escapeHtml(msg)}</div>
      </div>
    `;
    statusText.textContent = msg;
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
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
      Matched: <b>${data.matched_rows}</b> |
      Returned: <b>${rows.length}</b>
    </div>`;

    html += `<div class="result-table-wrap"><table class="result-table">`;
    html += `<thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>`;
    html += `<tbody>`;

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

  async function searchByMachine() {
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

  async function searchByLocation() {
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

  // ---- Download ALL matched from backend ----
  function downloadAllMatched() {
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

    window.location.href = url;
    toast("success", "Downloading full CSV...");
  }

  // ---- Copy JSON ----
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
  machineBtn.onclick = searchByMachine;
  locationBtn.onclick = searchByLocation;

  machineInput.onkeydown = e => { if (e.key === "Enter") searchByMachine(); };
  locationInput.onkeydown = e => { if (e.key === "Enter") searchByLocation(); };

  clearBtn.onclick = showHint;
  downloadBtn.onclick = downloadAllMatched;
  copyJsonBtn.onclick = copyJson;

  // Init
  showHint();
})();
