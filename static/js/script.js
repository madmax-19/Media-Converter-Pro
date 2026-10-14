(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const form = $("#convertForm");
  const urlInput = $("#urlInput");
  const formatSelect = $("#formatSelect");
  const qualitySelect = $("#qualitySelect");
  const convertBtn = $("#convertBtn");
  const convertLabel = $("#convertLabel");
  const progressContainer = $("#progressContainer");
  const progressBar = $("#progressBar");
  const progressPercent = $("#progressPercent");
  const statusText = $("#statusText");
  const progressMessage = $("#progressMessage");
  const resultContainer = $("#resultContainer");
  const resultFilename = $("#resultFilename");
  const downloadBtn = $("#downloadBtn");
  const errorContainer = $("#errorContainer");
  let socket = null;
  let activeTaskId = null;

  function setBusy(busy) {
    convertBtn.disabled = busy;
    convertLabel.textContent = busy ? "PROCESSING MEDIA…" : "CONVERT / DOWNLOAD";
  }

  function showError(message) {
    errorContainer.hidden = false;
    errorContainer.textContent = message || "Something went wrong. Please try again.";
    statusText.textContent = "Unable to convert";
    progressMessage.textContent = "You can adjust the URL or options and retry.";
    setBusy(false);
  }

  function applyStatus(state) {
    if (!state) return;
    const progress = Math.max(0, Math.min(100, Number(state.progress) || 0));
    progressBar.style.width = `${progress}%`;
    progressPercent.textContent = `${progress}%`;
    statusText.textContent = ({ queued: "Queued", processing: "Converting media", completed: "Conversion complete", failed: "Conversion failed" })[state.status] || "Preparing…";
    progressMessage.textContent = state.message || "Working…";

    if (state.status === "completed") {
      progressBar.style.width = "100%";
      progressPercent.textContent = "100%";
      resultFilename.textContent = state.filename || "Your file is ready";
      downloadBtn.href = state.download_url || `/download/${activeTaskId}`;
      resultContainer.hidden = false;
      setBusy(false);
      socket?.close();
      socket = null;
    } else if (state.status === "failed") {
      showError(state.error || state.message);
      socket?.close();
      socket = null;
    }
  }

  let pollingTaskId = null;
  async function pollStatus(taskId) {
    // Prevent WebSocket fallback and timeout fallback from launching duplicate poll loops.
    if (pollingTaskId === taskId) return;
    pollingTaskId = taskId;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (!activeTaskId || activeTaskId !== taskId) return;
      try {
        const response = await fetch(`/status/${encodeURIComponent(taskId)}`, { cache: "no-store" });
        const state = await response.json();
        if (!response.ok) throw new Error(state.detail || "Couldn't read task status.");
        applyStatus(state);
        if (["completed", "failed"].includes(state.status)) {
          pollingTaskId = null;
          return;
        }
      } catch (error) {
        // Keep polling briefly if the WebSocket drops, as local development can reconnect.
        if (attempt > 4) {
          showError(error.message);
          pollingTaskId = null;
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    pollingTaskId = null;
    showError("This task took too long. Please try again.");
  }

  function connectProgress(taskId, websocketPath) {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${scheme}//${location.host}${websocketPath || `/ws/${taskId}`}`);
    let gotMessage = false;
    socket.addEventListener("open", () => {
      statusText.textContent = "Connecting…";
      progressMessage.textContent = "Waiting for live progress updates.";
    });
    socket.addEventListener("message", event => {
      gotMessage = true;
      try { applyStatus(JSON.parse(event.data)); }
      catch { /* Ignore malformed progress messages. */ }
    });
    socket.addEventListener("error", () => {
      progressMessage.textContent = "Reconnecting to progress updates…";
    });
    socket.addEventListener("close", () => {
      socket = null;
      if (activeTaskId === taskId && resultContainer.hidden === false) return;
      if (activeTaskId === taskId && !gotMessage) pollStatus(taskId);
      else if (activeTaskId === taskId && !convertBtn.disabled) return;
    });
    // The REST status endpoint is an extra safety net even if the socket opened but stopped updating.
    window.setTimeout(() => {
      if (activeTaskId === taskId && convertBtn.disabled && !["Conversion complete", "Unable to convert"].includes(statusText.textContent)) {
        if (socket && socket.readyState === WebSocket.OPEN) return;
        pollStatus(taskId);
      }
    }, 4000);
  }

  function updateQualityOptions() {
    const isVideo = formatSelect.value === "mp4";
    const current = qualitySelect.value;
    qualitySelect.replaceChildren();
    const options = isVideo
      ? [["best", "Best available"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"], ["360", "360p"]]
      : [["192", "192 kbps · Recommended"], ["128", "128 kbps"], ["256", "256 kbps"], ["320", "320 kbps"]];
    options.forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      qualitySelect.appendChild(option);
    });
    if (options.some(([value]) => value === current)) qualitySelect.value = current;
  }

  formatSelect.addEventListener("change", updateQualityOptions);
  updateQualityOptions();

  $("#pasteBtn").addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.readText) throw new Error("Clipboard access is not available. Paste with Ctrl+V instead.");
      urlInput.value = (await navigator.clipboard.readText()).trim();
      urlInput.focus();
    } catch (error) {
      progressContainer.hidden = false;
      showError(error.message || "Clipboard access was denied. Paste with Ctrl+V instead.");
    }
  });

  convertBtn.addEventListener("pointermove", event => {
    const rect = convertBtn.getBoundingClientRect();
    convertBtn.style.setProperty("--pointer-x", `${((event.clientX - rect.left) / rect.width) * 100}%`);
    convertBtn.style.setProperty("--pointer-y", `${((event.clientY - rect.top) / rect.height) * 100}%`);
  }, { passive: true });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const url = urlInput.value.trim();
    if (!url) { urlInput.focus(); showError("Paste a YouTube or Instagram URL first."); progressContainer.hidden = false; return; }
    if (!/^https?:\/\//i.test(url)) { urlInput.focus(); progressContainer.hidden = false; showError("Include the complete URL starting with https://"); return; }

    socket?.close();
    socket = null;
    activeTaskId = null;
    pollingTaskId = null;
    errorContainer.hidden = true;
    resultContainer.hidden = true;
    progressContainer.hidden = false;
    progressBar.style.width = "0%";
    progressPercent.textContent = "0%";
    statusText.textContent = "Creating task…";
    progressMessage.textContent = "Validating your URL and starting the converter.";
    setBusy(true);

    try {
      const response = await fetch("/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, format: formatSelect.value, quality: qualitySelect.value })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || "The server could not start the conversion.");
      activeTaskId = body.task_id;
      connectProgress(body.task_id, body.websocket_url);
      // Start the REST polling fallback after a delay only if WebSocket isn't usable.
      window.setTimeout(() => {
        if (activeTaskId === body.task_id && socket && socket.readyState !== WebSocket.OPEN && convertBtn.disabled) {
          pollStatus(body.task_id);
        }
      }, 2500);
    } catch (error) {
      showError(error.message || "Couldn't start the conversion. Is the FastAPI server running?");
    }
  });
})();
