/**
 * Cloudflare Worker edge gateway (`*.workers.dev`) for IoT-Env-Monitor.
 * Published via Wrangler from the Linux Ubuntu virtual machine. Forwards public HTTPS
 * requests (`/sensor`, `/healthz`, `/login`, `/logout`, `/api/me`, `/admin/*`) through
 * Workers VPC binding `env.IOT_BACKEND` (`iot-env-backend` -> `http://backend:3000`)
 * over Cloudflare Tunnel `iot-env-monitor-sys` (`1 VPC` route) into `iot_backend`
 * inside the Ubuntu VM Docker network (`iot_net`). Device port-80 dashboards and
 * PostgreSQL (`127.0.0.1:5433`) are never routed through this gateway.
 */
export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);

    const targetUrl = new URL("http://backend:3000");
    targetUrl.pathname = incomingUrl.pathname;
    targetUrl.search = incomingUrl.search;

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
