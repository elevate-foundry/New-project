export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export function assert(condition, status, code, message) {
  if (!condition) {
    throw new AppError(status, code, message);
  }
}
