import { HttpException } from "@nestjs/common";

/** Wraps a domain result's `{ statusCode, error }` into a throwable HttpException. */
export class HttpErrorFromResult extends HttpException {
  constructor(statusCode: number, error: string) {
    super({ error }, statusCode);
  }
}
