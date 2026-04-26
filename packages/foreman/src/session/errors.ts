export class SessionLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`Session limit reached (${limit})`);
    this.name = 'SessionLimitError';
  }
}
