/**
 * Generate SRT captions from script text + audio duration.
 * No external API needed — we already have the words.
 * Distributes words evenly across the audio duration.
 */

function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

function formatSRTTime(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)},${pad3(millis)}`;
}

/**
 * Generate SRT content from script text and audio duration.
 *
 * @param {string} scriptText - The full script text
 * @param {number} durationSec - Audio duration in seconds
 * @param {number} [wordsPerLine=4] - Words per caption line
 * @returns {string} SRT formatted captions
 */
function generateCaptions(scriptText, durationSec, wordsPerLine = 4) {
  const words = scriptText.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';

  const totalMs = durationSec * 1000;
  const msPerWord = totalMs / words.length;

  const lines = [];
  let lineIndex = 1;

  for (let i = 0; i < words.length; i += wordsPerLine) {
    const chunk = words.slice(i, i + wordsPerLine);
    const startMs = Math.round(i * msPerWord);
    const endMs = Math.round(Math.min((i + chunk.length) * msPerWord, totalMs));
    const text = chunk.join(' ');

    lines.push(`${lineIndex}`);
    lines.push(`${formatSRTTime(startMs)} --> ${formatSRTTime(endMs)}`);
    lines.push(text);
    lines.push('');
    lineIndex++;
  }

  return lines.join('\n');
}

module.exports = { generateCaptions, formatSRTTime };
