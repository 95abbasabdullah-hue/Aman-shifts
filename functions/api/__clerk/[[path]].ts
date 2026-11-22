interface ClerkProxyEnvironment {
  RENDER_API_ORIGIN: string;
}

interface ClerkProxyContext {
  request: Request;
  env: ClerkProxyEnvironment;
}

const CLERK_PROXY_PATH = "/api/__clerk";

export async function onRequest({
  request,
  env,
}: ClerkProxyContext): Promise<Response> {
  let renderOrigin: URL;
  try {
    renderOrigin = new URL(env.RENDER_API_ORIGIN);
  } catch {
    return new Response("Clerk proxy is not configured", { status: 503 });
  }

  if (
    renderOrigin.protocol !== "https:" ||
    renderOrigin.username ||
    renderOrigin.password ||
    renderOrigin.pathname !== "/" ||
    renderOrigin.search ||
    renderOrigin.hash
  ) {
    return new Response("Clerk proxy configuration is invalid", {
      status: 500,
    });
  }

  const incomingUrl = new URL(request.url);
  if (
    incomingUrl.pathname !== CLERK_PROXY_PATH &&
    !incomingUrl.pathname.startsWith(`${CLERK_PROXY_PATH}/`)
  ) {
    return new Response("Not found", { status: 404 });
  }

  const upstreamUrl = new URL(
    `${incomingUrl.pathname}${incomingUrl.search}`,
    renderOrigin,
  );
  const headers = new Headers(request.headers);

  // The Clerk proxy endpoint must be on the same public domain as the app.
  // Preserve that host while forwarding the request to the Render API.
  headers.set("x-forwarded-host", incomingUrl.host);
  headers.set("x-forwarded-proto", incomingUrl.protocol.slice(0, -1));

  // Do not trust a client-supplied forwarding chain for the original IP.
  headers.delete("x-forwarded-for");
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) headers.set("x-forwarded-for", clientIp);

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  try {
    const upstream = await fetch(upstreamUrl, init);
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("Cache-Control", "no-store, private");
    const isBodyless =
      request.method === "HEAD" ||
      upstream.status === 204 ||
      upstream.status === 304 ||
      (upstream.status >= 100 && upstream.status < 200);

    return new Response(isBodyless ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return new Response("Clerk proxy upstream is unavailable", {
      status: 502,
      headers: { "Cache-Control": "no-store, private" },
    });
  }
}
