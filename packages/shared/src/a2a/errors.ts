export class A2AError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'A2AError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TaskNotFoundError extends A2AError {
  readonly taskId: string;

  constructor(taskId: string) {
    super('TASK_NOT_FOUND', `Task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
    this.taskId = taskId;
  }
}

export class DispatchFailedError extends A2AError {
  readonly agentUrl: string;
  readonly reason: string;

  constructor(agentUrl: string, reason: string) {
    super('DISPATCH_FAILED', `Failed to dispatch task to ${agentUrl}: ${reason}`);
    this.name = 'DispatchFailedError';
    this.agentUrl = agentUrl;
    this.reason = reason;
  }
}

export class PermissionTimeoutError extends A2AError {
  readonly taskId: string;
  readonly requestId: string;

  constructor(taskId: string, requestId: string) {
    super('PERMISSION_TIMEOUT', `Permission request ${requestId} timed out for task ${taskId}`);
    this.name = 'PermissionTimeoutError';
    this.taskId = taskId;
    this.requestId = requestId;
  }
}

export class AgentCardValidationError extends A2AError {
  readonly agentUrl: string;
  readonly validationMessage: string;

  constructor(agentUrl: string, validationMessage: string) {
    super('AGENT_CARD_VALIDATION', `Agent card validation failed for ${agentUrl}: ${validationMessage}`);
    this.name = 'AgentCardValidationError';
    this.agentUrl = agentUrl;
    this.validationMessage = validationMessage;
  }
}
