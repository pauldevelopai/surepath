const https = require('https');
const pool = require('./db');
const { saveBuffer } = require('./storage');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// Default voice — change to your cloned Nico voice ID
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';

/**
 * Call ElevenLabs TTS API and return the MP3 buffer.
 */
function callElevenLabs(scriptText, voiceId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text: scriptText,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.75,
        similarity_boost: 0.80,
        style: 0.20,
      },
    });

    const options = {
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', (c) => errBody += c);
        res.on('end', () => reject(new Error(`ElevenLabs ${res.statusCode}: ${errBody}`)));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Estimate MP3 duration from buffer size.
 * MP3 at 128kbps ≈ 16KB/sec.
 */
function estimateDuration(buffer) {
  return Math.round(buffer.length / 16000);
}

/**
 * Generate voice audio from script text.
 *
 * @param {string} scriptText - The script to synthesise
 * @param {string} [voiceId] - ElevenLabs voice ID
 * @param {number} [postId] - content_posts.id to update
 * @returns {string} S3 URL of the MP3
 */
async function generateVoice(scriptText, voiceId, postId) {
  if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not set');

  const vid = voiceId || DEFAULT_VOICE_ID;
  console.log(`[voice] Generating TTS (${scriptText.length} chars, voice=${vid})...`);

  const mp3Buffer = await callElevenLabs(scriptText, vid);

  // Check duration
  const durationSec = estimateDuration(mp3Buffer);
  console.log(`[voice] Audio: ${mp3Buffer.length} bytes, ~${durationSec}s`);

  if (durationSec < 8 || durationSec > 15) {
    console.warn(`[voice] WARNING: duration ~${durationSec}s is outside 8-15s target range for 10s reels`);
  }

  // Save locally — served at https://surepath.co.za/content/audio/...
  const timestamp = Date.now();
  const { url, localPath } = saveBuffer(mp3Buffer, 'audio', `${timestamp}.mp3`);
  console.log(`[voice] Saved: ${url} (${localPath})`);

  if (postId) {
    await pool.query('UPDATE content_posts SET audio_url = $1 WHERE id = $2', [url, postId]);
  }

  return url;
}

module.exports = { generateVoice, callElevenLabs, estimateDuration };
