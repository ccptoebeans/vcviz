(() => {
  const $ = (sel) => document.querySelector(sel);

  const els = {
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
    sourceServer: $("#source-server"),
    serverRegistrySelect: $("#server-registry-select"),
    localBanner: $("#local-banner"),
    localBannerName: $("#local-banner-name"),
    localClose: $("#local-close"),
  };

  let state = {
    ports: [],
    baseline: {},
    activePort: null,
    localMode: false,
    localTree: null,
    serverRegistryId: null,
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

  function renderJsonHighlight(text) {
    return text.split("\n").map((line) => {
      let esc = escapeHtml(line);

      // Property keys: "key":
      esc = esc.replace(/^(\s*)("(?:[^"\\]|\\.)*")(\s*:)/,
        '$1<span class="js-key">$2</span>$3');

      // String values after colon
      esc = esc.replace(/(:\s*)("(?:[^"\\]|\\.)*")/g,
        '$1<span class="js-string">$2</span>');

      // Bare strings in arrays (not already highlighted as key/value)
      esc = esc.replace(/^(\s*)("(?:[^"\\]|\\.)*")(\s*[,\]]?\s*)$/,
        (m, pre, str, post) => {
          if (m.includes("js-key") || m.includes("js-string")) return m;
          return `${pre}<span class="js-string">${str}</span>${post}`;
        });

      // Numbers
      esc = esc.replace(/(:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(\s*[,\]}]?\s*$)/,
        '$1<span class="js-number">$2</span>$3');
      esc = esc.replace(/^(\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(\s*[,\]]?\s*)$/,
        '$1<span class="js-number">$2</span>$3');

      // Booleans and null
      esc = esc.replace(/(:\s*)(true|false|null)(\s*[,\]}]?\s*$)/,
        '$1<span class="js-bool">$2</span>$3');

      return esc;
    }).join("\n");
  }

  function renderCmakeHighlight(text) {
    return text.split("\n").map((line) => {
      if (/^\s*#/.test(line)) {
        return `<span class="cm-comment">${escapeHtml(line)}</span>`;
      }

      let esc = escapeHtml(line);

      const strings = [];
      esc = esc.replace(/"(?:[^"\\]|\\.)*"/g, (m) => {
        strings.push(m);
        return `\x00S${strings.length - 1}\x00`;
      });

      esc = esc.replace(/\$ENV\{[^}]*\}/g, '<span class="cm-var">$&</span>');
      esc = esc.replace(/\$\{[^}]*\}/g, '<span class="cm-var">$&</span>');

      esc = esc.replace(/^(\s*)([\w]+)(\s*\()/, '$1<span class="cm-cmd">$2</span>$3');

      esc = esc.replace(/(\s)(#.*)$/, '$1<span class="cm-comment">$2</span>');

      esc = esc.replace(/\x00S(\d+)\x00/g, (_, idx) => {
        let s = strings[parseInt(idx)];
        s = s.replace(/\$ENV\{[^}]*\}/g, '<span class="cm-var">$&</span>');
        s = s.replace(/\$\{[^}]*\}/g, '<span class="cm-var">$&</span>');
        return `<span class="cm-string">${s}</span>`;
      });

      return esc;
    }).join("\n");
  }

  function renderDiffHighlight(text) {
    return text.split("\n").map((line) => {
      const esc = escapeHtml(line);
      if (line.startsWith("+++") || line.startsWith("---")) {
        return `<span class="diff-meta">${esc}</span>`;
      }
      if (line.startsWith("@@")) {
        return `<span class="diff-hunk">${esc}</span>`;
      }
      if (line.startsWith("diff ") || line.startsWith("index ") ||
          line.startsWith("new file") || line.startsWith("deleted file") ||
          line.startsWith("similarity") || line.startsWith("rename ") ||
          line.startsWith("old mode") || line.startsWith("new mode")) {
        return `<span class="diff-header">${esc}</span>`;
      }
      if (line.startsWith("+")) {
        return `<span class="diff-add">${esc}</span>`;
      }
      if (line.startsWith("-")) {
        return `<span class="diff-del">${esc}</span>`;
      }
      return `<span class="diff-ctx">${esc}</span>`;
    }).join("\n");
  }

  // -------------------------------------------------------------------------
  // Server API helper
  // -------------------------------------------------------------------------

  async function api(path) {
    const sep = path.includes("?") ? "&" : "?";
    const fullUrl = path + sep + "registryId=" + encodeURIComponent(state.serverRegistryId);
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

  // Cache: portName -> { featureName: [portA, portB, ...] }
  let featureUsageCache = {};

  async function localFindFeatureUsages(portName) {
    if (featureUsageCache[portName]) return featureUsageCache[portName];

    const usages = {};
    for (const otherPort of state.localTree.portNames) {
      if (otherPort === portName) continue;
      const e = state.localTree.entries.get(`ports/${otherPort}/vcpkg.json`);
      if (!e) continue;
      try {
        const content = await readFileEntry(e.entry);
        const manifest = JSON.parse(content);
        const checkDeps = (deps) => {
          for (const dep of deps) {
            if (typeof dep !== "object" || dep.name !== portName) continue;
            for (const feat of dep.features || []) {
              if (!usages[feat]) usages[feat] = new Set();
              usages[feat].add(otherPort);
            }
          }
        };
        checkDeps(manifest.dependencies || []);
        if (manifest.features) {
          for (const fdata of Object.values(manifest.features)) {
            checkDeps(fdata.dependencies || []);
          }
        }
      } catch {}
    }

    const result = {};
    for (const [feat, ports] of Object.entries(usages)) {
      result[feat] = [...ports].sort();
    }
    featureUsageCache[portName] = result;
    return result;
  }

  // -------------------------------------------------------------------------
  // UI mode switching
  // -------------------------------------------------------------------------

  function enterLocalMode(folderName) {
    state.localMode = true;
    state.serverRegistryId = null;
    featureUsageCache = {};
    els.serverRegistrySelect.value = "";
    els.sourceServer.classList.add("hidden");
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
    state.serverRegistryId = null;
    featureUsageCache = {};
    els.serverRegistrySelect.value = "";
    els.sourceServer.classList.remove("hidden");
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

  async function loadServerRegistry(registryId) {
    showError("");
    showLoading(true);
    state.serverRegistryId = registryId;
    state.activePort = null;
    state.localMode = false;
    state.localTree = null;

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
      state.serverRegistryId = null;
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
            const usagesHtml = `<div class="feature-usages">
                  <button class="feature-usages-toggle" data-feature="${escapeHtml(fname)}" data-port="${escapeHtml(name)}">
                    <span class="usages-arrow">&#9654;</span> Used by&hellip;
                  </button>
                  <div class="feature-usages-list hidden"></div>
                </div>`;
            return `<div class="feature-item">
              <div class="feature-header">
                <span class="feature-name">${escapeHtml(fname)}</span>
                ${depNames.length ? `<span class="feature-deps">${depNames.map((d) => escapeHtml(d)).join(", ")}</span>` : ""}
              </div>
              ${desc ? `<div class="feature-desc">${escapeHtml(desc)}</div>` : ""}
              ${usagesHtml}
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
      const codeEl = viewerLi.querySelector("code");
      const fileName = filePath.split("/").pop();
      if (/\.(patch|diff)$/i.test(fileName)) {
        codeEl.innerHTML = renderDiffHighlight(content);
      } else if (/\.cmake$/i.test(fileName) || fileName === "CMakeLists.txt") {
        codeEl.innerHTML = renderCmakeHighlight(content);
      } else if (/\.json$/i.test(fileName)) {
        codeEl.innerHTML = renderJsonHighlight(content);
      } else {
        codeEl.textContent = content;
      }
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

  els.featuresList.addEventListener("click", async (e) => {
    const btn = e.target.closest(".feature-usages-toggle");
    if (!btn) return;
    const listEl = btn.nextElementSibling;
    const arrow = btn.querySelector(".usages-arrow");
    const isOpen = !listEl.classList.contains("hidden");

    if (isOpen) {
      listEl.classList.add("hidden");
      arrow.textContent = "\u25B6";
      return;
    }

    if (!listEl.dataset.loaded) {
      arrow.textContent = "\u23F3";
      btn.disabled = true;
      try {
        let usages;
        if (state.localMode) {
          usages = await localFindFeatureUsages(btn.dataset.port);
        } else if (state.serverRegistryId) {
          const data = await api(`/api/feature-usages/${encodeURIComponent(btn.dataset.port)}`);
          usages = data.usages || {};
        }
        const ports = (usages && usages[btn.dataset.feature]) || [];
        if (ports.length > 0) {
          listEl.innerHTML = ports
            .map((p) => `<span class="usage-port" data-port="${escapeHtml(p)}">${escapeHtml(p)}</span>`)
            .join("");
        } else {
          listEl.innerHTML = '<span class="usage-none">No ports use this feature</span>';
        }
      } catch {
        listEl.innerHTML = '<span class="usage-none">Error scanning registry</span>';
      }
      listEl.dataset.loaded = "1";
      btn.disabled = false;
    }

    listEl.classList.remove("hidden");
    arrow.textContent = "\u25BC";
  });

  els.featuresList.addEventListener("click", (e) => {
    const portSpan = e.target.closest(".usage-port");
    if (portSpan) selectPort(portSpan.dataset.port);
  });

  els.serverRegistrySelect.addEventListener("change", () => {
    const id = els.serverRegistrySelect.value;
    if (!id) return;
    state.localMode = false;
    state.localTree = null;
    featureUsageCache = {};
    els.localBanner.classList.add("hidden");
    els.dropZone.classList.remove("hidden");
    loadServerRegistry(id);
  });

  els.localClose.addEventListener("click", exitLocalMode);

  // On page load, populate the server registries dropdown
  (async function populateServerRegistries() {
    try {
      const data = await fetch("/api/server-registries").then((r) => r.json());
      for (const reg of data.registries || []) {
        const opt = document.createElement("option");
        opt.value = reg.id;
        opt.textContent = reg.name;
        if (reg.status !== "ready") {
          opt.textContent += " (unavailable)";
          opt.disabled = true;
        }
        els.serverRegistrySelect.appendChild(opt);
      }
      if ((data.registries || []).length === 0) {
        els.sourceServer.classList.add("hidden");
      }
    } catch {
      els.sourceServer.classList.add("hidden");
    }
  })();

  setupDropZone();

  // Expose state for depgraph.js
  window.vcviz = {
    getState: () => state,
    localReadFile,
    localGetPortDependencies,
    localBuildDepGraph,
  };
})();
