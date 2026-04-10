(() => {
  const $ = (sel) => document.querySelector(sel);

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
    featuresSection: $("#features-section"),
    featuresList: $("#features-list"),
    fileList: $("#file-list"),
    loadingOverlay: $("#loading-overlay"),
    dropZone: $("#drop-zone"),
    sourceGithub: $("#source-github"),
    localBanner: $("#local-banner"),
    localBannerName: $("#local-banner-name"),
    localClose: $("#local-close"),
  };

  let state = {
    registryUrl: "",
    ref: "",
    ports: [],
    baseline: {},
    activePort: null,
    localMode: false,
    localTree: null, // { entries: Map, portNames: string[], folderName: string }
  };

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  function showLoading(show) {
    els.loadingOverlay.classList.toggle("hidden", !show);
  }

  function showError(msg) {
    els.urlError.textContent = msg;
    els.urlError.classList.toggle("hidden", !msg);
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

  // -------------------------------------------------------------------------
  // GitHub API helpers (remote mode)
  // -------------------------------------------------------------------------

  async function api(path) {
    const sep = path.includes("?") ? "&" : "?";
    let fullUrl = path + sep + "url=" + encodeURIComponent(state.registryUrl);
    if (state.ref) fullUrl += "&ref=" + encodeURIComponent(state.ref);
    const res = await fetch(fullUrl);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  // -------------------------------------------------------------------------
  // Local filesystem via drag-and-drop (FileSystem API)
  // -------------------------------------------------------------------------

  function readAllEntries(dirReader) {
    return new Promise((resolve, reject) => {
      const all = [];
      (function readBatch() {
        dirReader.readEntries((entries) => {
          if (entries.length === 0) { resolve(all); return; }
          all.push(...entries);
          readBatch();
        }, reject);
      })();
    });
  }

  async function scanDirectoryTree(rootEntry) {
    const entries = new Map();

    async function walk(entry, parentPath) {
      const entryPath = parentPath ? parentPath + "/" + entry.name : entry.name;
      entries.set(entryPath, {
        name: entry.name,
        path: entryPath,
        isDirectory: entry.isDirectory,
        entry,
      });
      if (entry.isDirectory) {
        const reader = entry.createReader();
        const children = await readAllEntries(reader);
        await Promise.all(children.map((child) => walk(child, entryPath)));
      }
    }

    const reader = rootEntry.createReader();
    const topLevel = await readAllEntries(reader);
    await Promise.all(topLevel.map((child) => walk(child, "")));

    const portNames = [];
    for (const [p, e] of entries) {
      if (e.isDirectory && p.startsWith("ports/") && p.split("/").length === 2) {
        portNames.push(e.name);
      }
    }
    portNames.sort();

    return { entries, portNames, folderName: rootEntry.name };
  }

  function readFileEntry(fileEntry) {
    return new Promise((resolve, reject) => {
      fileEntry.file((file) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsText(file);
      }, reject);
    });
  }

  function getFileSize(fileEntry) {
    return new Promise((resolve) => {
      fileEntry.file((file) => resolve(file.size), () => resolve(null));
    });
  }

  // Local data access functions -- mirror the server API shape

  function localListPorts() {
    return state.localTree.portNames;
  }

  function localGetPortFiles(portName) {
    const prefix = "ports/" + portName + "/";
    const files = [];
    for (const [p, e] of state.localTree.entries) {
      if (p.startsWith(prefix) && p.substring(prefix.length).indexOf("/") === -1) {
        files.push({
          name: e.name,
          path: p,
          type: e.isDirectory ? "dir" : "file",
          entry: e.entry,
        });
      }
    }
    return files;
  }

  function localListDir(dirPath) {
    const prefix = dirPath + "/";
    const files = [];
    for (const [p, e] of state.localTree.entries) {
      if (p.startsWith(prefix) && p.substring(prefix.length).indexOf("/") === -1) {
        files.push({
          name: e.name,
          path: p,
          type: e.isDirectory ? "dir" : "file",
          entry: e.entry,
        });
      }
    }
    return files;
  }

  async function localReadFile(filePath) {
    const e = state.localTree.entries.get(filePath);
    if (!e || e.isDirectory) throw new Error("File not found: " + filePath);
    const content = await readFileEntry(e.entry);
    return { name: e.name, path: filePath, content };
  }

  async function localGetBaseline() {
    try {
      const data = await localReadFile("versions/baseline.json");
      return JSON.parse(data.content);
    } catch {
      return {};
    }
  }

  async function localGetVersions(portName) {
    const firstChar = portName[0].toLowerCase();
    try {
      const data = await localReadFile(`versions/${firstChar}-/${portName}.json`);
      return JSON.parse(data.content);
    } catch {
      return { versions: [] };
    }
  }

  async function localGetPortDependencies(portName) {
    try {
      const data = await localReadFile(`ports/${portName}/vcpkg.json`);
      const manifest = JSON.parse(data.content);
      const deps = [];
      for (const d of manifest.dependencies || []) {
        if (typeof d === "string") deps.push(d);
        else if (d && d.name) deps.push(d.name);
      }
      return [...new Set(deps)];
    } catch {
      return [];
    }
  }

  async function localBuildDepGraph(portName, maxDepth) {
    const registryPorts = new Set(state.localTree.portNames);
    const nodes = new Map();
    const edges = [];
    const queue = [{ port: portName, depth: 0 }];
    const visited = new Set();

    while (queue.length > 0) {
      const { port, depth } = queue.shift();
      if (visited.has(port)) continue;
      visited.add(port);

      const inRegistry = registryPorts.has(port);
      nodes.set(port, { id: port, inRegistry, depth, isRoot: port === portName });

      if (depth >= maxDepth || !inRegistry) continue;

      const deps = await localGetPortDependencies(port);
      for (const dep of deps) {
        edges.push({ source: port, target: dep });
        if (!visited.has(dep)) {
          queue.push({ port: dep, depth: depth + 1 });
        }
      }
    }

    return { root: portName, nodes: Array.from(nodes.values()), edges };
  }

  // -------------------------------------------------------------------------
  // UI mode switching
  // -------------------------------------------------------------------------

  function enterLocalMode(folderName) {
    state.localMode = true;
    els.sourceGithub.classList.add("hidden");
    els.dropZone.classList.add("hidden");
    els.localBanner.classList.remove("hidden");
    els.localBannerName.textContent = folderName;
  }

  function exitLocalMode() {
    state.localMode = false;
    state.localTree = null;
    state.ports = [];
    state.baseline = {};
    state.activePort = null;
    els.sourceGithub.classList.remove("hidden");
    els.dropZone.classList.remove("hidden");
    els.localBanner.classList.add("hidden");
    els.content.classList.add("hidden");
    showError("");
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

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

  function renderFileEntries(container, files, depth) {
    const html = files.map((f) => {
      const isDir = f.type === "dir";
      return `<li data-path="${escapeHtml(f.path)}" data-type="${isDir ? "dir" : "file"}" style="padding-left:${1 + depth * 1.2}rem">
        <span class="file-icon">${isDir ? "📁" : "📄"}</span>
        <span class="file-entry-name">${escapeHtml(f.name)}</span>
        ${f.size != null ? `<span class="file-size">${formatSize(f.size)}</span>` : ""}
      </li>`;
    }).join("");
    container.insertAdjacentHTML("beforeend", html);
  }

  // -------------------------------------------------------------------------
  // Loading registries
  // -------------------------------------------------------------------------

  async function loadGithubRegistry() {
    const url = els.urlInput.value.trim();
    if (!url) { showError("Please enter a GitHub URL."); return; }
    if (!url.match(/github\.com\/[^/]+\/[^/]+/)) {
      showError("Enter a valid GitHub repository URL.");
      return;
    }

    showError("");
    showLoading(true);
    state.registryUrl = url;
    state.ref = els.refInput.value.trim();
    state.activePort = null;

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

      renderPortList();
    } catch (err) {
      showError(err.message);
    } finally {
      showLoading(false);
    }
  }

  async function loadLocalRegistry(rootEntry) {
    showError("");
    showLoading(true);

    try {
      state.localTree = await scanDirectoryTree(rootEntry);

      if (state.localTree.portNames.length === 0) {
        showError("No ports/ directory found in the dropped folder.");
        state.localTree = null;
        showLoading(false);
        return;
      }

      state.ports = state.localTree.portNames;
      state.activePort = null;

      enterLocalMode(state.localTree.folderName);

      const baselineData = await localGetBaseline();
      const bl = baselineData.default || baselineData;
      state.baseline = bl || {};

      els.content.classList.remove("hidden");
      els.portDetail.classList.add("hidden");
      els.detailPlaceholder.classList.remove("hidden");

      renderPortList();
    } catch (err) {
      showError("Failed to read folder: " + err.message);
    } finally {
      showLoading(false);
    }
  }

  // -------------------------------------------------------------------------
  // Port detail
  // -------------------------------------------------------------------------

  async function selectPort(name) {
    state.activePort = name;
    renderPortList(els.portSearch.value);

    els.detailPlaceholder.classList.add("hidden");
    els.portDetail.classList.remove("hidden");
    closeInlineViewer();

    els.detailName.textContent = name;
    els.detailVersion.textContent = "";
    els.detailDescription.textContent = "Loading\u2026";
    els.versionList.innerHTML = "";
    els.featuresSection.classList.add("hidden");
    els.featuresList.innerHTML = "";
    els.fileList.innerHTML = "";

    try {
      let portFiles, versionData;

      if (state.localMode) {
        portFiles = localGetPortFiles(name);
        versionData = await localGetVersions(name);
      } else {
        const [pd, vd] = await Promise.all([
          api(`/api/ports/${encodeURIComponent(name)}`),
          api(`/api/versions/${encodeURIComponent(name)}`).catch(() => ({ versions: [] })),
        ]);
        portFiles = pd.files;
        versionData = vd;
      }

      let description = "";
      let currentVersion = "";
      const vcpkgJsonFile = portFiles.find((f) => f.name === "vcpkg.json");

      let features = null;
      if (vcpkgJsonFile) {
        try {
          let fileContent;
          if (state.localMode) {
            fileContent = (await localReadFile(vcpkgJsonFile.path)).content;
          } else {
            fileContent = (await api(`/api/file?path=${encodeURIComponent(vcpkgJsonFile.path)}`)).content;
          }
          const manifest = JSON.parse(fileContent);
          description = manifest.description || "";
          if (Array.isArray(description)) description = description.join(" ");
          currentVersion =
            manifest.version || manifest["version-string"] || manifest["version-semver"] || manifest["version-date"] || "";
          if (manifest.features && typeof manifest.features === "object") {
            features = manifest.features;
          }
        } catch {}
      }

      const blVer = state.baseline[name];
      if (!currentVersion && blVer) {
        currentVersion = blVer["baseline"] || blVer["version-string"] || blVer["version"] || "";
      }

      els.detailVersion.textContent = currentVersion ? "v" + currentVersion : "";
      els.detailDescription.textContent = description || "No description available.";

      const versions = versionData.versions || [];
      if (versions.length > 0) {
        els.versionList.innerHTML = versions
          .map((v, i) => {
            const ver = v.version || v["version-string"] || v["version-semver"] || v["version-date"] || "?";
            const port = v["port-version"] != null ? `#${v["port-version"]}` : "";
            return `<span class="version-tag${i === 0 ? " latest" : ""}">${escapeHtml(ver)}${port}</span>`;
          })
          .join("");
      } else {
        els.versionList.innerHTML = '<span class="version-tag">No version history found</span>';
      }

      // Features
      if (features && Object.keys(features).length > 0) {
        els.featuresSection.classList.remove("hidden");
        els.featuresList.innerHTML = Object.entries(features)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([fname, fdata]) => {
            let desc = fdata.description || "";
            if (Array.isArray(desc)) desc = desc.join(" ");
            const deps = fdata.dependencies || [];
            const depNames = deps.map((d) => typeof d === "string" ? d : (d && d.name) || "").filter(Boolean);
            return `<div class="feature-item">
              <div class="feature-header">
                <span class="feature-name">${escapeHtml(fname)}</span>
                ${depNames.length ? `<span class="feature-deps">${depNames.map((d) => escapeHtml(d)).join(", ")}</span>` : ""}
              </div>
              ${desc ? `<div class="feature-desc">${escapeHtml(desc)}</div>` : ""}
            </div>`;
          })
          .join("");
      }

      renderFileEntries(els.fileList, portFiles, 0);
    } catch (err) {
      els.detailDescription.textContent = "Error loading port: " + err.message;
    }
  }

  // -------------------------------------------------------------------------
  // File / directory browsing
  // -------------------------------------------------------------------------

  async function toggleDirectory(li) {
    const dirPath = li.dataset.path;

    if (li.classList.contains("expanded")) {
      li.classList.remove("expanded");
      li.querySelector(".file-icon").textContent = "📁";
      while (li.nextElementSibling && li.nextElementSibling.dataset.path &&
             li.nextElementSibling.dataset.path.startsWith(dirPath + "/")) {
        li.nextElementSibling.remove();
      }
      return;
    }

    li.classList.add("expanded");
    li.querySelector(".file-icon").textContent = "📂";

    const depth = Math.round((parseFloat(li.style.paddingLeft) - 1) / 1.2) + 1;

    try {
      let files;
      if (state.localMode) {
        files = localListDir(dirPath);
      } else {
        const data = await api(`/api/dir?path=${encodeURIComponent(dirPath)}`);
        files = data.files || [];
      }

      const temp = document.createElement("ul");
      renderFileEntries(temp, files, depth);
      const items = Array.from(temp.children);
      let insertAfter = li;
      for (const item of items) {
        insertAfter.after(item);
        insertAfter = item;
      }
    } catch (err) {
      const errLi = document.createElement("li");
      errLi.style.paddingLeft = `${1 + depth * 1.2}rem`;
      errLi.className = "file-error";
      errLi.textContent = "Error: " + err.message;
      li.after(errLi);
    }
  }

  function closeInlineViewer() {
    const existing = els.fileList.querySelector(".inline-file-viewer");
    if (existing) {
      const parentLi = existing.previousElementSibling;
      if (parentLi) parentLi.classList.remove("viewing");
      existing.remove();
    }
  }

  async function viewFile(filePath, clickedLi) {
    const alreadyOpen = clickedLi.classList.contains("viewing");
    closeInlineViewer();
    if (alreadyOpen) return;

    clickedLi.classList.add("viewing");

    const viewerLi = document.createElement("li");
    viewerLi.className = "inline-file-viewer";
    viewerLi.style.paddingLeft = clickedLi.style.paddingLeft;

    viewerLi.innerHTML = `
      <div class="file-viewer">
        <div class="file-viewer-header">
          <h3>${escapeHtml(filePath.split("/").pop())}</h3>
          <button class="close-btn" title="Close">&times;</button>
        </div>
        <pre><code>Loading\u2026</code></pre>
      </div>`;

    clickedLi.after(viewerLi);

    viewerLi.querySelector(".close-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      clickedLi.classList.remove("viewing");
      viewerLi.remove();
    });

    try {
      let content;
      if (state.localMode) {
        content = (await localReadFile(filePath)).content;
      } else {
        content = (await api(`/api/file?path=${encodeURIComponent(filePath)}`)).content;
      }
      viewerLi.querySelector("code").textContent = content;
      viewerLi.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (err) {
      viewerLi.querySelector("code").textContent = "Error: " + err.message;
    }
  }

  // -------------------------------------------------------------------------
  // Drag-and-drop handlers
  // -------------------------------------------------------------------------

  function setupDropZone() {
    const dz = els.dropZone;
    let dragCounter = 0;

    document.addEventListener("dragenter", (e) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      dragCounter++;
      dz.classList.add("drag-over");
    });

    document.addEventListener("dragleave", (e) => {
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        dz.classList.remove("drag-over");
      }
    });

    document.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
    });

    document.addEventListener("drop", (e) => {
      e.preventDefault();
      dragCounter = 0;
      dz.classList.remove("drag-over");

      if (state.localMode) return;

      const items = e.dataTransfer.items;
      if (!items || items.length === 0) return;

      const item = items[0];
      if (item.kind !== "file") return;

      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
      if (!entry || !entry.isDirectory) {
        showError("Please drop a folder, not a file.");
        return;
      }

      loadLocalRegistry(entry);
    });
  }

  // -------------------------------------------------------------------------
  // Event listeners
  // -------------------------------------------------------------------------

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    loadGithubRegistry();
  });

  els.urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      loadGithubRegistry();
    }
  });

  els.portSearch.addEventListener("input", () => {
    renderPortList(els.portSearch.value);
  });

  els.portList.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-port]");
    if (li) selectPort(li.dataset.port);
  });

  els.fileList.addEventListener("click", (e) => {
    if (e.target.closest(".inline-file-viewer")) return;
    const li = e.target.closest("li[data-path]");
    if (!li) return;
    if (li.dataset.type === "dir") {
      toggleDirectory(li);
    } else {
      viewFile(li.dataset.path, li);
    }
  });

  els.localClose.addEventListener("click", exitLocalMode);

  setupDropZone();

  // Expose state for depgraph.js
  window.vcviz = {
    getState: () => state,
    localReadFile,
    localGetPortDependencies,
    localBuildDepGraph,
  };
})();
