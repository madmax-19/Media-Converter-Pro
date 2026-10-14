
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
  let pollingTaskId = null;
  let taskGeneration = 0;

  function setBusy(busy) {
    convertBtn.disabled = busy;
    convertLabel.textContent = busy
      ? "PROCESSING MEDIA…"
      : "CONVERT / DOWNLOAD";
  }

  function clearResult() {
    resultContainer.hidden = true;
    resultFilename.textContent = "";
    downloadBtn.removeAttribute("href");
    downloadBtn.removeAttribute("download");
  }

  function showError(message) {
    clearResult();

    errorContainer.hidden = false;
    errorContainer.textContent =
      message || "Something went wrong. Please try again.";

    statusText.textContent = "Unable to convert";
    progressMessage.textContent =
      "You can adjust the URL or options and retry.";

    setBusy(false);
  }

  function applyStatus(state, taskId) {
    if (!state || taskId !== activeTaskId) return;

    const progress = Math.max(
      0,
      Math.min(100, Number(state.progress) || 0)
    );

    progressBar.style.width = `${progress}%`;
    progressPercent.textContent = `${progress}%`;

    const labels = {
      queued: "Queued",
      processing: "Converting media",
      completed: "Conversion complete",
      failed: "Conversion failed"
    };

    statusText.textContent = labels[state.status] || "Preparing…";
    progressMessage.textContent = state.message || "Working…";

    if (state.status === "completed") {
      const downloadUrl =
        state.download_url ||
        `/download/${encodeURIComponent(taskId)}`;

      progressBar.style.width = "100%";
      progressPercent.textContent = "100%";

      resultFilename.textContent =
        state.filename || "Your file is ready";

      downloadBtn.href = downloadUrl;
      resultContainer.hidden = false;
      errorContainer.hidden = true;

      setBusy(false);

      if (socket) {
        socket.close();
        socket = null;
      }

      return;
    }

    if (state.status === "failed") {
      showError(
        state.error ||
        state.message ||
        "The conversion failed. Please try again."
      );

      if (socket) {
        socket.close();
        socket = null;
      }
    }
  }

  async function pollStatus(taskId, generation) {
    if (pollingTaskId === taskId) return;

    pollingTaskId = taskId;

    try {
      for (let attempt = 0; attempt < 600; attempt++) {
        if (
          generation !== taskGeneration ||
          activeTaskId !== taskId
        ) {
          return;
        }

        try {
          const response = await fetch(
            `/status/${encodeURIComponent(taskId)}`,
            { cache: "no-store" }
          );

          const state = await response.json();

          if (!response.ok) {
            throw new Error(
              state.detail || "Couldn't read task status."
            );
          }

          applyStatus(state, taskId);

          if (
            state.status === "completed" ||
            state.status === "failed"
          ) {
            return;
          }
        } catch (error) {
          if (attempt >= 4) {
            showError(error.message);
            return;
          }
        }

        await new Promise(resolve =>
          setTimeout(resolve, 1500)
        );
      }

      if (
        generation === taskGeneration &&
        activeTaskId === taskId
      ) {
        showError("This task took too long. Please try again.");
      }
    } finally {
      if (pollingTaskId === taskId) {
        pollingTaskId = null;
      }
    }
  }

  function connectProgress(taskId, websocketPath, generation) {
    const scheme =
      location.protocol === "https:" ? "wss:" : "ws:";

    const path =
      websocketPath || `/ws/${encodeURIComponent(taskId)}`;

    try {
      socket = new WebSocket(
        `${scheme}//${location.host}${path}`
      );
    } catch {
      pollStatus(taskId, generation);
      return;
    }

    socket.addEventListener("message", event => {
      if (
        generation !== taskGeneration ||
        activeTaskId !== taskId
      ) {
        return;
      }

      try {
        applyStatus(JSON.parse(event.data), taskId);
      } catch {
        // Ignore malformed messages.
      }
    });

    socket.addEventListener("close", () => {
      if (generation !== taskGeneration) return;
      if (activeTaskId !== taskId) return;

      if (
        statusText.textContent !== "Conversion complete" &&
        statusText.textContent !== "Unable to convert"
      ) {
        pollStatus(taskId, generation);
      }

      socket = null;
    });

    socket.addEventListener("error", () => {
      if (generation === taskGeneration) {
        progressMessage.textContent =
          "Checking conversion status…";
      }
    });

    window.setTimeout(() => {
      if (
        generation !== taskGeneration ||
        activeTaskId !== taskId
      ) {
        return;
      }

      if (
        statusText.textContent !== "Conversion complete" &&
        statusText.textContent !== "Unable to convert"
      ) {
        pollStatus(taskId, generation);
      }
    }, 4000);
  }

  function updateQualityOptions() {
    const isVideo = formatSelect.value === "mp4";
    const current = qualitySelect.value;

    qualitySelect.replaceChildren();

    const options = isVideo
      ? [
          ["best", "Best available"],
          ["1080", "1080p"],
          ["720", "720p"],
          ["480", "480p"],
          ["360", "360p"]
        ]
      : [
          ["192", "192 kbps · Recommended"],
          ["128", "128 kbps"],
          ["256", "256 kbps"],
          ["320", "320 kbps"]
        ];

    options.forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      qualitySelect.appendChild(option);
    });

    qualitySelect.value = options.some(
      ([value]) => value === current
    ) ? current : options[0][0];
  }

  formatSelect.addEventListener("change", updateQualityOptions);
  updateQualityOptions();

  $("#pasteBtn").addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.readText) {
        throw new Error(
          "Clipboard unavailable. Paste using Ctrl+V instead."
        );
      }

      urlInput.value = (
        await navigator.clipboard.readText()
      ).trim();

      urlInput.focus();
    } catch (error) {
      progressContainer.hidden = false;
      showError(error.message);
    }
  });

  convertBtn.addEventListener("pointermove", event => {
    const rect = convertBtn.getBoundingClientRect();

    convertBtn.style.setProperty(
      "--pointer-x",
      `${((event.clientX - rect.left) / rect.width) * 100}%`
    );

    convertBtn.style.setProperty(
      "--pointer-y",
      `${((event.clientY - rect.top) / rect.height) * 100}%`
    );
  }, { passive: true });

  form.addEventListener("submit", async event => {
    event.preventDefault();

    const url = urlInput.value.trim();

    if (!url) {
      progressContainer.hidden = false;
      showError("Paste a YouTube or Instagram URL first.");
      urlInput.focus();
      return;
    }

    if (!/^https?:\/\//i.test(url)) {
      progressContainer.hidden = false;
      showError("Enter a complete URL starting with https://");
      urlInput.focus();
      return;
    }

    taskGeneration++;
    const generation = taskGeneration;

    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }

    activeTaskId = null;
    pollingTaskId = null;

    clearResult();
    errorContainer.hidden = true;
    progressContainer.hidden = false;

    progressBar.style.width = "0%";
    progressPercent.textContent = "0%";
    statusText.textContent = "Creating task…";
    progressMessage.textContent =
      "Validating URL and starting conversion.";

    setBusy(true);

    try {
      const response = await fetch("/convert", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url,
          format: formatSelect.value,
          quality: qualitySelect.value
        })
      });

      const body = await response.json();

      if (!response.ok) {
        throw new Error(
          body.detail || "The server could not start conversion."
        );
      }

      if (!body.task_id) {
        throw new Error("The server did not return a task ID.");
      }

      activeTaskId = body.task_id;

      connectProgress(
        body.task_id,
        body.websocket_url,
        generation
      );

      window.setTimeout(() => {
        if (
          generation === taskGeneration &&
          activeTaskId === body.task_id &&
          statusText.textContent !== "Conversion complete" &&
          statusText.textContent !== "Unable to convert"
        ) {
          pollStatus(body.task_id, generation);
        }
      }, 4000);
    } catch (error) {
      if (generation === taskGeneration) {
        showError(
          error.message ||
          "Couldn't start conversion. Check the server."
        );
      }
    }
  });
})();
