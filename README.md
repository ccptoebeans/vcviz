# vcviz

Explore any vcpkg registry by providing its GitHub URL. Browse all ports, view version history, and inspect port files.

## Quick start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) and enter a registry URL such as `https://github.com/microsoft/vcpkg`.

## GitHub API rate limits

Unauthenticated requests are limited to 60/hour. To raise the limit to 5,000/hour, set a personal access token:

```bash
GITHUB_TOKEN=ghp_xxx npm start
```
