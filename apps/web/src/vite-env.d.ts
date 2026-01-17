/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare module "@jcubic/wayne" {
  export interface WayneRequest {
    url: string;
    method: string;
    headers: Headers;
    params: Record<string, string>;
    _request: Request;
  }

  export interface WayneResponse {
    send(response: Response): void;
    json(data: unknown, options?: { status?: number; statusText?: string }): void;
    text(content: string, options?: { status?: number; statusText?: string }): void;
    redirect(code: number, url: string): void;
    fetch(request: Request): Promise<Response>;
  }

  export type WayneHandler = (
    req: WayneRequest,
    res: WayneResponse
  ) => void | Promise<void> | Promise<Response | void>;

  export class Wayne {
    constructor();
    get(path: string, handler: WayneHandler): void;
    post(path: string, handler: WayneHandler): void;
    put(path: string, handler: WayneHandler): void;
    delete(path: string, handler: WayneHandler): void;
    use(middleware: WayneHandler): void;
  }
}
