/**
 * Local storage helper for content pipeline.
 * Saves audio, captions, and videos to dashboard/public/content/
 * which is served statically at https://surepath.co.za/content/
 *
 * Used instead of S3 for the video factory — no AWS creds needed on the server.
 */
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://surepath.co.za';

// Absolute path to dashboard/public/content — resolves from project root
const CONTENT_DIR = path.resolve(__dirname, 'dashboard', 'public', 'content');

function ensureDir(sub) {
  const dir = path.join(CONTENT_DIR, sub);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Save a buffer to local content dir and return a public URL.
 * @param {Buffer} buffer
 * @param {string} subdir - 'audio', 'video', 'stock', etc.
 * @param {string} filename - e.g. '1234.mp4'
 */
function saveBuffer(buffer, subdir, filename) {
  const dir = ensureDir(subdir);
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, buffer);
  return {
    localPath: filepath,
    url: `${BASE_URL}/content/${subdir}/${filename}`,
  };
}

/**
 * Save a file (copy) to local content dir.
 */
function saveFile(srcPath, subdir, filename) {
  const dir = ensureDir(subdir);
  const filepath = path.join(dir, filename);
  fs.copyFileSync(srcPath, filepath);
  return {
    localPath: filepath,
    url: `${BASE_URL}/content/${subdir}/${filename}`,
  };
}

module.exports = { saveBuffer, saveFile, CONTENT_DIR, BASE_URL };
