export class ACPError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ACPError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SubprocessCrashedError extends ACPError {
  readonly subprocessId: string;
  readonly exitCode: number | null;

  constructor(subprocessId: string, exitCode: number | null) {
    super(
      'SUBPROCESS_CRASHED',
      `Subprocess ${subprocessId} crashed with exit code ${exitCode ?? 'null'}`,
    );
    this.name = 'SubprocessCrashedError';
    this.subprocessId = subprocessId;
    this.exitCode = exitCode;
  }
}

export class ProtocolViolationError extends ACPError {
  readonly detail: string;

  constructor(detail: string) {
    super('PROTOCOL_VIOLATION', `ACP protocol violation: ${detail}`);
    this.name = 'ProtocolViolationError';
    this.detail = detail;
  }
}

export class SessionNotFoundError extends ACPError {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super('SESSION_NOT_FOUND', `ACP session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}
