import type { Fetcher } from "./types.ts";

export class MonitorError extends Error {
  public code: string;
  public retryAfterMs: number;
  constructor(code: string, retryAfterMs = 0) {
    super(code);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

// Only static codes are logged or returned: provider URLs may contain credentials.
export function errorCode(error: unknown): string {
  return error instanceof MonitorError ? error.code : "unexpected_error";
}

export async function request(fetcher: Fetcher, url: string | URL, init: RequestInit, service: string, timeoutMs = 12_000): Promise<Response> {
  try {
    // Workers supports manual redirects; reject 3xx below without forwarding credentials.
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    if (!response.ok) {
      const retry = response.headers.get("retry-after");
      const seconds = Number(retry);
      const delay = retry ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now()) : 0;
      await response.body?.cancel();
      throw new MonitorError(`${service}_http_${response.status}`, Math.max(0, delay || 0));
    }
    return response;
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    throw new MonitorError(`${service}_network_error`);
  }
}

export async function readText(response: Response, service: string, maxBytes = 1_000_000): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new MonitorError(`${service}_empty_body`);
  const decoder = new TextDecoder();
  let length = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new MonitorError(`${service}_body_too_large`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    throw new MonitorError(`${service}_body_read_error`);
  }
}

export function requireHttps(value: string | undefined, name: string): URL {
  try {
    const url = new URL(value ?? "");
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    return url;
  } catch {
    throw new MonitorError(`invalid_${name}`);
  }
}
