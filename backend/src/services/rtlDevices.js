const { spawn } = require('child_process');
const logger = require('../utils/logger');

// rtl_test prints its "Found N device(s):" header purely from USB descriptor reads
// (rtlsdr_get_device_count/usb_strings) before it ever tries to claim a device exclusively —
// so this is safe to run even while other dongles are actively streaming via rtl_fm/rtl_airband.
// Passing a deliberately out-of-range device index makes it fail fast trying to open THAT
// device afterward, without ever touching a real/in-use one. Output format assumed to look
// like "  0:  Realtek, RTL2838UHIDIR, SN: 00000001" — verify against real hardware; unmatched
// lines are just skipped, not fatal, so a format drift degrades to an empty list rather than
// throwing.
const ENUM_DEVICE_INDEX = 999;
const ENUM_TIMEOUT_MS   = 3000;
const DEVICE_LINE_RE    = /^\s*(\d+):\s*(.+?),\s*(.+?),\s*SN:\s*(\S+)/;

function parseDeviceList(output) {
  const list = [];
  for (const line of output.split('\n')) {
    const m = DEVICE_LINE_RE.exec(line);
    if (m) list.push({ index: Number(m[1]), vendor: m[2].trim(), product: m[3].trim(), serial: m[4].trim() });
  }
  return list;
}

function listAttachedDongles() {
  return new Promise(resolve => {
    let output = '';
    let done = false;
    let proc;
    try {
      proc = spawn('rtl_test', ['-d', String(ENUM_DEVICE_INDEX)]);
    } catch (e) {
      logger.warn(`rtl_test spawn failed: ${e.message}`);
      resolve([]);
      return;
    }

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolve(parseDeviceList(output));
    };

    const timer = setTimeout(finish, ENUM_TIMEOUT_MS);
    const onData = d => { output += d.toString(); };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData); // rtl_test writes its device list to stderr on some builds
    proc.on('exit', finish);
    proc.on('error', e => { logger.warn(`rtl_test error: ${e.message}`); finish(); });
  });
}

async function resolveDeviceIndex(serial) {
  if (!serial) return null;
  const list  = await listAttachedDongles();
  const match = list.find(d => d.serial === serial);
  return match ? match.index : null;
}

module.exports = { listAttachedDongles, resolveDeviceIndex };
