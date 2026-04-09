(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const els = {
    form: $("#registry-form"),
    urlInput: $("#registry-url"),
    refInput: $("#registry-ref"),
    loadBtn: $("#load-btn"),
    urlError: $("#url-error"),
    content: $("#content"),
    portList: $("#port-list"),
    portSearch: $("#port-search"),
    portCount: $("#port-count"),
    detailPlaceholder: $("#detail-placeholder"),
    portDetail: $("#port-detail"),
    detailName: $("#detail-name"),
    detailVersion: $("#detail-version"),
    detailDescription: $("#detail-description"),
    versionList: $("#version-list"),
    fileList: $("#file-list"),
    fileViewer: $("#file-viewer"),
    fileViewerName: $("#file-viewer-name"),
    fileViewerClose: $("#file-viewer-close"),
    fileViewerContent: $("#file-viewer-content"),
    loadingOverlay: $("#loading-overlay"),
  };

  let state = {
    registryUrl: "",
    ref: "",
    ports: [],
    baseline: {},
    activePort: null,
  };

  function showLoading(show) {
    els.loadingOverlay.classList.toggle("hidden", !show);
  }

  function showError(msg) {
    els.urlError.textContent = msg;
    els.urlError.classList.toggle("hidden", !msg);
  }

  async function api(path) {
    const sep = path.includes("?") ? "&" : "?";
    let fullUrl = path + sep + "url=" + encodeURIComponent(state.registryUrl);
    if (state.ref) fullUrl += "&ref=" + encodeURIComponent(state.ref);
    const res = await fetch(fullUrl);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function renderPortList(filter = "") {
    const lc = filter.toLowerCase();
    const filtered = state.ports.filter((p) => p.toLowerCase().includes(lc));
    els.portCount.textContent = filtered.length + " / " + state.ports.length;

    els.portList.innerHTML = filtered
      .map((name) => {
        const ver = state.baseline[name];
        const verStr = ver
          ? ver["baseline"] || ver["version-string"] || ver["version"] || ""
          : "";
        const active = state.activePort === name ? " active" : "";
        return `<li class="${active}" data-port="${escapeHtml(name)}">
          <span>${escapeHtml(name)}</span>
          ${verStr ? `<span class="port-ver">${escapeHtml(verStr)}</span>` : ""}
        </li>`;
      })
      .join("");
  }

  function isLocalPath(source) {
    if (!source) return false;
    if (source.match(/^https?:\/\//)) return false;
    return true;
  }

  async function loadRegistry() {
    const url = els.urlInput.value.trim();
    if (!url) { showError("Please enter a GitHub URL or local path."); return; }

    const local = isLocalPath(url);
    if (!local && !url.match(/github\.com\/[^/]+\/[^/]+/)) {
      showError("Enter a valid GitHub repository URL or a local filesystem path.");
      return;
    }

    showError("");
    showLoading(true);
    state.registryUrl = url;
    state.ref = local ? "" : els.refInput.value.trim();
    state.activePort = null;

    if (local) {
      els.refInput.style.display = "none";
    } else {
      els.refInput.style.display = "";
    }

    try {
      const [portData, baselineData] = await Promise.all([
        api("/api/ports"),
        api("/api/baseline").catch(() => ({})),
      ]);

      state.ports = portData.ports || [];

      const bl = baselineData.default || baselineData;
      state.baseline = bl || {};

      els.content.classList.remove("hidden");
      els.portDetail.classList.add("hidden");
      els.detailPlaceholder.classList.remove("hidden");
      els.fileViewer.classList.add("hidden");

      renderPortList();
    } catch (err) {
      showError(err.message);
    } finally {
      showLoading(false);
    }
  }

  async function selectPort(name) {
    state.activePort = name;
    renderPortList(els.portSearch.value);

    els.detailPlaceholder.classList.add("hidden");
    els.portDetail.classList.remove("hidden");
    els.fileViewer.classList.add("hidden");

    els.detailName.textContent = name;
    els.detailVersion.textContent = "";
    els.detailDescription.textContent = "Loading…";
    els.versionList.innerHTML = "";
    els.fileList.innerHTML = "";

    try {
      const [portData, versionData] = await Promise.all([
        api(`/api/ports/${encodeURIComponent(name)}`),
        api(`/api/versions/${encodeURIComponent(name)}`).catch(() => ({ versions: [] })),
      ]);

      // Try to read vcpkg.json for description
      const vcpkgJsonFile = portData.files.find((f) => f.name === "vcpkg.json");
      let description = "";
      let currentVersion = "";

      if (vcpkgJsonFile) {
        try {
          const fileData = await api(`/api/file?path=${encodeURIComponent(vcpkgJsonFile.path)}`);
          const manifest = JSON.parse(fileData.content);
          description = manifest.description || "";
          if (Array.isArray(description)) description = description.join(" ");
          currentVersion =
            manifest.version || manifest["version-string"] || manifest["version-semver"] || manifest["version-date"] || "";
        } catch {}
      }

      // Baseline version
      const blVer = state.baseline[name];
      if (!currentVersion && blVer) {
        currentVersion =
          blVer["baseline"] || blVer["version-string"] || blVer["version"] || "";
      }

      els.detailVersion.textContent = currentVersion ? "v" + currentVersion : "";
      els.detailDescription.textContent = description || "No description available.";

      // Version history
      const versions = versionData.versions || [];
      if (versions.length > 0) {
        els.versionList.innerHTML = versions
          .map((v, i) => {
            const ver =
              v.version || v["version-string"] || v["version-semver"] || v["version-date"] || "?";
            const port = v["port-version"] != null ? `#${v["port-version"]}` : "";
            return `<span class="version-tag${i === 0 ? " latest" : ""}">${escapeHtml(ver)}${port}</span>`;
          })
          .join("");
      } else {
        els.versionList.innerHTML = '<span class="version-tag">No version history found</span>';
      }

      // Files
      els.fileList.innerHTML = portData.files
        .map(
          (f) =>
            `<li data-path="${escapeHtml(f.path)}">
              <span class="file-icon">${f.type === "dir" ? "📁" : "📄"}</span>
              <span>${escapeHtml(f.name)}</span>
              ${f.size != null ? `<span class="file-size">${formatSize(f.size)}</span>` : ""}
            </li>`
        )
        .join("");
    } catch (err) {
      els.detailDescription.textContent = "Error loading port: " + err.message;
    }
  }

  async function viewFile(filePath) {
    els.fileViewer.classList.remove("hidden");
    els.fileViewerName.textContent = filePath.split("/").pop();
    els.fileViewerContent.textContent = "Loading…";

    try {
      const data = await api(`/api/file?path=${encodeURIComponent(filePath)}`);
      els.fileViewerContent.textContent = data.content;
      els.fileViewer.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (err) {
      els.fileViewerContent.textContent = "Error: " + err.message;
    }
  }

  // Event listeners
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    loadRegistry();
  });

  els.portSearch.addEventListener("input", () => {
    renderPortList(els.portSearch.value);
  });

  els.portList.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-port]");
    if (li) selectPort(li.dataset.port);
  });

  els.fileList.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-path]");
    if (li) viewFile(li.dataset.path);
  });

  els.fileViewerClose.addEventListener("click", () => {
    els.fileViewer.classList.add("hidden");
  });

  // Allow pressing Enter in URL input
  els.urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      loadRegistry();
    }
  });
})();
