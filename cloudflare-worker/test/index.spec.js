
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
