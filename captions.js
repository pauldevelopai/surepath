const https = require('https');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const S3_BUCKET = process.env.AWS_S3_BUCKET || 'surepath-reports';
const AWS_REGION = process.env.AWS_REGION || 'af-south-1';
const s3 = new S3Client({ region: AWS_REGION });

const POLL_INTERVAL_MS = 5000;
const TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Make an HTTPS JSON request to AssemblyAI.
 */
function assemblyRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.assemblyai.com',
      path,
      method,
      headers: {
        'Authorization': ASSEMBLYAI_API_KEY,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`AssemblyAI ${res.statusCode}: ${data}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`AssemblyAI invalid JSON: ${data.substring(0, 200)}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Convert AssemblyAI word-level timestamps to SRT format.
 */
function wordsToSRT(words) {
  const lines = [];
  let lineIndex = 1;
  const WORDS_PER_LINE = 5;

  for (let i = 0; i < words.length; i += WORDS_PER_LINE) {
    const chunk = words.slice(i, i + WORDS_PER_LINE);
    const startMs = chunk[0].start;
    const endMs = chunk[chunk.length - 1].end;
    const text = chunk.map((w) => w.text).join(' ');

    lines.push(`${lineIndex}`);
    lines.push(`${formatSRTTime(startMs)} --> ${formatSRTTime(endMs)}`);
    lines.push(text);
    lines.push('');
    lineIndex++;
  }

  return lines.join('\n');
}

function formatSRTTime(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)},${pad3(millis)}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

/**
 * Generate captions (SRT) from an audio URL.
 *
 * @param {string} audioS3Url - S3 URL of the audio file
 * @returns {{ srt_url: string, srt_content: string }}
 */
async function generateCaptions(audioS3Url) {
  if (!ASSEMBLYAI_API_KEY) throw new Error('ASSEMBLYAI_API_KEY not set');

  console.log(`[captions] Submitting transcription: ${audioS3Url}`);

  // Submit transcription
  const submitRes = await assemblyRequest('POST', '/v2/transcript', {
    audio_url: audioS3Url,
    word_boost: ['Surepath', 'asbestos', 'CoC', 'DB board', 'geyser', 'rand', 'ZAR'],
    language_code: 'en',
  });

  const transcriptId = submitRes.id;
  console.log(`[captions] Transcript ID: ${transcriptId}`);

  // Poll until complete
  const startTime = Date.now();
  let result;

  while (Date.now() - startTime < TIMEOUT_MS) {
    result = await assemblyRequest('GET', `/v2/transcript/${transcriptId}`);

    console.log(`[captions] Poll: status=${result.status}`);

    if (result.status === 'completed') break;
    if (result.status === 'error') {
      throw new Error(`AssemblyAI transcription failed: ${result.error}`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!result || result.status !== 'completed') {
    throw new Error('AssemblyAI transcription timed out');
  }

  // Convert to SRT
  const words = result.words || [];
  if (words.length === 0) {
    console.warn('[captions] WARNING: no words in transcription');
  }

  const srtContent = wordsToSRT(words);
  console.log(`[captions] SRT generated: ${words.length} words, ${srtContent.split('\n\n').length} lines`);

  // Upload SRT to S3
  const timestamp = Date.now();
  const s3Key = `content/captions/${timestamp}.srt`;

  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: srtContent,
    ContentType: 'text/plain',
  }));

  const s3Url = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${s3Key}`;
  console.log(`[captions] Uploaded: ${s3Url}`);

  return { srt_url: s3Url, srt_content: srtContent };
}

module.exports = { generateCaptions, wordsToSRT, formatSRTTime };
