export class StoryBankError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'StoryBankError';
    this.code = code;
    this.status = status;
  }
}

export function fail(code, message, status) {
  throw new StoryBankError(code, message, status);
}
