import { ChildProcess } from 'node:child_process';

const spawnedProcesses: ChildProcess[] = [];

export function registerProcess(process: ChildProcess) {
  spawnedProcesses.push(process);
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

  await Promise.all(killPromises);
  spawnedProcesses.length = 0;
}
