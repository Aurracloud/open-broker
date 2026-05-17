import { spawn, type ChildProcess } from 'child_process';

type KeepAwakeLogger = {
  info(message: string): void;
  warn(message: string): void;
};

export interface KeepAwakeHandle {
  backend: string;
  stop(): void;
}

function createHandle(
  child: ChildProcess,
  backend: string,
  log: KeepAwakeLogger,
): KeepAwakeHandle {
  let stopping = false;

  child.once('error', (error) => {
    if (!stopping) {
      log.warn(`keep-awake unavailable via ${backend}: ${error.message}`);
    }
  });

  child.once('exit', (code, signal) => {
    if (!stopping) {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      log.warn(`keep-awake helper ${backend} exited unexpectedly (${suffix}); host may sleep.`);
    }
  });

  return {
    backend,
    stop() {
      stopping = true;
      if (!child.killed) child.kill();
    },
  };
}

function startDarwin(log: KeepAwakeLogger): KeepAwakeHandle {
  const child = spawn('caffeinate', ['-i', '-w', String(process.pid)], {
    stdio: 'ignore',
  });
  return createHandle(child, 'caffeinate', log);
}

function startLinux(reason: string, log: KeepAwakeLogger): KeepAwakeHandle {
  const child = spawn(
    'systemd-inhibit',
    [
      '--what=sleep',
      '--who=OpenBroker',
      `--why=${reason}`,
      '--mode=block',
      'sh',
      '-c',
      'while kill -0 "$1" 2>/dev/null; do sleep 30; done',
      'sh',
      String(process.pid),
    ],
    { stdio: 'ignore' },
  );
  return createHandle(child, 'systemd-inhibit', log);
}

function startWindows(log: KeepAwakeLogger): KeepAwakeHandle {
  const script = [
    'Add-Type -Namespace OpenBroker -Name Native -MemberDefinition',
    '\'"[DllImport(\\\"kernel32.dll\\\")] public static extern uint SetThreadExecutionState(uint esFlags);"\';',
    '[OpenBroker.Native]::SetThreadExecutionState(0x80000001) | Out-Null;',
    `Wait-Process -Id ${process.pid};`,
    '[OpenBroker.Native]::SetThreadExecutionState(0x80000000) | Out-Null;',
  ].join(' ');

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  return createHandle(child, 'SetThreadExecutionState', log);
}

export function startKeepAwake(reason: string, log: KeepAwakeLogger): KeepAwakeHandle | null {
  switch (process.platform) {
    case 'darwin':
      return startDarwin(log);
    case 'linux':
      return startLinux(reason, log);
    case 'win32':
      return startWindows(log);
    default:
      log.warn(`keep-awake is not supported on platform ${process.platform}; host may sleep.`);
      return null;
  }
}
