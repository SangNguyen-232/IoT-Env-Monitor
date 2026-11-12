'use strict';

const UINT32_MAX = 0xffffffff;
const TELEMETRY_FIELDS = new Set([
  'timestamp_real', 'timestamp_up', 'temperature', 'humidity', 'soil_moisture',
  'FAN_state', 'MODE_state', 'Message', 'Score', 'device_id', 'lan_ip', 'latency', 'trigger_source',
  'boot_id', 'sample_seq', 'sampled_uptime_ms', 'ai', 'fan_reason', 'fan_config',
  'fan_decision_sample_seq', 'fan_decided_uptime_ms'
]);
const AI_FIELDS = new Set([
  'model_version', 'status', 'sample_seq', 'sampled_uptime_ms', 'predicted_class',
  'probabilities', 'inference_ms', 'rule_class', 'agreement_pct', 'evaluated_samples'
]);
const FAN_CONFIG_FIELDS = new Set([
  'configured', 'activation_logic', 'temperature_on', 'temperature_off', 'humidity_on', 'humidity_off'
]);
const AI_STATUSES = new Set([
  'loading', 'ready', 'sensor_invalid', 'out_of_domain', 'inference_error', 'model_error', 'stale'
]);
const FAN_CLASSES = ['OFF', 'HOLD', 'ON'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUint32 = value => Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;
const finiteInRange = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const exactFields = (value, fields) => isObject(value) && Object.keys(value).length === fields.size &&
  Object.keys(value).every(key => fields.has(key));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(value);

function validAi(ai) {
  if (ai == null) return true;
  if (!exactFields(ai, AI_FIELDS) || typeof ai.model_version !== 'string' || ai.model_version.length < 1 ||
      ai.model_version.length > 64 || /[\u0000-\u001f\u007f]/.test(ai.model_version) || !AI_STATUSES.has(ai.status) ||
      !isUint32(ai.sample_seq) || !isUint32(ai.sampled_uptime_ms) || !isUint32(ai.evaluated_samples) ||
      !finiteInRange(ai.inference_ms, 0, Number.MAX_VALUE) ||
      (ai.rule_class !== null && !FAN_CLASSES.includes(ai.rule_class)) ||
      (ai.agreement_pct !== null && !finiteInRange(ai.agreement_pct, 0, 100)) ||
      (ai.evaluated_samples === 0 && ai.agreement_pct !== null) ||
      (ai.evaluated_samples > 0 && ai.agreement_pct === null)) return false;

  if (ai.status !== 'ready') return ai.predicted_class === null && ai.probabilities === null;
  if (!FAN_CLASSES.includes(ai.predicted_class) || !Array.isArray(ai.probabilities) || ai.probabilities.length !== 3 ||
      !ai.probabilities.every(value => finiteInRange(value, 0, 1))) return false;
  // Softmax floats are rounded by firmware JSON serialization; tolerate that rounding.
  const total = ai.probabilities.reduce((sum, value) => sum + value, 0);
  const selected = ai.probabilities[FAN_CLASSES.indexOf(ai.predicted_class)];
  return Math.abs(total - 1) <= 0.002 && selected + 0.000001 >= Math.max(...ai.probabilities);
}

function validFanConfig(config) {
  if (config == null) return true;
  if (!exactFields(config, FAN_CONFIG_FIELDS) || typeof config.configured !== 'boolean' ||
      !['any', 'all'].includes(config.activation_logic)) return false;
  const thresholds = ['temperature_on', 'temperature_off', 'humidity_on', 'humidity_off'];
  if (!config.configured) return thresholds.every(key => config[key] === null);
  return finiteInRange(config.temperature_on, -40, 80) && finiteInRange(config.temperature_off, -40, 80) &&
    finiteInRange(config.humidity_on, 0, 100) && finiteInRange(config.humidity_off, 0, 100) &&
    config.temperature_off < config.temperature_on && config.humidity_off < config.humidity_on;
}

function validExperimentFields(body) {
  return (body.boot_id == null || identifier(body.boot_id)) &&
    (body.sample_seq == null || isUint32(body.sample_seq)) &&
    (body.sampled_uptime_ms == null || isUint32(body.sampled_uptime_ms)) &&
    (body.fan_decision_sample_seq == null || isUint32(body.fan_decision_sample_seq)) &&
    (body.fan_decided_uptime_ms == null || isUint32(body.fan_decided_uptime_ms)) &&
    (body.fan_reason == null || identifier(body.fan_reason)) && validAi(body.ai) && validFanConfig(body.fan_config) &&
    (body.ai == null || body.ai.status !== 'ready' ||
      (isUint32(body.sample_seq) && isUint32(body.sampled_uptime_ms) &&
        body.ai.sample_seq === body.sample_seq && body.ai.sampled_uptime_ms === body.sampled_uptime_ms));
}

// These are INTEGER identity cursors, never offsets. Reject query arrays/objects
// and coercions such as exponents, whitespace or negative numbers.
function parseCursor(value, defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,9})$/.test(value)) return null;
  const number = Number(value);
  return number <= 2147483647 ? number : null;
}

function parseInstant(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  // Date.parse accepts rollover dates (e.g. February 30), so validate the local
  // calendar components separately before accepting a query boundary.
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day ||
      hour > 23 || minute > 59 || second > 59) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const instant = new Date(timestamp);
  return instant.getUTCFullYear() >= 1 && instant.getUTCFullYear() <= 9999 ? instant.toISOString() : null;
}

function parseHistoryQuery(query) {
  const allowed = new Set(['device_id', 'lan_ip', 'from', 'to', 'after_id', 'until_id', 'limit']);
  if (Object.keys(query).some(key => !allowed.has(key)) || !identifier(query.device_id)) return null;
  let lanIp = null;
  if (query.lan_ip !== undefined) {
    if (typeof query.lan_ip !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(query.lan_ip) ||
        query.lan_ip.split('.').some(part => Number(part) > 255)) return null;
    lanIp = query.lan_ip;
  }
  const afterId = parseCursor(query.after_id, 0);
  const untilId = parseCursor(query.until_id, undefined);
  const limit = parseCursor(query.limit, 500);
  const from = parseInstant(query.from);
  const to = parseInstant(query.to);
  if (afterId === null || untilId === null || limit === null || limit < 1 || limit > 1000 ||
      from === null || to === null || (from && to && from >= to) ||
      (afterId > 0 && untilId === undefined) || (untilId !== undefined && afterId > untilId)) return null;
  return { deviceId: query.device_id, lanIp, afterId, untilId, limit, from: from || null, to: to || null };
}

module.exports = { TELEMETRY_FIELDS, validAi, validFanConfig, validExperimentFields, parseHistoryQuery };
