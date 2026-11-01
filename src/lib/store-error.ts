export class StoreError extends Error {
  constructor(
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
    this.name = "StoreError";
  }
}
