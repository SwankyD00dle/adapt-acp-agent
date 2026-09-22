export class BridgeStateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeStateError";
    this.code = code;
  }
}
