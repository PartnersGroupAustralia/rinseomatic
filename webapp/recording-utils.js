/**
 * @fileoverview Recording utilities for Sitchomatic Web.
 * Provides helpers for creating recording artifacts, formatting file sizes,
 * generating recordings button labels, and sanitising filename components.
 */

/**
 * Generates a fallback recording ID when crypto.randomUUID is unavailable.
 * @returns {string} A pseudo-unique ID string.
 */
function fallbackId() {
  return `rec_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * Sanitises a string so it is safe to use as part of a filename.
 * Replaces any character that is not alphanumeric, dot, underscore, or hyphen
 * with an underscore, strips leading/trailing underscores, and truncates to 64 chars.
 * @param {*} v - The value to sanitise (will be coerced to string).
 * @returns {string} Sanitised filename-safe string, never empty (falls back to 'item').
 */
export function sanitizeFilenamePart(v) {
  return String(v || '').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'item';
}

/**
 * Formats a byte count into a human-readable string (B, KB, MB, GB).
 * @param {number} n - Number of bytes.
 * @returns {string} Formatted string such as "1.2 MB".
 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, idx);
  return `${v.toFixed(v >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

/**
 * Returns the label string for the recordings button in the Sessions tab.
 * Shows the count of recordings currently stored.
 * @param {Array} recordings - Array of recording artifact objects.
 * @returns {string} Button label, e.g. "🎥 Recordings (3)".
 */
export function getRecordingsButtonLabel(recordings) {
  const count = Array.isArray(recordings) ? recordings.length : 0;
  return `🎥 Recordings (${count})`;
}

/**
 * Creates a standardised recording artifact object from raw recording data.
 * Ensures all required fields are present and correctly typed.
 * @param {object} opts - Recording parameters.
 * @param {string} opts.runType - Identifier for the run type ('ppsr', 'joe', 'ign').
 * @param {string} opts.label - Human-readable label for the recording.
 * @param {string} [opts.reason='completed'] - How the run ended ('completed' | 'stopped').
 * @param {number} [opts.durationMs=0] - Duration of the recording in milliseconds.
 * @param {number} [opts.sizeBytes=0] - File size of the recording blob in bytes.
 * @param {string} [opts.mimeType='video/webm'] - MIME type of the recording.
 * @param {string} opts.blobUrl - Object URL for the recording blob.
 * @param {number} [opts.createdTs] - Unix timestamp when recording was created.
 * @param {string} [opts.id] - Explicit UUID; auto-generated if omitted.
 * @param {string} [opts.filename] - Explicit filename; auto-generated if omitted.
 * @returns {object} Standardised recording artifact ready to push into state.recordings.
 */
export function createRecordingArtifact({
  runType,
  label,
  reason = 'completed',
  durationMs = 0,
  sizeBytes = 0,
  mimeType = 'video/webm',
  blobUrl,
  createdTs = Date.now(),
  id,
  filename,
}) {
  const safeRunType = sanitizeFilenamePart(runType || 'run');
  const created = Number.isFinite(createdTs) ? createdTs : Date.now();
  const stamp = new Date(created).toISOString().replace(/[:.]/g, '-');
  const resolvedId = id || globalThis.crypto?.randomUUID?.() || fallbackId();
  return {
    id: resolvedId,
    ts: created,
    runType: runType || 'run',
    label: label || 'Run Recording',
    reason,
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
    mimeType,
    filename: filename || `sitchomatic_run_${safeRunType}_${stamp}.webm`,
    blobUrl,
  };
}
