import { ChildProcess } from 'node:child_process';

interface Stoppable {
  stop(): Promise<void>;
}

const spawnedProcesses: ChildProcess[] = [];
const stoppableServers: Stoppable[] = [];

export function registerProcess(process: ChildProcess) {
  spawnedProcesses.push(process);
}

export function registerServer(server: Stoppable) {
  stoppableServers.push(server);
}

export async function cleanupAll() {
  const killPromises = spawnedProcesses.map((cp) => {
    if (cp.killed || cp.exitCode !== null) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        cp.kill('SIGKILL');
        resolve();
      }, 5000);

      cp.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      cp.kill('SIGTERM');
    });
  });

  const serverPromises = stoppableServers.map((s) => s.stop().catch(() => {}));

  await Promise.all([...killPromises, ...serverPromises]);
  spawnedProcesses.length = 0;
  stoppableServers.length = 0;
}
