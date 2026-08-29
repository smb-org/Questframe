import { createApiError, type ApiErrorCode } from "../shared/contracts/api";

export const jsonResponse = (value: unknown, status = 200, headers?: HeadersInit): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-content-type-options", "nosniff");
  return Response.json(value, { status, headers: responseHeaders });
};

export const errorResponse = (
  status: number,
  code: ApiErrorCode,
  message: string,
  details: Parameters<typeof createApiError>[2] = {},
): Response => jsonResponse(createApiError(code, message, details), status);

export const readJson = async (request: Request, maximumBytes = 65_536): Promise<unknown> => {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    throw new RequestError(413, "payload_too_large", "Die Anfrage ist zu groß.");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new RequestError(413, "payload_too_large", "Die Anfrage ist zu groß.");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new RequestError(400, "bad_request", "Ungültiges JSON.");
  }
};

export class RequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: Parameters<typeof createApiError>[2];

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    details: Parameters<typeof createApiError>[2] = {},
  ) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
