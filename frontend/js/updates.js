import { api, toast } from "./main.js";

let _bound = false;
let _downloadPollTimer = null;
let _lastCheck = null;
let _toastShownForVersion = null;
let _lastCheckWasManual = false;

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

function fmtDate(value) {
  if (!value) return "";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text || "";
}

function renderIdle(currentVersion = null) {
  if (currentVersion) {
    setText("update-current-version", `v${currentVersion}`);
  }
  setText("update-summary", "Update checks run quietly in the background. Use Check Now anytime.");
  setText("update-meta", "");
  document.getElementById("btn-download-update")?.classList.add("hidden");
  document.getElementById("btn-install-update")?.classList.add("hidden");
  document.getElementById("update-progress")?.classList.add("hidden");
}

function renderCheck(data) {
  _lastCheck = data || null;
  setText("update-current-version", `v${data?.current_version || "unknown"}`);

  const summaryEl = document.getElementById("update-summary");
  const metaEl = document.getElementById("update-meta");
  const downloadBtn = document.getElementById("btn-download-update");
  const installBtn = document.getElementById("btn-install-update");

  if (!summaryEl || !metaEl || !downloadBtn || !installBtn) return;

  const hasError = Boolean(data?.error);
  if (hasError) {
    if (_lastCheckWasManual) {
      summaryEl.textContent = data?.offline
        ? "Could not reach GitHub update checks right now. Other network features may still work."
        : `Could not check for updates: ${data.error}`;
    } else {
      summaryEl.textContent = "Update checks run quietly in the background. Use Check Now anytime.";
    }
    const metaParts = [];
    if (data?.stale && data?.latest_version) metaParts.push(`Last known release ${data.latest_version}`);
    if (_lastCheckWasManual && data?.error && !data?.offline) metaParts.push(data.error);
    if (_lastCheckWasManual && data?.html_url) metaParts.push(data.html_url);
    metaEl.textContent = metaParts.join(" · ");
    downloadBtn.classList.add("hidden");
    installBtn.classList.add("hidden");
    return;
  }

  if (data?.update_available) {
    summaryEl.textContent = data.asset_download_url
      ? `Version ${data.latest_version} is available.`
      : `Version ${data.latest_version} is available, but no downloadable zip asset was found.`;
    const metaParts = [];
    if (data.release_name && data.release_name !== data.latest_version) metaParts.push(data.release_name);
    if (data.published_at) metaParts.push(`Published ${fmtDate(data.published_at)}`);
    if (data.asset_name) metaParts.push(data.asset_name);
    if (data.asset_size) metaParts.push(fmtBytes(data.asset_size));
    metaEl.textContent = metaParts.join(" · ");
    if (data?.stale) {
      metaEl.textContent += `${metaEl.textContent ? " · " : ""}Cached result`;
    }
    downloadBtn.classList.toggle("hidden", Boolean(data.downloaded) || !Boolean(data.asset_download_url));
    installBtn.classList.toggle("hidden", !Boolean(data.downloaded && data.can_install));
  } else {
    summaryEl.textContent = data?.no_releases ? "No published releases yet." : "You’re up to date.";
    const metaParts = [];
    if (data?.latest_version) metaParts.push(`Latest release ${data.latest_version}`);
    if (data?.published_at) metaParts.push(`Published ${fmtDate(data.published_at)}`);
    if (data?.offline) metaParts.push("Offline");
    if (data?.no_releases && data?.html_url) metaParts.push(data.html_url);
    metaEl.textContent = metaParts.join(" · ");
    downloadBtn.classList.add("hidden");
    installBtn.classList.toggle("hidden", !Boolean(data?.downloaded && data?.can_install));
  }
}

function renderDownloadStatus(status) {
  const progressWrap = document.getElementById("update-progress");
  const progressFill = document.getElementById("update-progress-fill");
  const progressText = document.getElementById("update-progress-text");
  const downloadBtn = document.getElementById("btn-download-update");
  const installBtn = document.getElementById("btn-install-update");

  if (!progressWrap || !progressFill || !progressText || !downloadBtn || !installBtn) return;

  if (!status?.in_progress && !status?.done) {
    progressWrap.classList.add("hidden");
    progressFill.style.width = "0%";
    return;
  }

  progressWrap.classList.remove("hidden");
  const pct = Math.max(0, Math.min(100, Math.round((status.progress || 0) * 100)));
  progressFill.style.width = `${pct}%`;

  if (status.in_progress) {
    const doneText = fmtBytes(status.bytes_done);
    const totalText = fmtBytes(status.total_bytes);
    progressText.textContent = totalText ? `${pct}% · ${doneText} of ${totalText}` : `${pct}%`;
    downloadBtn.classList.add("hidden");
    installBtn.classList.add("hidden");
    schedulePoll();
    return;
  }

  if (status.error) {
    progressText.textContent = `Download failed: ${status.error}`;
    downloadBtn.classList.toggle("hidden", !_lastCheck?.update_available);
    installBtn.classList.add("hidden");
    return;
  }

  progressText.textContent = "Update downloaded. Restart the app to install it.";
  downloadBtn.classList.add("hidden");
  installBtn.classList.toggle("hidden", !Boolean(_lastCheck?.can_install));
}

function stopPoll() {
  if (_downloadPollTimer) clearTimeout(_downloadPollTimer);
  _downloadPollTimer = null;
}

function schedulePoll() {
  stopPoll();
  _downloadPollTimer = setTimeout(refreshDownloadStatus, 800);
}

async function refreshDownloadStatus() {
  try {
    const status = await api("/api/updates/download/status");
    renderDownloadStatus(status);
    if (!status.in_progress && status.done && !status.error) {
      const latest = await api("/api/updates/check?force=true");
      renderCheck(latest);
      if (_toastShownForVersion !== `downloaded:${status.version}`) {
        _toastShownForVersion = `downloaded:${status.version}`;
        toast(`Update ${status.version} downloaded. Restart to install.`, "success", 5000);
      }
    }
  } catch (_) {
    schedulePoll();
  }
}

async function refreshUpdateCheck(force = false, auto = false) {
  _lastCheckWasManual = !auto;
  const data = await api(`/api/updates/check?force=${force ? "true" : "false"}`);
  if (auto && data?.error) {
    renderIdle(data?.current_version || null);
    return data;
  }
  renderCheck(data);
  if (auto && data.update_available && _toastShownForVersion !== data.latest_version) {
    _toastShownForVersion = data.latest_version;
    toast(`Update available: ${data.latest_version}`, "info", 5000);
  }
  return data;
}

async function startDownload() {
  const btn = document.getElementById("btn-download-update");
  if (btn) btn.disabled = true;
  try {
    const status = await api("/api/updates/download", { method: "POST" });
    renderDownloadStatus(status);
  } catch (err) {
    toast(err.message, "error", 5000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function installUpdate() {
  const btn = document.getElementById("btn-install-update");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Restarting…";
  }

  try {
    await api("/api/updates/install", { method: "POST" });
  } catch (err) {
    const msg = String(err?.message || "");
    if (!/failed to fetch/i.test(msg)) {
      toast(msg || "Failed to restart into the update.", "error", 6000);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Restart to Update";
      }
      return;
    }
  }
}

export async function initUpdates() {
  renderIdle();

  if (!_bound) {
    document.getElementById("btn-check-updates")?.addEventListener("click", async () => {
      try {
        await refreshUpdateCheck(true, false);
      } catch (err) {
        toast(err.message, "error", 5000);
      }
    });
    document.getElementById("btn-download-update")?.addEventListener("click", startDownload);
    document.getElementById("btn-install-update")?.addEventListener("click", installUpdate);
    _bound = true;
  }

  try {
    await refreshUpdateCheck(false, true);
  } catch (_) {}

  try {
    await refreshDownloadStatus();
  } catch (_) {}
}
