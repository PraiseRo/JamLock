// Graceful shutdown for PaaS deploys (Render/Railway/Koyeb send SIGTERM).
// Socket.IO is closed first so long-lived WebSocket connections do not hold the
// HTTP server open, with a hard timeout so a stuck connection cannot block exit.

export function createGracefulShutdown({
  io,
  timeoutMs = 5000,
  exit = (code = 0) => process.exit(code),
  log = console
} = {}) {
  let shuttingDown = false;

  return function shutdown(signal = 'shutdown') {
    if (shuttingDown) return false;
    shuttingDown = true;
    log.log(`[server] ${signal} received; closing connections...`);

    let finished = false;
    const finish = (code = 0) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      exit(code);
    };

    const timer = setTimeout(() => {
      log.warn('[server] Forced exit after shutdown timeout');
      finish(0);
    }, timeoutMs);
    timer.unref?.();

    try {
      io.close(() => finish(0));
    } catch (e) {
      finish(0);
    }
    return true;
  };
}
