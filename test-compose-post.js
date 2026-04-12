/**
 * Finish the compose step for a given content_post_id.
 */
require('dotenv').config();
const pool = require('./db');
const { composeVideo } = require('./compose.js');
const { buildShotList } = require('./visuals.js');

const postId = parseInt(process.argv[2]);
if (!postId) { console.error('Usage: node test-compose-post.js <postId>'); process.exit(1); }

async function run() {
  const { rows } = await pool.query(
    "SELECT audio_url, srt_content, hook, script, property_id FROM content_posts WHERE id = $1",
    [postId]
  );
  if (!rows[0]) { console.error('Post not found'); process.exit(1); }
  const post = rows[0];
  if (!post.audio_url || !post.srt_content) {
    console.error('Missing audio or captions'); process.exit(1);
  }

  // Probe audio duration with ffprobe
  const { execSync } = require('child_process');
  const path = require('path');
  const relPath = post.audio_url.split('/content/')[1];
  const localAudio = path.resolve(__dirname, 'dashboard', 'public', 'content', relPath);
  const probe = execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${localAudio}"`, { encoding: 'utf8' }).trim();
  const durationSec = parseFloat(probe) || 10;
  console.log(`Duration: ${durationSec}s`);

  const shotList = await buildShotList(post.script, durationSec, post.property_id);
  console.log(`Shot list: ${shotList.length} shots`);

  const outputName = `nico-reel-${postId}-${Date.now()}`;
  const finalUrl = await composeVideo(post.audio_url, post.srt_content, post.property_id, post.hook, outputName, postId, shotList);
  console.log(`DONE: ${finalUrl}`);
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
