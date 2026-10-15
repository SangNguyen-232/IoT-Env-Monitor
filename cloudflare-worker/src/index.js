export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);

    const targetUrl = new URL(
      incomingUrl.pathname + incomingUrl.search,
      "http://backend:3000"
    );

    const headers = new Headers(request.headers);

    headers.set("X-Forwarded-Proto", "https");
    headers.set("X-Forwarded-Host", incomingUrl.host);
    headers.delete("X-Forwarded-For");

    try {
      const proxyRequest = new Request(targetUrl, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method)
          ? undefined
          : request.body,
        redirect: "manual"
      });

      return await env.IOT_BACKEND.fetch(proxyRequest);
    } catch (error) {
      console.error("VPC Service error:", error);

      return new Response("IoT Backend Unavailable", {
        status: 502
      });
    }
  }
};