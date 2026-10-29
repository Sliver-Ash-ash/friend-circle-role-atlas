(() => {
  "use strict";

  const config = window.FRIEND_CIRCLE_CONFIG || {};
  const isCloud =
    config.backend === "supabase" &&
    Boolean(config.supabaseUrl) &&
    Boolean(config.supabaseAnonKey);
  const functionName = config.functionName || "app-api";

  function getSiteUrl() {
    return new URL(".", window.location.href).toString();
  }

  async function request(pathname, options = {}) {
    if (!isCloud) {
      return requestLocal(pathname, options);
    }
    return requestCloud(pathname, options);
  }

  async function requestLocal(pathname, options) {
    const headers = {
      Accept: "application/json",
      ...(options.headers || {}),
    };
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    let body;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const response = await fetch(pathname, {
      method: options.method || "GET",
      headers,
      body,
      cache: "no-store",
      keepalive: Boolean(options.keepalive),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  }

  async function requestCloud(pathname, options) {
    const endpoint = `${config.supabaseUrl.replace(/\/+$/, "")}/functions/v1/${encodeURIComponent(functionName)}`;
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      ...(options.token ? { "x-app-token": options.token } : {}),
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        path: pathname,
        method: options.method || "GET",
        body: options.body,
        siteUrl: getSiteUrl(),
      }),
      cache: "no-store",
      keepalive: Boolean(options.keepalive),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  }

  window.FriendCircleBackend = {
    isCloud,
    request,
    siteUrl: getSiteUrl(),
  };
})();
