const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL  = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 1;

const COLORS = { debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET  = '\x1b[0m';

function log(level, msg) {
  if (LEVELS[level] < LEVEL) return;
  const ts  = new Date().toISOString();
  const col = COLORS[level] || '';
  process.stdout.write(`${col}[${ts}] [${level.toUpperCase()}]${RESET} ${msg}\n`);
}

module.exports = {
  debug: (m) => log('debug', m),
  info:  (m) => log('info',  m),
  warn:  (m) => log('warn',  m),
  error: (m) => log('error', m),
};
