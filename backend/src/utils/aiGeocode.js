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
  if (!incoming.groqKey)   cfg.groqKey   = existing.groqKey   || '';
  if (!incoming.openaiKey) cfg.openaiKey = existing.openaiKey || '';
  setSetting('ai_geocode', cfg);
}

// ── Prompt ────────────────────────────────────────────────────────────────────
const PROMPT = (text) =>
  `Extract the address from this Slovenian emergency pager message.
Return ONLY valid JSON with these exact keys: {"street":"...","houseNumber":"...","settlement":"..."}
Use null for any missing field. settlement = city or village name only, never the street.
Ignore incident description words (požar/fire, nesreča/accident, stiska/distress, dihalna/respiratory, intervencija, gasilci, etc.)
Preserve Slovenian characters (š, č, ž, etc.) exactly.

Message: ${text}`;

// ── Groq ──────────────────────────────────────────────────────────────────────
async function _fromGroq(text, cfg) {
  if (!cfg.groqKey) return null;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.groqKey}` },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        model: cfg.groqModel,
        messages: [{ role: 'user', content: PROMPT(text) }],
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
async function _fromOpenAI(text, cfg) {
  if (!cfg.openaiKey) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.openaiKey}` },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        model: cfg.openaiModel,
        messages: [{ role: 'user', content: PROMPT(text) }],
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
async function _fromOllama(text, cfg) {
  try {
    const res = await fetch(`${cfg.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),   // RPi can be slow — allow extra time
      body: JSON.stringify({
        model:  cfg.ollamaModel,
        stream: false,
        format: 'json',
        prompt: PROMPT(text),
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
async function extractAddress(text) {
  const cfg = getConfig();
  if (cfg.provider === 'groq')   return _fromGroq(text, cfg);
  if (cfg.provider === 'openai') return _fromOpenAI(text, cfg);
  if (cfg.provider === 'ollama') return _fromOllama(text, cfg);
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
    try {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${cfg.groqKey}` },
        signal: AbortSignal.timeout(5000),
      });
      status.connected = res.ok;
      if (!res.ok) status.error = `HTTP ${res.status} — check your API key`;
    } catch (e) { status.connected = false; status.error = e.message; }

  } else if (cfg.provider === 'openai') {
    if (!cfg.openaiKey) { status.connected = false; status.error = 'No API key configured'; return status; }
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${cfg.openaiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      status.connected = res.ok;
      if (!res.ok) status.error = `HTTP ${res.status} — check your API key`;
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
