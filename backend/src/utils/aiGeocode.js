'use strict';

const { getSetting, setSetting } = require('../services/database');
const logger = require('./logger');

// ── Config ────────────────────────────────────────────────────────────────────
function getConfig() {
  const saved = getSetting('ai_geocode', {});
  return {
    provider:     saved.provider    || 'none',   // 'groq' | 'openai' | 'ollama' | 'none'
    groqKey:      process.env.GROQ_API_KEY    || saved.groqKey    || '',
    groqModel:    saved.groqModel   || 'llama-3.1-8b-instant',
    openaiKey:    process.env.OPENAI_API_KEY  || saved.openaiKey  || '',
    openaiModel:  saved.openaiModel || 'gpt-4o-mini',
    ollamaUrl:    saved.ollamaUrl   || 'http://localhost:11434',
    ollamaModel:  saved.ollamaModel || 'llama3.2:1b',
  };
}

function saveConfig(incoming) {
  const existing = getSetting('ai_geocode', {});
  const cfg = { ...existing, ...incoming };
  // Keys are never round-tripped to the frontend, so the only way they arrive
  // non-empty is when the user explicitly typed a new one. Empty → keep existing.
  // Trim whitespace — copy-pasted keys often have a trailing space or newline.
  if (incoming.groqKey?.trim())   cfg.groqKey   = incoming.groqKey.trim();
  else                             cfg.groqKey   = existing.groqKey   || '';
  if (incoming.openaiKey?.trim()) cfg.openaiKey = incoming.openaiKey.trim();
  else                             cfg.openaiKey = existing.openaiKey || '';
  setSetting('ai_geocode', cfg);
}

// ── Prompt ────────────────────────────────────────────────────────────────────
// Addresses appear in the first part of the message; truncate long payloads to
// save tokens and avoid sending unnecessary content to cloud providers.
const MAX_MSG_CHARS = 350;

const COUNTRY_NAMES = {
  si:'Slovenia', de:'Germany', at:'Austria', it:'Italy', fr:'France',
  gb:'United Kingdom', nl:'Netherlands', be:'Belgium', ch:'Switzerland',
  pl:'Poland', cz:'Czech Republic', sk:'Slovakia', hu:'Hungary',
  hr:'Croatia', rs:'Serbia', ba:'Bosnia and Herzegovina',
  us:'United States', ca:'Canada', au:'Australia', nz:'New Zealand',
};

const PROMPT = (text, countryCode = 'si') => {
  const snippet = text.length > MAX_MSG_CHARS ? text.slice(0, MAX_MSG_CHARS) + '…' : text;
  const country = COUNTRY_NAMES[countryCode] || countryCode.toUpperCase();
  return `Extract the street address from this emergency pager message from ${country}.
Return ONLY valid JSON with these exact keys: {"street":"...","houseNumber":"...","settlement":"..."}
Use null for any missing field. settlement = city, town or village name only, never the street name.
Ignore incident description words (fire, accident, rescue, emergency, alarm, dispatch, and equivalents in the local language).
Preserve all special characters (accents, diacritics, etc.) exactly as they appear.

Message: ${snippet}`;
};

// ── Groq ──────────────────────────────────────────────────────────────────────
async function _fromGroq(text, cfg, countryCode) {
  if (!cfg.groqKey) return null;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.groqKey}` },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        model: cfg.groqModel,
        messages: [{ role: 'user', content: PROMPT(text, countryCode) }],
        max_tokens: 120,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) { logger.warn(`AI geocode Groq HTTP ${res.status}`); return null; }
    const data = await res.json();
    const raw  = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) { logger.warn(`AI geocode Groq: ${e.message}`); return null; }
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function _fromOpenAI(text, cfg, countryCode) {
  if (!cfg.openaiKey) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.openaiKey}` },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        model: cfg.openaiModel,
        messages: [{ role: 'user', content: PROMPT(text, countryCode) }],
        max_tokens: 120,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) { logger.warn(`AI geocode OpenAI HTTP ${res.status}`); return null; }
    const data = await res.json();
    const raw  = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) { logger.warn(`AI geocode OpenAI: ${e.message}`); return null; }
}

// ── Ollama ────────────────────────────────────────────────────────────────────
async function _fromOllama(text, cfg, countryCode) {
  try {
    const res = await fetch(`${cfg.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),   // RPi can be slow — allow extra time
      body: JSON.stringify({
        model:  cfg.ollamaModel,
        stream: false,
        format: 'json',
        prompt: PROMPT(text, countryCode),
      }),
    });
    if (!res.ok) { logger.warn(`AI geocode Ollama HTTP ${res.status}`); return null; }
    const data = await res.json();
    const raw  = (data.response || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) { logger.warn(`AI geocode Ollama: ${e.message}`); return null; }
}

// ── Public API ────────────────────────────────────────────────────────────────
async function extractAddress(text, countryCode = 'si') {
  const cfg = getConfig();
  if (cfg.provider === 'groq')   return _fromGroq(text, cfg, countryCode);
  if (cfg.provider === 'openai') return _fromOpenAI(text, cfg, countryCode);
  if (cfg.provider === 'ollama') return _fromOllama(text, cfg, countryCode);
  return null;
}

async function checkStatus() {
  const cfg = getConfig();
  const status = {
    provider:     cfg.provider,
    groqModel:    cfg.groqModel,
    openaiModel:  cfg.openaiModel,
    ollamaUrl:    cfg.ollamaUrl,
    ollamaModel:  cfg.ollamaModel,
    groqKeySource:   process.env.GROQ_API_KEY   ? 'env' : (cfg.groqKey   ? 'db' : 'none'),
    openaiKeySource: process.env.OPENAI_API_KEY ? 'env' : (cfg.openaiKey ? 'db' : 'none'),
  };

  if (cfg.provider === 'groq') {
    if (!cfg.groqKey) { status.connected = false; status.error = 'No API key configured'; return status; }
    // Use the same chat-completions endpoint as real extraction — the /models list
    // endpoint returns 401 on some free-tier Groq accounts even with a valid key.
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.groqKey}` },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          model: cfg.groqModel,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          temperature: 0,
        }),
      });
      status.connected = res.ok;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        status.error = body?.error?.message || `HTTP ${res.status} — check your API key`;
      } else {
        // Bonus: fetch available chat models for the UI dropdown.
        // Optional — failure here does not affect connected status.
        try {
          const mRes = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { 'Authorization': `Bearer ${cfg.groqKey}` },
            signal: AbortSignal.timeout(5000),
          });
          if (mRes.ok) {
            const mData = await mRes.json();
            status.availableModels = (mData.data || [])
              .map(m => m.id)
              .filter(id => !/(whisper|guard|distil)/i.test(id))
              .sort();
          }
        } catch (_) {}
      }
    } catch (e) { status.connected = false; status.error = e.message; }

  } else if (cfg.provider === 'openai') {
    if (!cfg.openaiKey) { status.connected = false; status.error = 'No API key configured'; return status; }
    // Use chat completions for the probe — same endpoint as real extraction.
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.openaiKey}` },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          model: cfg.openaiModel,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          temperature: 0,
        }),
      });
      status.connected = res.ok;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        status.error = body?.error?.message || `HTTP ${res.status} — check your API key`;
      } else {
        // Bonus: fetch available chat models for the UI dropdown.
        try {
          const mRes = await fetch('https://api.openai.com/v1/models', {
            headers: { 'Authorization': `Bearer ${cfg.openaiKey}` },
            signal: AbortSignal.timeout(5000),
          });
          if (mRes.ok) {
            const mData = await mRes.json();
            status.availableModels = (mData.data || [])
              .map(m => m.id)
              // Keep only chat-capable models; exclude audio, image, embedding, etc.
              .filter(id => /^(gpt-|o[0-9])/.test(id))
              .filter(id => !/(audio|realtime|instruct|search|embedding|moderation|dall|whisper|tts)/.test(id))
              .sort();
          }
        } catch (_) {}
      }
    } catch (e) { status.connected = false; status.error = e.message; }

  } else if (cfg.provider === 'ollama') {
    try {
      const res = await fetch(`${cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const models = (data.models || []).map(m => m.name);
        status.connected      = true;
        status.ollamaModels   = models;
        status.modelInstalled = models.some(m => m.startsWith(cfg.ollamaModel.split(':')[0]));
      } else { status.connected = false; status.error = `HTTP ${res.status}`; }
    } catch (e) { status.connected = false; status.error = 'Ollama not reachable — is it running? ' + e.message; }

  } else {
    status.connected = false;
  }

  return status;
}

module.exports = { extractAddress, getConfig, saveConfig, checkStatus };
