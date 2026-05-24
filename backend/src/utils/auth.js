const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) {
    return challenge(res);
  }
  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  if (user === AUTH_USER && pass === AUTH_PASS) return next();
  return challenge(res);
}

function challenge(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="PagerMonitor"');
  res.status(401).json({ error: 'Unauthorized' });
}

module.exports = authMiddleware;
