const fs = require("fs");
const path = require("path");

let cache = null;

function localKnowledge() {
  if (cache) return cache;

  const file = path.join(__dirname, "growwwave-knowledge.json");
  cache = JSON.parse(fs.readFileSync(file, "utf8"));

  return cache;
}

async function githubKnowledge() {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const filePath =
    process.env.GITHUB_KNOWLEDGE_PATH || "growwwave-knowledge.json";
  const token = process.env.GITHUB_TOKEN;

  if (!owner || !repo || !token) return null;

  const url =
    `https://api.github.com/repos/` +
    `${encodeURIComponent(owner)}/` +
    `${encodeURIComponent(repo)}/contents/${filePath}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "GrowwWave-Toro"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Knowledge GitHub fetch failed: HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (!data.content) {
    throw new Error("Knowledge file content missing");
  }

  const decoded = Buffer.from(
    data.content.replace(/\n/g, ""),
    "base64"
  ).toString("utf8");

  return JSON.parse(decoded);
}

async function getKnowledge() {
  try {
    const remote = await githubKnowledge();

    if (remote) {
      return remote;
    }
  } catch (error) {
    // Use the bundled verified copy if GitHub knowledge is unavailable.
  }

  return localKnowledge();
}

module.exports = {
  getKnowledge
};
