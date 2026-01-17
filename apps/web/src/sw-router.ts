// Simple Service Worker Router

type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface RouteRequest {
  _request: Request;
  params: Record<string, string>;
  url: string;
}

export interface RouteResponse {
  send: (response: Response) => Response;
  json: (data: unknown, options?: { status?: number }) => Response;
  fetch: (input: Request | string) => Promise<Response>;
}

type RouteHandler = (
  req: RouteRequest,
  res: RouteResponse
) => Response | Promise<Response>;

interface Route {
  method: Method;
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];

  private compilePattern(pattern: string): {
    regex: RegExp;
    paramNames: string[];
  } {
    const paramNames: string[] = [];

    // Handle catch-all wildcard
    if (pattern === "*") {
      return { regex: /^.*$/, paramNames: [] };
    }

    let regexStr = "^";
    const segments = pattern.split("/").filter(Boolean);

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      regexStr += "/";

      if (segment.startsWith("{") && segment.endsWith("}")) {
        // Parameter segment
        let paramName = segment.slice(1, -1);

        if (paramName.endsWith("+")) {
          // Rest parameter (matches multiple segments)
          paramName = paramName.slice(0, -1);
          paramNames.push(paramName);
          regexStr += "(.+)";
        } else {
          // Single segment parameter
          paramNames.push(paramName);
          regexStr += "([^/]+)";
        }
      } else {
        // Literal segment
        regexStr += segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
    }

    regexStr += "/?$";
    return { regex: new RegExp(regexStr), paramNames };
  }

  private addRoute(method: Method, pattern: string, handler: RouteHandler) {
    const { regex, paramNames } = this.compilePattern(pattern);
    this.routes.push({ method, pattern, regex, paramNames, handler });
  }

  get(pattern: string, handler: RouteHandler) {
    this.addRoute("GET", pattern, handler);
  }

  post(pattern: string, handler: RouteHandler) {
    this.addRoute("POST", pattern, handler);
  }

  put(pattern: string, handler: RouteHandler) {
    this.addRoute("PUT", pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler) {
    this.addRoute("DELETE", pattern, handler);
  }

  async handleRequest(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method as Method;

    for (const route of this.routes) {
      if (route.method !== method) continue;

      const match = pathname.match(route.regex);
      if (!match) continue;

      // Extract params
      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]] = match[i + 1];
      }

      const req: RouteRequest = {
        _request: request,
        params,
        url: request.url,
      };

      const res: RouteResponse = {
        send: (response: Response) => response,
        json: (data: unknown, options?: { status?: number }) => {
          return new Response(JSON.stringify(data), {
            status: options?.status ?? 200,
            headers: { "Content-Type": "application/json" },
          });
        },
        fetch: (input: Request | string) => fetch(input),
      };

      return route.handler(req, res);
    }

    return null;
  }
}
