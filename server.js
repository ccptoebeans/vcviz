const express = require("express");
const https = require("https");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ---------------------------------------------------------------------------
// Source detection: local path vs GitHub URL
// ---------------------------------------------------------------------------

function isLocalPath(source) {
  if (!source) return false;
  if (source.match(/^https?:\/\//)) return false;
  // Drive letter (C:\...) or UNC (\\...) or Unix absolute (/...) or relative
  return true;
}

function parseGithubUrl(url) {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

function githubFetch(apiPath) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent": "vcviz",
      Accept: "application/vnd.github.v3+json",
    };
    if (GITHUB_TOKEN) headers.Authorization = `token ${GITHUB_TOKEN}`;

    const url = new URL(apiPath, "https://api.github.com");
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers,
    };

    https
      .get(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 403 && res.headers["x-ratelimit-remaining"] === "0") {
            reject({ status: 429, message: "GitHub API rate limit exceeded. Set GITHUB_TOKEN env var for higher limits." });
            return;
          }
          if (res.statusCode >= 400) {
            reject({ status: res.statusCode, message: `GitHub API error: ${res.statusCode}` });
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      })
      .on("error", reject);
  });
}

async function getTreeShaForPath(owner, repo, ref, dirPath) {
  const branch = ref || (await githubFetch(`/repos/${owner}/${repo}`)).default_branch;
  const branchData = await githubFetch(
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`
  ).catch(() =>
    githubFetch(`/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(branch)}`)
  );

  let commitSha;
  if (branchData.object.type === "tag") {
    const tag = await githubFetch(`/repos/${owner}/${repo}/git/tags/${branchData.object.sha}`);
    commitSha = tag.object.sha;
  } else {
    commitSha = branchData.object.sha;
  }

  const commit = await githubFetch(`/repos/${owner}/${repo}/git/commits/${commitSha}`);
  let treeSha = commit.tree.sha;

  for (const segment of dirPath.split("/").filter(Boolean)) {
    const tree = await githubFetch(`/repos/${owner}/${repo}/git/trees/${treeSha}`);
    const entry = tree.tree.find((t) => t.path === segment && t.type === "tree");
    if (!entry) return null;
    treeSha = entry.sha;
  }
  return treeSha;
}

// ---------------------------------------------------------------------------
// Local filesystem helpers
// ---------------------------------------------------------------------------

function resolveLocalPath(source) {
  return path.resolve(source);
}

function localListPorts(rootDir) {
  const portsDir = path.join(rootDir, "ports");
  if (!fs.existsSync(portsDir)) return null;
  return fs.readdirSync(portsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function localGetPortFiles(rootDir, portName) {
  const portDir = path.join(rootDir, "ports", portName);
  if (!fs.existsSync(portDir)) return [];
  return fs.readdirSync(portDir, { withFileTypes: true }).map((d) => ({
    name: d.name,
    path: `ports/${portName}/${d.name}`,
    type: d.isDirectory() ? "dir" : "file",
    size: d.isFile() ? fs.statSync(path.join(portDir, d.name)).size : null,
  }));
}

function localReadFile(rootDir, filePath) {
  const full = path.join(rootDir, filePath);
  if (!fs.existsSync(full)) return null;
  const stat = fs.statSync(full);
  if (stat.isDirectory()) return { isDir: true };
  return {
    name: path.basename(full),
    path: filePath,
    content: fs.readFileSync(full, "utf-8"),
    size: stat.size,
  };
}

function localListDir(rootDir, dirPath) {
  const full = path.join(rootDir, dirPath);
  if (!fs.existsSync(full)) return null;
  const stat = fs.statSync(full);
  if (!stat.isDirectory()) return null;
  return fs.readdirSync(full, { withFileTypes: true }).map((d) => ({
    name: d.name,
    path: dirPath.replace(/\\/g, "/") + "/" + d.name,
    type: d.isDirectory() ? "dir" : "file",
    size: d.isFile() ? fs.statSync(path.join(full, d.name)).size : null,
  }));
}

function localGetVersions(rootDir, portName) {
  const firstChar = portName[0].toLowerCase();
  const versionPath = path.join(rootDir, "versions", `${firstChar}-`, `${portName}.json`);
  try {
    return JSON.parse(fs.readFileSync(versionPath, "utf-8"));
  } catch {
    return { versions: [] };
  }
}

function localGetBaseline(rootDir) {
  const blPath = path.join(rootDir, "versions", "baseline.json");
  try {
    return JSON.parse(fs.readFileSync(blPath, "utf-8"));
  } catch {
    return {};
  }
}

function localGetPortDependencies(rootDir, portName) {
  const vcpkgPath = path.join(rootDir, "ports", portName, "vcpkg.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(vcpkgPath, "utf-8"));
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

function localListAllPortNames(rootDir) {
  const portsDir = path.join(rootDir, "ports");
  if (!fs.existsSync(portsDir)) return new Set();
  return new Set(
    fs.readdirSync(portsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/ports", async (req, res) => {
  const { url, ref } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url parameter" });

  if (isLocalPath(url)) {
    const rootDir = resolveLocalPath(url);
    const ports = localListPorts(rootDir);
    if (!ports) return res.status(404).json({ error: "No ports directory found at this path" });
    return res.json({ ports, local: true });
  }

  const parsed = parseGithubUrl(url);
  if (!parsed) return res.status(400).json({ error: "Invalid GitHub URL" });

  try {
    const treeSha = await getTreeShaForPath(parsed.owner, parsed.repo, ref, "ports");
    if (!treeSha) {
      return res.status(404).json({ error: "No ports directory found in this registry" });
    }
    const tree = await githubFetch(
      `/repos/${parsed.owner}/${parsed.repo}/git/trees/${treeSha}`
    );
    const ports = tree.tree
      .filter((item) => item.type === "tree")
      .map((item) => item.path)
      .sort();
    res.json({ ports, owner: parsed.owner, repo: parsed.repo });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Failed to fetch ports" });
  }
});

app.get("/api/ports/:name", async (req, res) => {
  const { url, ref } = req.query;
  const { name } = req.params;
  if (!url) return res.status(400).json({ error: "Missing url parameter" });

  if (isLocalPath(url)) {
    const rootDir = resolveLocalPath(url);
    return res.json({ name, files: localGetPortFiles(rootDir, name) });
  }

  const parsed = parseGithubUrl(url);
  if (!parsed) return res.status(400).json({ error: "Invalid GitHub URL" });

  try {
    const refParam = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const contents = await githubFetch(
      `/repos/${parsed.owner}/${parsed.repo}/contents/ports/${encodeURIComponent(name)}${refParam}`
    );
    const files = Array.isArray(contents)
      ? contents.map((f) => ({ name: f.name, path: f.path, type: f.type, size: f.size }))
      : [];
    res.json({ name, files });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Failed to fetch port" });
  }
});

app.get("/api/dir", async (req, res) => {
  const { url, path: dirPath, ref } = req.query;
  if (!url || !dirPath) return res.status(400).json({ error: "Missing url or path parameter" });

  if (isLocalPath(url)) {
    const rootDir = resolveLocalPath(url);
    const entries = localListDir(rootDir, dirPath);
    if (!entries) return res.status(404).json({ error: "Directory not found" });
    return res.json({ path: dirPath, files: entries });
  }

  const parsed = parseGithubUrl(url);
  if (!parsed) return res.status(400).json({ error: "Invalid GitHub URL" });

  try {
    const refParam = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const contents = await githubFetch(
      `/repos/${parsed.owner}/${parsed.repo}/contents/${encodeURIComponent(dirPath).replace(/%2F/g, "/")}${refParam}`
    );
    const files = Array.isArray(contents)
      ? contents.map((f) => ({ name: f.name, path: f.path, type: f.type, size: f.size }))
      : [];
    res.json({ path: dirPath, files });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Failed to list directory" });
  }
});

app.get("/api/file", async (req, res) => {
  const { url, path: filePath, ref } = req.query;
  if (!url || !filePath) return res.status(400).json({ error: "Missing url or path parameter" });

  if (isLocalPath(url)) {
    const rootDir = resolveLocalPath(url);
    const data = localReadFile(rootDir, filePath);
    if (!data) return res.status(404).json({ error: "File not found" });
    if (data.isDir) return res.status(400).json({ error: "Path is a directory, not a file" });
    return res.json(data);
  }

  const parsed = parseGithubUrl(url);
  if (!parsed) return res.status(400).json({ error: "Invalid GitHub URL" });

  try {
    const refParam = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const content = await githubFetch(
      `/repos/${parsed.owner}/${parsed.repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}${refParam}`
    );
    if (content.encoding === "base64" && content.content) {
      const decoded = Buffer.from(content.content, "base64").toString("utf-8");
      res.json({ name: content.name, path: content.path, content: decoded, size: content.size });
    } else if (Array.isArray(content)) {
      return res.status(400).json({ error: "Path is a directory, not a file" });
    } else {
      res.json({ name: content.name, path: content.path, content: "", size: content.size });
    }
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Failed to fetch file" });
  }
});

app.get("/api/versions/:name", async (req, res) => {
  const { url, ref } = req.query;
  const { name } = req.params;
  if (!url) return res.status(400).json({ error: "Missing url parameter" });

  if (isLocalPath(url)) {
    const rootDir = resolveLocalPath(url);
    return res.json(localGetVersions(rootDir, name));
  }

  const parsed = parseGithubUrl(url);
  if (!parsed) return res.status(400).json({ error: "Invalid GitHub URL" });

  try {
    const refParam = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const firstChar = name[0].toLowerCase();
    const versionPath = `versions/${firstChar}-/${name}.json`;
    const content = await githubFetch(
      `/repos/${parsed.owner}/${parsed.repo}/contents/${versionPath}${refParam}`
    );
    if (content.encoding === "base64" && content.content) {
      const decoded = Buffer.from(content.content, "base64").toString("utf-8");
      res.json(JSON.parse(decoded));
    } else {
      res.json({ versions: [] });
    }
  } catch {
    res.json({ versions: [] });
  }
});

app.get("/api/baseline", async (req, res) => {
  const { url, ref } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url parameter" });

  if (isLocalPath(url)) {
    const rootDir = resolveLocalPath(url);
    return res.json(localGetBaseline(rootDir));
  }

  const parsed = parseGithubUrl(url);
  if (!parsed) return res.status(400).json({ error: "Invalid GitHub URL" });

  try {
    const refParam = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const content = await githubFetch(
      `/repos/${parsed.owner}/${parsed.repo}/contents/versions/baseline.json${refParam}`
    );
    if (content.encoding === "base64" && content.content) {
      const decoded = Buffer.from(content.content, "base64").toString("utf-8");
      res.json(JSON.parse(decoded));
    } else {
      res.json({});
    }
  } catch {
    res.json({});
  }
});

// GitHub-only helper for depgraph
async function ghGetPortDependencies(owner, repo, portName, ref) {
  const refParam = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  try {
    const content = await githubFetch(
      `/repos/${owner}/${repo}/contents/ports/${encodeURIComponent(portName)}/vcpkg.json${refParam}`
    );
    if (content.encoding !== "base64" || !content.content) return [];
    const manifest = JSON.parse(Buffer.from(content.content, "base64").toString("utf-8"));
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

app.get("/api/depgraph/:name", async (req, res) => {
  const { url, ref } = req.query;
  const { name } = req.params;
  const maxDepth = Math.min(parseInt(req.query.depth) || 6, 10);
  if (!url) return res.status(400).json({ error: "Missing url parameter" });

  if (isLocalPath(url)) {
    const rootDir = resolveLocalPath(url);
    const registryPorts = localListAllPortNames(rootDir);
    if (registryPorts.size === 0) {
      return res.status(404).json({ error: "No ports directory found at this path" });
    }

    const nodes = new Map();
    const edges = [];
    const queue = [{ port: name, depth: 0 }];
    const visited = new Set();

    while (queue.length > 0) {
      const { port, depth } = queue.shift();
      if (visited.has(port)) continue;
      visited.add(port);

      const inRegistry = registryPorts.has(port);
      nodes.set(port, { id: port, inRegistry, depth, isRoot: port === name });

      if (depth >= maxDepth || !inRegistry) continue;

      const deps = localGetPortDependencies(rootDir, port);
      for (const dep of deps) {
        edges.push({ source: port, target: dep });
        if (!visited.has(dep)) {
          queue.push({ port: dep, depth: depth + 1 });
        }
      }
    }

    return res.json({ root: name, nodes: Array.from(nodes.values()), edges });
  }

  const parsed = parseGithubUrl(url);
  if (!parsed) return res.status(400).json({ error: "Invalid GitHub URL" });

  try {
    const treeSha = await getTreeShaForPath(parsed.owner, parsed.repo, ref, "ports");
    const tree = await githubFetch(`/repos/${parsed.owner}/${parsed.repo}/git/trees/${treeSha}`);
    const registryPorts = new Set(tree.tree.filter((t) => t.type === "tree").map((t) => t.path));

    const nodes = new Map();
    const edges = [];
    const queue = [{ port: name, depth: 0 }];
    const visited = new Set();

    while (queue.length > 0) {
      const batch = [];
      while (queue.length > 0) batch.push(queue.shift());

      const fetches = batch.map(async ({ port, depth }) => {
        if (visited.has(port)) return;
        visited.add(port);

        const inRegistry = registryPorts.has(port);
        nodes.set(port, { id: port, inRegistry, depth, isRoot: port === name });

        if (depth >= maxDepth || !inRegistry) return;

        const deps = await ghGetPortDependencies(parsed.owner, parsed.repo, port, ref);
        for (const dep of deps) {
          edges.push({ source: port, target: dep });
          if (!visited.has(dep)) {
            queue.push({ port: dep, depth: depth + 1 });
          }
        }
      });

      await Promise.all(fetches);
    }

    res.json({ root: name, nodes: Array.from(nodes.values()), edges });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Failed to build dependency graph" });
  }
});

app.listen(PORT, () => {
  console.log(`vcviz running at http://localhost:${PORT}`);
});
