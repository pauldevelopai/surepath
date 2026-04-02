const { estimateDuration } = require('./voice');
const { wordsToSRT, formatSRTTime } = require('./captions');
const { writeSRTToTemp } = require('./compose');
const fs = require('fs');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  PASS: ${label}`); passed++; }
  else { console.log(`  FAIL: ${label}`); failed++; }
}

// ─── voice.js unit tests ───────────────────────────────────────────────

async function testEstimateDuration() {
  console.log('\n=== VOICE: estimateDuration ===');

  // 128kbps MP3 ≈ 16KB/sec
  assert(estimateDuration(Buffer.alloc(480000)) === 30, '480KB → 30s');
  assert(estimateDuration(Buffer.alloc(448000)) === 28, '448KB → 28s');
  assert(estimateDuration(Buffer.alloc(512000)) === 32, '512KB → 32s');
  assert(estimateDuration(Buffer.alloc(160000)) === 10, '160KB → 10s (below target)');
}

async function testLiveVoice() {
  console.log('\n=== VOICE: generateVoice (live ElevenLabs) ===');

  if (!process.env.ELEVENLABS_API_KEY) {
    console.log('  SKIP: ELEVENLABS_API_KEY not set');
    return;
  }

  const { generateVoice } = require('./voice');
  const script = "Stop. Before you sign that offer to purchase, let me show you what the agent won't tell you. This house in Gardens, Cape Town looks perfect — but Surepath found three hidden issues that could cost you over R85,000 in the first year alone.";

  const url = await generateVoice(script);
  assert(typeof url === 'string', `returned URL: ${url}`);
  assert(url.includes('s3'), 'URL is S3');
  assert(url.endsWith('.mp3'), 'URL ends with .mp3');
}

// ─── captions.js unit tests ────────────────────────────────────────────

async function testFormatSRTTime() {
  console.log('\n=== CAPTIONS: formatSRTTime ===');

  assert(formatSRTTime(0) === '00:00:00,000', '0ms');
  assert(formatSRTTime(1500) === '00:00:01,500', '1500ms');
  assert(formatSRTTime(65000) === '00:01:05,000', '65000ms');
  assert(formatSRTTime(3661234) === '01:01:01,234', '3661234ms');
}

async function testWordsToSRT() {
  console.log('\n=== CAPTIONS: wordsToSRT ===');

  const words = [
    { text: 'Stop', start: 0, end: 300 },
    { text: 'before', start: 350, end: 650 },
    { text: 'you', start: 700, end: 850 },
    { text: 'sign', start: 900, end: 1200 },
    { text: 'that', start: 1250, end: 1500 },
    { text: 'offer', start: 1550, end: 1900 },
    { text: 'to', start: 1950, end: 2100 },
    { text: 'purchase', start: 2150, end: 2600 },
  ];

  const srt = wordsToSRT(words);

  assert(typeof srt === 'string', 'returns string');
  assert(srt.includes('1\n'), 'has line 1');
  assert(srt.includes('2\n'), 'has line 2');
  assert(srt.includes('Stop before you sign that'), 'first line has 5 words');
  assert(srt.includes('offer to purchase'), 'second line has remaining');
  assert(srt.includes('-->'), 'has SRT timestamp arrows');
  assert(srt.includes('00:00:00,000'), 'starts at 0');

  console.log('\n  --- SRT output ---');
  console.log(srt.split('\n').map(l => '  ' + l).join('\n'));
}

async function testLiveCaptions() {
  console.log('\n=== CAPTIONS: generateCaptions (live AssemblyAI) ===');

  if (!process.env.ASSEMBLYAI_API_KEY) {
    console.log('  SKIP: ASSEMBLYAI_API_KEY not set');
    return;
  }

  // Need a real audio URL — skip if no S3 audio available
  console.log('  SKIP: requires live audio URL from voice.js output');
}

// ─── compose.js unit tests ─────────────────────────────────────────────

async function testWriteSRTToTemp() {
  console.log('\n=== COMPOSE: writeSRTToTemp ===');

  const srtContent = "1\n00:00:00,000 --> 00:00:02,000\nTest caption\n";
  const tmpPath = writeSRTToTemp(srtContent);

  assert(fs.existsSync(tmpPath), 'temp file created');
  assert(fs.readFileSync(tmpPath, 'utf8') === srtContent, 'content matches');

  fs.unlinkSync(tmpPath);
  assert(!fs.existsSync(tmpPath), 'cleanup works');
}

async function testFFmpegAvailable() {
  console.log('\n=== COMPOSE: FFmpeg availability ===');

  const { execSync } = require('child_process');
  try {
    const version = execSync('ffmpeg -version', { stdio: 'pipe' }).toString().split('\n')[0];
    assert(true, `FFmpeg found: ${version}`);
  } catch {
    console.log('  WARN: FFmpeg not installed — compose will fail at runtime');
    assert(false, 'FFmpeg not available');
  }
}

async function testComposeOffline() {
  console.log('\n=== COMPOSE: offline render (FFmpeg, no S3) ===');

  const { execSync } = require('child_process');
  const path = require('path');
  const os = require('os');

  // Check FFmpeg
  try { execSync('ffmpeg -version', { stdio: 'pipe' }); }
  catch { console.log('  SKIP: FFmpeg not installed'); return; }

  // Generate a tiny test video with FFmpeg
  const testVideo = path.join(os.tmpdir(), 'surepath_test_input.mp4');
  const testOutput = path.join(os.tmpdir(), 'surepath_test_output.mp4');
  const testSrt = path.join(os.tmpdir(), 'surepath_test.srt');

  try {
    // Create 3-second test video (black with tone)
    execSync(
      `ffmpeg -y -f lavfi -i color=c=black:s=1080x1920:d=3 -f lavfi -i sine=frequency=440:duration=3 -c:v libx264 -c:a aac -shortest "${testVideo}"`,
      { stdio: 'pipe', timeout: 15000 }
    );

    assert(fs.existsSync(testVideo), 'test video created');

    // Create test SRT
    fs.writeFileSync(testSrt, "1\n00:00:00,000 --> 00:00:02,000\nSurepath test caption\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond line\n");

    // Run compose-style FFmpeg
    const escapedSrt = testSrt.replace(/:/g, '\\:');
    execSync(
      `ffmpeg -y -i "${testVideo}" -vf "subtitles='${escapedSrt}':force_style='FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Bold=1,Alignment=2,MarginV=120'" -c:v libx264 -preset ultrafast -c:a aac "${testOutput}"`,
      { stdio: 'pipe', timeout: 30000 }
    );

    assert(fs.existsSync(testOutput), 'output video created');
    const size = fs.statSync(testOutput).size;
    assert(size > 1000, `output size: ${Math.round(size / 1024)}KB`);

    console.log(`  Rendered test video: ${Math.round(size / 1024)}KB`);
  } finally {
    try { fs.unlinkSync(testVideo); } catch {}
    try { fs.unlinkSync(testOutput); } catch {}
    try { fs.unlinkSync(testSrt); } catch {}
  }
}

// ─── publish.js unit tests ─────────────────────────────────────────────

async function testPublishModuleLoads() {
  console.log('\n=== PUBLISH: module loads ===');

  const pub = require('./publish');
  assert(typeof pub.publishToAll === 'function', 'publishToAll exported');
  assert(typeof pub.publishInstagram === 'function', 'publishInstagram exported');
  assert(typeof pub.publishTikTok === 'function', 'publishTikTok exported');
  assert(typeof pub.publishYouTube === 'function', 'publishYouTube exported');
}

async function testPublishGracefulSkip() {
  console.log('\n=== PUBLISH: graceful skip (no credentials) ===');

  const pub = require('./publish');

  // Should return null for each platform when no credentials
  const origIG = process.env.INSTAGRAM_ACCESS_TOKEN;
  const origTT = process.env.TIKTOK_ACCESS_TOKEN;
  const origYT = process.env.YOUTUBE_CLIENT_ID;
  delete process.env.INSTAGRAM_ACCESS_TOKEN;
  delete process.env.TIKTOK_ACCESS_TOKEN;
  delete process.env.YOUTUBE_CLIENT_ID;

  const igResult = await pub.publishInstagram('http://test.com/video.mp4', 'test');
  assert(igResult === null, 'Instagram returns null without credentials');

  const ttResult = await pub.publishTikTok('http://test.com/video.mp4', 'test');
  assert(ttResult === null, 'TikTok returns null without credentials');

  const ytResult = await pub.publishYouTube('http://test.com/video.mp4', 'test', 'test');
  assert(ytResult === null, 'YouTube returns null without credentials');

  // Restore
  if (origIG) process.env.INSTAGRAM_ACCESS_TOKEN = origIG;
  if (origTT) process.env.TIKTOK_ACCESS_TOKEN = origTT;
  if (origYT) process.env.YOUTUBE_CLIENT_ID = origYT;
}

// ─── Full pipeline test (all APIs) ─────────────────────────────────────

async function testFullContentPipeline() {
  console.log('\n=== FULL CONTENT PIPELINE (all APIs) ===');

  const hasEL = !!process.env.ELEVENLABS_API_KEY;
  const hasHG = !!process.env.HEYGEN_API_KEY;
  const hasAA = !!process.env.ASSEMBLYAI_API_KEY;

  if (!hasEL || !hasHG || !hasAA) {
    console.log(`  SKIP: need ELEVENLABS_API_KEY=${hasEL}, HEYGEN_API_KEY=${hasHG}, ASSEMBLYAI_API_KEY=${hasAA}`);
    return;
  }

  const { generateVoice } = require('./voice');
  const { generateAvatar } = require('./avatar');
  const { generateCaptions } = require('./captions');
  const { composeVideo } = require('./compose');
  const { publishToAll } = require('./publish');

  const script = "Stop. Before you sign that offer to purchase, let me show you what the agent won't tell you. This house looks perfect on the outside. But Surepath found three issues that could cost you over eighty-five thousand rand. Get the facts before you buy. Surepath dot co dot z a.";

  console.log('  Step 1: Voice generation...');
  const audioUrl = await generateVoice(script);
  assert(typeof audioUrl === 'string', `audio: ${audioUrl}`);

  console.log('  Step 2: Avatar video...');
  const avatarUrl = await generateAvatar(audioUrl);
  assert(typeof avatarUrl === 'string', `avatar: ${avatarUrl}`);

  console.log('  Step 3: Captions...');
  const { srt_content } = await generateCaptions(audioUrl);
  assert(typeof srt_content === 'string', `SRT: ${srt_content.length} chars`);

  console.log('  Step 4: Compose final...');
  const finalUrl = await composeVideo(avatarUrl, srt_content, null, `test_${Date.now()}`);
  assert(typeof finalUrl === 'string', `final: ${finalUrl}`);

  console.log('  Step 5: Publish...');
  const pubResult = await publishToAll(finalUrl, "Surepath test post — delete after testing", null);
  assert(typeof pubResult === 'object', 'publish returns object');

  console.log('\n  --- Pipeline complete ---');
  console.log(`  Audio: ${audioUrl}`);
  console.log(`  Avatar: ${avatarUrl}`);
  console.log(`  Final: ${finalUrl}`);
  console.log(`  Published: ${JSON.stringify(pubResult)}`);
}

// ─── Run ───────────────────────────────────────────────────────────────

async function run() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  SUREPATH CONTENT PIPELINE TESTS             ║');
  console.log('╚══════════════════════════════════════════════╝');

  console.log(`\nEnvironment:`);
  console.log(`  ELEVENLABS_API_KEY:  ${process.env.ELEVENLABS_API_KEY ? 'SET' : 'NOT SET'}`);
  console.log(`  HEYGEN_API_KEY:      ${process.env.HEYGEN_API_KEY ? 'SET' : 'NOT SET'}`);
  console.log(`  ASSEMBLYAI_API_KEY:  ${process.env.ASSEMBLYAI_API_KEY ? 'SET' : 'NOT SET'}`);
  console.log(`  AWS_S3_BUCKET:       ${process.env.AWS_S3_BUCKET ? 'SET' : 'NOT SET'}`);
  console.log(`  INSTAGRAM tokens:    ${process.env.INSTAGRAM_ACCESS_TOKEN ? 'SET' : 'NOT SET'}`);
  console.log(`  TIKTOK token:        ${process.env.TIKTOK_ACCESS_TOKEN ? 'SET' : 'NOT SET'}`);
  console.log(`  YOUTUBE tokens:      ${process.env.YOUTUBE_CLIENT_ID ? 'SET' : 'NOT SET'}`);

  // Unit tests (always run)
  await testEstimateDuration();
  await testFormatSRTTime();
  await testWordsToSRT();
  await testWriteSRTToTemp();
  await testFFmpegAvailable();
  await testPublishModuleLoads();
  await testPublishGracefulSkip();

  // Integration tests (need FFmpeg)
  await testComposeOffline();

  // Live API tests
  await testLiveVoice();
  await testLiveCaptions();
  await testFullContentPipeline();

  console.log('\n══════════════════════════════════════════════');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════\n');

  const pool = require('./db');
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
