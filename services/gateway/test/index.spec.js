
import { env } from "cloudflare:workers";
import {
  SELF,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";

import worker from "../src/index.js";

/**
 * IoT-Env-Monitor — Cloudflare Worker Tests
 *
 * Architecture:
 * Client -> Cloudflare Worker -> IOT_BACKEND -> Node.js Backend
 *
 * Expected behavior:
 * Unauthenticated requests to "/" are redirected to "/login".
 */

const BASE_URL = "http://example.com";

/**
 * Verify that a response redirects to the login page.
 *
 * Supports both relative and absolute Location headers.
 */
function expectLoginRedirect(response) {
  expect(response.status).toBe(302);

  const location = response.headers.get("location");

  expect(location).not.toBeNull();

  const redirectUrl = new URL(location, BASE_URL);

  expect(redirectUrl.pathname).toBe("/login");
}

describe("IoT-Env-Monitor Cloudflare Worker", () => {
  /**
   * Unit-style test:
   * Invoke the Worker's fetch handler directly.
   */
  it("redirects unauthenticated requests (unit style)", async () => {
    const request = new Request(`${BASE_URL}/`, {
      method: "GET",
      redirect: "manual",
    });

    const ctx = createExecutionContext();

    const response = await worker.fetch(request, env, ctx);

    await waitOnExecutionContext(ctx);

    expectLoginRedirect(response);
  });

  /**
   * Integration-style test:
   * Send a request through the Worker runtime.
   *
   * redirect: "manual" prevents fetch from automatically
   * following the redirect to /login.
   */
  it("redirects unauthenticated requests (integration style)", async () => {
    const response = await SELF.fetch(`${BASE_URL}/`, {
      method: "GET",
      redirect: "manual",
    });

    expectLoginRedirect(response);
  });
});

it("preserves method, query and body through the runtime binding", async () => {
  const response = await SELF.fetch(`${BASE_URL}/sensor?device=uno`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "spoofed" },
    body: '{"temperature":24}',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    url: "http://backend:3000/sensor?device=uno",
    method: "POST",
    proto: "https",
    host: "example.com",
    forwardedFor: null,
    body: '{"temperature":24}',
  });
});

it("returns 502 when the backend binding fails", async () => {
  const response = await worker.fetch(new Request(`${BASE_URL}/`), {
    IOT_BACKEND: { fetch() { throw new Error("test backend unavailable"); } },
  });
  expect(response.status).toBe(502);
  expect(await response.text()).toBe("IoT Backend Unavailable");
});

it("preserves backend cookies and redirect without following it", async () => {
  const response = await worker.fetch(new Request(`${BASE_URL}/`), {
    IOT_BACKEND: { async fetch(request) {
      expect(request.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: {
        location: "/login", "set-cookie": "session=test; HttpOnly; Secure",
      } });
    } },
  });
  expectLoginRedirect(response);
  expect(response.headers.get("set-cookie")).toBe("session=test; HttpOnly; Secure");
});

it("keeps the backend origin for paths beginning with two slashes", async () => {
  const response = await worker.fetch(new Request(`${BASE_URL}//other-host.example/sensor?x=1`), {
    IOT_BACKEND: { async fetch(request) {
      expect(new URL(request.url).origin).toBe("http://backend:3000");
      expect(new URL(request.url).pathname).toBe("//other-host.example/sensor");
      return new Response("ok");
    } },
  });
  expect(response.status).toBe(200);
});
